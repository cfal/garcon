import { expect, test } from 'bun:test';
import { homedir } from 'node:os';
import { AgentRpc } from '../rpc.ts';
import { SessionTransport } from '../session-transport.ts';
import { TerminalWorker } from '../terminal-worker.ts';
import { TerminalRuntime } from '../../terminals/node-service.ts';
import { RemoteExecutionTerminalService } from '../remote-terminals.ts';

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
  const transport = new SessionTransport('session', 'runtime', error => failures.push(error), { maxRetainedFrames: 4 });
  const socket = transport.attach({ send() {}, close() {} }, 0);
  socket.receive(JSON.stringify({ kind: 'receipt', through: 0 }));
  const worker = new TerminalWorker(service, new AgentRpc(transport));
  try {
    const inventory = await service.list(authority);
    const { terminal } = await service.create(authority, {
      expectedTerminalRuntimeId: inventory.terminalRuntimeId, requestId: 'create', requestedInitialWorkingDirectory: null,
    });
    await worker.handle({ method: 'terminals.attach', request: {
      authority, attachmentId: 'attachment', attachmentEpoch: inventory.attachmentEpoch,
      type: 'terminal-attach', terminalId: terminal.terminalId, clientId: 'browser', intent: 'restore', afterSequence: 0,
    } });
    while (transport.channel.retainedFrames < 4) transport.send('reliable traffic');
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
  const transport = new SessionTransport('session', 'runtime', error => failures.push(error));
  const socket = transport.attach({ send: data => frames.push(JSON.parse(data)), close() {} }, 0);
  socket.receive(JSON.stringify({ kind: 'receipt', through: 0 }));
  const rpc = new AgentRpc(transport);
  let outputPeer;
  let detached = false;
  const worker = new TerminalWorker({
    async attach(_authority, peer) { outputPeer = peer; },
    detachPeer() { detached = true; },
  }, rpc);
  try {
    await worker.handle({ method: 'terminals.attach', request: {
      authority, attachmentId: 'attachment', type: 'terminal-attach', terminalId: 'terminal',
      clientId: 'client', intent: 'restore', afterSequence: 0,
    } });
    const unrelated = rpc.call('', 'projects.inspect', { projectPath: homedir() }).catch(error => error);
    for (let sequence = 1; sequence <= 300; sequence++) {
      outputPeer.sendTerminalMessage({ type: 'terminal-output', terminalId: 'terminal', sequence, data: 'x' });
    }
    expect(detached).toBe(true);
    expect(failures).toEqual([]);
    expect(transport.connected).toBe(true);
    const messages = frames.filter(frame => frame.kind === 'message').map(frame => JSON.parse(frame.body));
    expect(messages.at(-1)).toMatchObject({ type: 'terminal', message: { code: 'terminal-backpressure' } });
    expect(messages.filter(frame => frame.type === 'terminal').length).toBe(256);
    const request = messages.find(frame => frame.type === 'request');
    socket.receive(JSON.stringify({ kind: 'message', ordinal: 1, body: JSON.stringify({ type: 'result', id: request.id, value: 'still available' }) }));
    expect(await unrelated).toBe('still available');
  } finally { worker.disconnect(); transport.close(); }
});

for (const closeBeforeReply of [false, true]) test(`attachment cleanup bypasses RPC saturation (pending attach: ${closeBeforeReply})`, async () => {
  const runtime = new TerminalRuntime({ projectBasePath: homedir(), spawnPty: () => ({ onData() {}, onExit() {}, kill() {}, write() {}, resize() {} }) });
  const local = runtime.service('local');
  const inventory = await local.list(authority);
  const { terminal } = await local.create(authority, { expectedTerminalRuntimeId: inventory.terminalRuntimeId, requestId: 'create', requestedInitialWorkingDirectory: null });
  const controller = new SessionTransport('session', 'worker', () => {});
  const node = new SessionTransport('session', 'controller', () => {});
  let controllerSocket, nodeSocket;
  controllerSocket = controller.attach({ send(data) { queueMicrotask(() => nodeSocket.receive(data)); }, close() {} }, 0);
  nodeSocket = node.attach({ send(data) { queueMicrotask(() => controllerSocket.receive(data)); }, close() {} }, 0);
  await Promise.all([controller.ready, node.ready]);
  const controllerRpc = new AgentRpc(controller), workerRpc = new AgentRpc(node);
  const worker = new TerminalWorker(local, workerRpc);
  workerRpc.handle(async call => {
    await node.ready;
    return call.method.startsWith('terminals.') ? worker.handle(call) : new Promise(() => {});
  });
  workerRpc.onTerminalDetach(async request => { await node.ready; await worker.handle({ method: 'terminals.detach', request }); });
  const remote = new RemoteExecutionTerminalService(() => ({ rpc: controllerRpc, info: { nodeId: 'local' }, manifests: new Map() }));
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
    expect(controller.connected && node.connected).toBe(true);
  } finally {
    worker.disconnect(); controller.close(); node.close();
    await Promise.all(pending); local.dispose(); runtime.shutdown();
  }
});
