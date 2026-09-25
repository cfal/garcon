import { expect, test } from 'bun:test';
import { homedir } from 'node:os';
import { ExecutionRuntime } from '../../runtime/execution-runtime.ts';
import { TerminalRuntime } from '../../runtime/terminals/runtime.ts';
import { RemoteExecutorClient } from '../client/executor-client.ts';
import { WebSocketLink } from '../transport/websocket-link.ts';
import { serveExecutionRuntime } from '../server/executor-rpc-server.ts';
import { ExecutorRpc } from '../transport/rpc.ts';

const authority = { key: 'synthetic-user', expiresAtMs: null };
function peer(id) {
  return { connectionId: id, ownedTerminalIds: new Set(), messages: [], sendTerminalMessage(message) { this.messages.push(message); } };
}
async function until(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Terminal condition timed out'); await Bun.sleep(5); }
}

for (const dialer of ['controller', 'worker']) test(`terminal RPC preserves process lifetime with ${dialer} dialing`, async () => {
  const options = { executorId: crypto.randomUUID(), secret: Buffer.alloc(32, 42).toString('base64url'), allowInsecureDevelopment: true, reconnectDelayMs: 10 };
  const ptys = [];
  const runtime = new TerminalRuntime({ projectBasePath: homedir(), spawnPty: () => {
    const pty = { killed: false, writes: [], resizes: [], onData(fn) { this.data = fn; }, onExit(fn) { this.exit = fn; },
      write(data) { this.writes.push(data); }, resize(cols, rows) { this.resizes.push([cols, rows]); }, kill() { this.killed = true; } };
    ptys.push(pty); return pty;
  } });
  const worker = new WebSocketLink({ ...options, role: 'worker' });
  const controller = new WebSocketLink({ ...options, role: 'controller' });
  const scopes = [];
  worker.onSession(transport => scopes.push(serveExecutionRuntime(new ExecutionRuntime({
    id: options.executorId, workspaceDir: homedir(), projectBasePath: homedir(), integrations: [], terminalRuntime: runtime, resolveCredential: async () => null,
  }), new ExecutorRpc(transport))));
  const connected = RemoteExecutorClient.connect(controller);
  if (dialer === 'controller') controller.dial(worker.listen()); else worker.dial(controller.listen());
  try {
    const executor = await connected;
    const service = await executor.getTerminalService();
    const inventory = await service.list(authority);
    const request = { executorId: options.executorId, expectedTerminalRuntimeId: inventory.terminalRuntimeId, requestId: 'create', requestedInitialWorkingDirectory: null };
    const { terminal } = await service.create(authority, request);
    expect((await service.create(authority, request)).terminal.terminalId).toBe(terminal.terminalId);
    expect((await service.list({ ...authority, key: 'other' })).terminals).toEqual([]);
    const first = peer('first');
    await service.attach(authority, first, { type: 'terminal-attach', terminalId: terminal.terminalId, clientId: 'first', afterSequence: 0, intent: 'restore', attachmentEpoch: inventory.attachmentEpoch });
    await service.input(authority, first, terminal.terminalId, 'command\r');
    await service.resize(authority, first, terminal.terminalId, 120, 40);
    expect(ptys[0].writes).toEqual(['command\r']);
    expect(ptys[0].resizes).toEqual([[120, 40]]);
    ptys[0].data('hello');
    await until(() => first.messages.some(message => message.type === 'terminal-output'));
    const takeover = peer('takeover');
    await expect(service.attach(authority, takeover, { type: 'terminal-attach', terminalId: terminal.terminalId, clientId: 'second', afterSequence: 0, intent: 'restore', attachmentEpoch: inventory.attachmentEpoch })).rejects.toMatchObject({ code: 'terminal-takeover-required' });
    service.detachPeer(authority, takeover);
    await service.attach(authority, takeover, { type: 'terminal-attach', terminalId: terminal.terminalId, clientId: 'second', afterSequence: 0, intent: 'takeover', attachmentEpoch: inventory.attachmentEpoch });
    await expect(service.input(authority, first, terminal.terminalId, 'stale')).rejects.toMatchObject({ code: 'terminal-not-attached' });
    const before = await executor.getInfo();
    controller.current.close(new Error('Replace logical session'));
    await until(() => executor.availability === 'ready' && scopes.length === 2);
    const nextInventory = await service.list(authority);
    expect((await executor.getInfo()).instanceId).not.toBe(before.instanceId);
    expect(nextInventory.terminalRuntimeId).toBe(inventory.terminalRuntimeId);
    expect(nextInventory.attachmentEpoch).not.toBe(inventory.attachmentEpoch);
    expect(nextInventory.terminals[0].terminalId).toBe(terminal.terminalId);
    expect(ptys[0].killed).toBe(false);
    expect((await service.create(authority, request)).terminal.terminalId).toBe(terminal.terminalId);
    const restored = peer('restored');
    await expect(service.attach(authority, restored, { type: 'terminal-attach', terminalId: terminal.terminalId, clientId: 'second', afterSequence: 0, intent: 'restore', attachmentEpoch: inventory.attachmentEpoch })).rejects.toMatchObject({ code: 'terminal-not-attached' });
    await service.attach(authority, restored, { type: 'terminal-attach', terminalId: terminal.terminalId, clientId: 'second', afterSequence: 0, intent: 'restore', attachmentEpoch: nextInventory.attachmentEpoch });
    expect(restored.messages.find(message => message.type === 'terminal-attached').replay).toEqual([{ sequence: 1, data: 'hello' }]);
    await service.terminate(authority, terminal.terminalId, 'terminate');
    expect(ptys[0].killed).toBe(true);
    expect((await service.list(authority)).terminals).toEqual([]);
  } finally {
    await controller.dispose(); await worker.dispose();
    for (const scope of scopes) await scope.dispose();
    runtime.shutdown();
  }
}, 15000);
