import { expect, test } from 'bun:test';
import { homedir } from 'node:os';
import { ExecutorRpc } from '../transport/rpc.ts';
import { SessionTransport } from '../transport/session-transport.ts';
import { TerminalRpcServer } from '../server/terminal-rpc-server.ts';
import { TerminalRuntime } from '../../runtime/terminals/runtime.ts';
import { RemoteTerminalService } from '../client/remote-terminals.ts';

const authority = { key: 'synthetic-user', expiresAtMs: null };
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test('reliable saturation cannot escape PTY delivery or stop retained output and exit tracking', async () => {
  let onData;
  let onExit;
  const runtime = new TerminalRuntime({ projectBasePath: homedir(), spawnPty: () => ({
    onData(callback) { onData = callback; }, onExit(callback) { onExit = callback; },
    kill() {}, write() {}, resize() {},
  }) });
  const service = runtime.service('local');
  const failures = [];
  let writable = true;
  const transport = new SessionTransport('session', 'runtime', error => failures.push(error), { maxQueuedFrames: 4 });
  transport.attach({ send() {}, close() {}, canSend: () => writable });
  const worker = new TerminalRpcServer(service, new ExecutorRpc(transport));
  try {
    const inventory = await service.list(authority);
    const { terminal } = await service.create(authority, {
      expectedTerminalRuntimeId: inventory.terminalRuntimeId, requestId: 'create', requestedInitialWorkingDirectory: null,
    });
    await worker.handle({ method: 'terminals.attach', request: {
      authority, attachmentId: 'attachment', attachmentEpoch: inventory.attachmentEpoch,
      type: 'terminal-attach', terminalId: terminal.terminalId, clientId: 'browser', intent: 'restore', afterSequence: 0,
    } });
    writable = false;
    while (transport.channel.queuedFrames < 4) transport.send('reliable traffic');
    expect(() => onData('pressure\n')).not.toThrow();
    expect(failures).toHaveLength(1);
    expect(transport.connected).toBe(false);
    expect((await service.list(authority)).terminals[0].attachmentStatus).toBe('detached');

    onData('after detachment\n');
    onExit({ exitCode: 7 });
    expect((await service.list(authority)).terminals[0]).toMatchObject({ processStatus: 'exited', exitCode: 7, latestOutputSequence: 2 });
    const messages = [];
    await service.attach(authority, {
      connectionId: 'replacement', ownedTerminalIds: new Set(), sendTerminalMessage: message => messages.push(message),
    }, {
      type: 'terminal-attach', terminalId: terminal.terminalId, attachmentEpoch: inventory.attachmentEpoch,
      clientId: 'browser', intent: 'restore', afterSequence: 0,
    });
    expect(messages.find(message => message.type === 'terminal-attached').replay.map(chunk => chunk.data).join(''))
      .toBe('pressure\nafter detachment\n');
  } finally { worker.disconnect(); transport.close(); service.dispose(); runtime.shutdown(); }
});

test('terminal output pressure reserves reliable control capacity for unrelated calls', async () => {
  const frames = [];
  const failures = [];
  let writable = true;
  const control = Promise.withResolvers();
  const transport = new SessionTransport('session', 'runtime', error => failures.push(error));
  const socket = transport.attach({
    send(data) { const frame = JSON.parse(data); frames.push(frame); if (frame.type === 'terminal') control.resolve(); },
    close() {}, canSend: () => writable,
  });
  const rpc = new ExecutorRpc(transport);
  let outputPeer;
  let detached = false;
  const worker = new TerminalRpcServer({
    async attach(_authority, peer) { outputPeer = peer; },
    detachPeer() { detached = true; },
  }, rpc);
  try {
    await worker.handle({ method: 'terminals.attach', request: {
      authority, attachmentId: 'attachment', type: 'terminal-attach', terminalId: 'terminal',
      clientId: 'client', intent: 'restore', afterSequence: 0,
    } });
    const unrelated = rpc.call('', 'projects.inspect', { projectPath: homedir() }).catch(error => error);
    writable = false;
    outputPeer.sendTerminalMessage({ type: 'terminal-output', terminalId: 'terminal', sequence: 1, data: 'x' });
    expect(detached).toBe(true);
    expect(failures).toEqual([]);
    expect(transport.connected).toBe(true);
    writable = true;
    await control.promise;
    expect(frames.at(-1)).toMatchObject({ type: 'terminal', message: { code: 'terminal-backpressure' } });
    const request = frames.find(frame => frame.type === 'request');
    socket.receive(JSON.stringify({ type: 'result', id: request.id, value: 'still available' }));
    expect(await unrelated).toBe('still available');
  } finally { worker.disconnect(); transport.close(); }
});

for (const closeBeforeReply of [false, true]) test(`attachment cleanup bypasses RPC saturation (pending attach: ${closeBeforeReply})`, async () => {
  const runtime = new TerminalRuntime({ projectBasePath: homedir(), spawnPty: () => ({ onData() {}, onExit() {}, kill() {}, write() {}, resize() {} }) });
  const local = runtime.service('local');
  const inventory = await local.list(authority);
  const { terminal } = await local.create(authority, { expectedTerminalRuntimeId: inventory.terminalRuntimeId, requestId: 'create', requestedInitialWorkingDirectory: null });
  const controller = new SessionTransport('session', 'worker', () => {});
  const executor = new SessionTransport('session', 'controller', () => {});
  let controllerSocket, executorSocket;
  controllerSocket = controller.attach({ send(data) { queueMicrotask(() => executorSocket.receive(data)); }, close() {} });
  executorSocket = executor.attach({ send(data) { queueMicrotask(() => controllerSocket.receive(data)); }, close() {} });
  await Promise.all([controller.ready, executor.ready]);
  const controllerRpc = new ExecutorRpc(controller), workerRpc = new ExecutorRpc(executor);
  const worker = new TerminalRpcServer(local, workerRpc);
  workerRpc.handle(async call => {
    await executor.ready;
    return call.method.startsWith('terminals.') ? worker.handle(call) : new Promise(() => {});
  });
  workerRpc.onTerminalDetach(async request => { await executor.ready; await worker.handle({ method: 'terminals.detach', request }); });
  const remote = new RemoteTerminalService(() => ({ rpc: controllerRpc, info: { executorId: 'local' }, manifests: new Map() }));
  controllerRpc.onTerminal(frame => remote.receive(frame, controllerRpc));
  const peer = { connectionId: 'browser', ownedTerminalIds: new Set(), sendTerminalMessage() {} };
  const pending = [];
  try {
    const attach = remote.attach(authority, peer, { type: 'terminal-attach', terminalId: terminal.terminalId,
      attachmentEpoch: inventory.attachmentEpoch, clientId: 'browser', intent: 'restore', afterSequence: 0 });
    if (!closeBeforeReply) await attach;
    for (let i = 0; i < (closeBeforeReply ? 255 : 256); i++) pending.push(controllerRpc.call('', 'projects.inspect', { projectPath: homedir() }).catch(error => error));
    remote.detachPeer(authority, peer);
    await attach;
    await tick();
    expect((await local.list(authority)).terminals[0].attachmentStatus).toBe('detached');
    expect(peer.ownedTerminalIds.size).toBe(0);
    expect(controller.connected && executor.connected).toBe(true);
  } finally {
    worker.disconnect(); controller.close(); executor.close();
    await Promise.all(pending); local.dispose(); runtime.shutdown();
  }
});
