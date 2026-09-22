import { afterEach, describe, expect, it } from 'bun:test';
import { TerminalRuntime } from '../node-service.ts';
import { parseTerminalReference } from '../../../common/terminal-identity.ts';
import { parseTerminalCreateRequest, parseTerminalStreamClientMessage, parseTerminalStreamServerMessage } from '../../../common/terminal.ts';
import { homedir } from 'node:os';

const authority = { key: 'synthetic-user', expiresAtMs: null };
const runtimes = [];
afterEach(() => { for (const runtime of runtimes.splice(0)) runtime.shutdown(); });

function setup() {
  const ptys = [];
  const runtime = new TerminalRuntime({ projectBasePath: homedir(), spawnPty: (_shell, _args, options) => {
    const pty = { options, killed: false, writes: [], data: () => {}, exit: () => {},
      onData(fn) { this.data = fn; }, onExit(fn) { this.exit = fn; },
      write(data) { this.writes.push(data); }, resize() {}, kill() { this.killed = true; } };
    ptys.push(pty); return pty;
  } });
  runtimes.push(runtime);
  return { runtime, ptys };
}

function peer(id) {
  return { connectionId: id, ownedTerminalIds: new Set(), messages: [], sendTerminalMessage(message) { this.messages.push(message); } };
}

async function create(service, requestId = 'create') {
  const { terminalRuntimeId } = await service.list(authority);
  return service.create(authority, { requestId, expectedTerminalRuntimeId: terminalRuntimeId, requestedInitialWorkingDirectory: null });
}

describe('process-owned terminals', () => {
  it('keeps the PTY, replay, counters and create result across facade retirement', async () => {
    const { runtime, ptys } = setup();
    const nodeId = crypto.randomUUID();
    const first = runtime.service(nodeId);
    const created = await create(first);
    const id = created.terminal.terminalId;
    expect(parseTerminalReference(id)).toMatchObject({ nodeId, terminalRuntimeId: runtime.id });
    const old = peer('old');
    await first.attach(authority, old, { type: 'terminal-attach', terminalId: id, clientId: 'browser', afterSequence: 0, intent: 'restore' });
    first.dispose();
    ptys[0].data('still running');
    expect(ptys[0].killed).toBe(false);
    const replacement = runtime.service(nodeId);
    expect((await create(replacement)).terminal.terminalId).toBe(id);
    expect(ptys).toHaveLength(1);
    const next = peer('next');
    await replacement.attach(authority, next, { type: 'terminal-attach', terminalId: id, clientId: 'browser', afterSequence: 0, intent: 'restore' });
    expect(next.messages[0].replay).toEqual([{ sequence: 1, data: 'still running' }]);
    await expect(first.input(authority, old, id, 'stale')).rejects.toMatchObject({ code: 'terminal-unavailable' });
    expect((await create(replacement, 'second')).terminal.displaySequence).toBe(2);
    runtime.shutdown();
    expect(ptys.every(pty => pty.killed)).toBe(true);
  });

  it('isolates nodes and principals and rejects stale runtimes and retargeted retries', async () => {
    const { runtime } = setup();
    const service = runtime.service('local');
    const created = await create(service);
    expect((await service.list({ ...authority, key: 'different' })).terminals).toEqual([]);
    const other = runtime.service(crypto.randomUUID());
    expect((await other.list(authority)).terminals).toEqual([]);
    await expect(other.terminate(authority, created.terminal.terminalId, 'delete')).rejects.toMatchObject({ code: 'terminal-validation' });
    await expect(service.create(authority, { requestId: 'create', expectedTerminalRuntimeId: runtime.id, requestedInitialWorkingDirectory: '/different' })).rejects.toMatchObject({ code: 'terminal-validation' });
    await expect(service.create(authority, { requestId: 'fresh', expectedTerminalRuntimeId: crypto.randomUUID(), requestedInitialWorkingDirectory: null })).rejects.toMatchObject({ code: 'terminal-runtime-changed' });
  });

  it('keeps queued input bounded and fences expired or detached authority', async () => {
    const { runtime, ptys } = setup();
    const service = runtime.service('local');
    const { terminal } = await create(service);
    const source = peer('browser');
    await service.attach(authority, source, { type: 'terminal-attach', terminalId: terminal.terminalId, clientId: 'browser', afterSequence: 0, intent: 'restore' });
    await expect(service.input(authority, source, terminal.terminalId, 'x'.repeat(65537))).rejects.toMatchObject({ code: 'terminal-validation' });
    service.disconnect();
    await expect(service.input(authority, source, terminal.terminalId, 'stale')).rejects.toMatchObject({ code: 'terminal-not-attached' });
    await expect(service.list({ ...authority, expiresAtMs: 1 })).rejects.toMatchObject({ code: 'terminal-auth-expired' });
    expect(ptys[0].writes).toEqual([]);
    expect(ptys[0].killed).toBe(false);
  });

  it('round trips node creation and attachment identity', () => {
    const request = { requestId: 'request', nodeId: 'local', expectedTerminalRuntimeId: crypto.randomUUID(), requestedInitialWorkingDirectory: null };
    expect(parseTerminalCreateRequest(request)).toEqual(request);
    expect(parseTerminalCreateRequest({ ...request, nodeId: 'invalid' })).toBeNull();
    const detach = { type: 'terminal-detach', terminalId: 'terminal', attachmentId: 'attachment' };
    expect(parseTerminalStreamClientMessage(detach)).toEqual(detach);
    const output = { type: 'terminal-output', terminalId: 'terminal', attachmentId: 'attachment', sequence: 1, data: 'text' };
    expect(parseTerminalStreamServerMessage(output)).toEqual(output);
  });
});
