import { afterEach, describe, expect, it } from 'bun:test';
import { TerminalRuntime } from '../runtime.ts';
import { parseTerminalReference } from '../../../../common/terminal-identity.ts';
import { parseTerminalCreateRequest, parseTerminalStreamClientMessage, parseTerminalStreamServerMessage } from '../../../../common/terminal.ts';
import { homedir } from 'node:os';
import { ExecutionRuntime } from '../../execution-runtime.ts';
import { runtimeAdapter, RUNTIME_BACKENDS } from '../../../remote/__tests__/runtime-adapter.ts';

const authority = { key: 'synthetic-user', expiresAtMs: null };
const runtimes = [];
const adapters = [];
afterEach(async () => {
  for (const adapter of adapters.splice(0)) await adapter.dispose();
  for (const runtime of runtimes.splice(0)) runtime.shutdown();
});

async function serviceFor(runtime, executorId, backend) {
  const execution = new ExecutionRuntime({ id: executorId, workspaceDir: homedir(), projectBasePath: homedir(), integrations: [], terminalRuntime: runtime, resolveCredential: async () => null });
  const adapter = await runtimeAdapter(execution, backend);
  adapters.push({ dispose: async () => { await adapter.dispose(); await execution.dispose(); } });
  return adapter.executor.getTerminalService();
}

function setup() {
  const ptys = [];
  const runtime = new TerminalRuntime({ projectBasePath: homedir(), spawnPty: (_shell, _args, options) => {
    const pty = { options, killed: false, writes: [], operations: [], onOperation: () => {}, data: () => {}, exit: () => {},
      onData(fn) { this.data = fn; }, onExit(fn) { this.exit = fn; },
      write(data) { this.writes.push(data); this.operations.push(data); this.onOperation(); },
      resize(cols, rows) { this.operations.push([cols, rows]); this.onOperation(); }, kill() { this.killed = true; } };
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
    const executorId = crypto.randomUUID();
    const first = runtime.service(executorId);
    const created = await create(first);
    const id = created.terminal.terminalId;
    expect(parseTerminalReference(id)).toMatchObject({ executorId, terminalRuntimeId: runtime.id });
    const old = peer('old');
    await first.attach(authority, old, { type: 'terminal-attach', terminalId: id, clientId: 'browser', afterSequence: 0, intent: 'restore', attachmentEpoch: (await first.list(authority)).attachmentEpoch });
    first.dispose();
    ptys[0].data('still running');
    expect(ptys[0].killed).toBe(false);
    const replacement = runtime.service(executorId);
    expect((await create(replacement)).terminal.terminalId).toBe(id);
    expect(ptys).toHaveLength(1);
    const next = peer('next');
    await replacement.attach(authority, next, { type: 'terminal-attach', terminalId: id, clientId: 'browser', afterSequence: 0, intent: 'restore', attachmentEpoch: (await replacement.list(authority)).attachmentEpoch });
    expect(next.messages[0].replay).toEqual([{ sequence: 1, data: 'still running' }]);
    await expect(first.input(authority, old, id, 'stale')).rejects.toMatchObject({ code: 'terminal-unavailable' });
    expect((await create(replacement, 'second')).terminal.displaySequence).toBe(2);
    runtime.shutdown();
    expect(ptys.every(pty => pty.killed)).toBe(true);
  });

  for (const backend of RUNTIME_BACKENDS) it(`isolates executors and principals and rejects stale runtimes and retargeted retries (${backend})`, async () => {
    const { runtime } = setup();
    const service = await serviceFor(runtime, 'local', backend);
    const created = await create(service);
    expect((await service.list({ ...authority, key: 'different' })).terminals).toEqual([]);
    const other = await serviceFor(runtime, crypto.randomUUID(), backend);
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
    await service.attach(authority, source, { type: 'terminal-attach', terminalId: terminal.terminalId, clientId: 'browser', afterSequence: 0, intent: 'restore', attachmentEpoch: (await service.list(authority)).attachmentEpoch });
    await expect(service.input(authority, source, terminal.terminalId, 'x'.repeat(65537))).rejects.toMatchObject({ code: 'terminal-validation' });
    service.disconnect();
    await expect(service.input(authority, source, terminal.terminalId, 'stale')).rejects.toMatchObject({ code: 'terminal-not-attached' });
    await expect(service.list({ ...authority, expiresAtMs: 1 })).rejects.toMatchObject({ code: 'terminal-auth-expired' });
    expect(ptys[0].writes).toEqual([]);
    expect(ptys[0].killed).toBe(false);
  });

  for (const backend of RUNTIME_BACKENDS) it(`binds failed create results to the original directory (${backend})`, async () => {
    const { runtime, ptys } = setup();
    const service = await serviceFor(runtime, 'local', backend);
    const request = { requestId: 'invalid', expectedTerminalRuntimeId: runtime.id, requestedInitialWorkingDirectory: '/synthetic-missing-directory' };
    await expect(service.create(authority, request)).rejects.toMatchObject({ code: 'terminal-validation', status: 422 });
    await expect(service.create(authority, { ...request, requestedInitialWorkingDirectory: null })).rejects.toMatchObject({ code: 'terminal-validation', status: 409 });
    expect(ptys).toHaveLength(0);
  });

  for (const backend of RUNTIME_BACKENDS) it(`preserves admission, notifications and input ordering through the service boundary (${backend})`, async () => {
    const { runtime, ptys } = setup();
    const service = await serviceFor(runtime, 'local', backend);
    const results = await Promise.allSettled(Array.from({ length: 9 }, (_, index) => create(service, `create-${index}`)));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(8);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(ptys).toHaveLength(8);
    const { terminal } = await create(service, 'create-0');
    expect(ptys).toHaveLength(8);
    const first = peer('first');
    const second = peer('second');
    const request = { type: 'terminal-attach', terminalId: terminal.terminalId, clientId: 'first', afterSequence: 0, intent: 'restore', attachmentEpoch: (await service.list(authority)).attachmentEpoch };
    await service.attach(authority, first, request);
    await service.attach(authority, second, { ...request, clientId: 'second', intent: 'takeover' });
    expect(first.messages).toContainEqual(expect.objectContaining({ type: 'terminal-taken-over' }));
    await expect(service.input(authority, first, terminal.terminalId, 'stale')).rejects.toThrow();
    await service.rename(authority, terminal.terminalId, 'Build logs');
    for (const browser of [first, second]) {
      expect(browser.messages).toContainEqual(expect.objectContaining({ type: 'terminal-status', terminal: expect.objectContaining({ title: 'Build logs' }) }));
    }
    ptys[0].operations.length = 0;
    const applied = Promise.withResolvers();
    ptys[0].onOperation = () => {
      if (ptys[0].operations.at(-1)?.[0] === 120) applied.resolve();
    };
    await service.resize(authority, second, terminal.terminalId, 100, 30);
    await service.input(authority, second, terminal.terminalId, 'command\r');
    await service.resize(authority, second, terminal.terminalId, 120, 40);
    await applied.promise;
    expect(ptys[0].operations).toEqual([[100, 30], 'command\r', [120, 40]]);
    await expect(service.list({ ...authority, expiresAtMs: 1 })).rejects.toMatchObject({ code: 'terminal-auth-expired' });
    const terminated = await service.terminate(authority, terminal.terminalId, 'terminate');
    expect(await service.terminate(authority, terminal.terminalId, 'terminate')).toEqual(terminated);
    for (const browser of [first, second]) {
      expect(browser.messages).toContainEqual(expect.objectContaining({ type: 'terminal-terminated' }));
    }
    expect(ptys[0].killed).toBe(true);
    expect((await service.list(authority)).terminals).toHaveLength(7);
  });

  it('round trips executor creation and attachment identity', () => {
    const request = { requestId: 'request', executorId: 'local', expectedTerminalRuntimeId: crypto.randomUUID(), requestedInitialWorkingDirectory: null };
    expect(parseTerminalCreateRequest(request)).toEqual(request);
    expect(parseTerminalCreateRequest({ ...request, executorId: 'invalid' })).toBeNull();
    const detach = { type: 'terminal-detach', terminalId: 'terminal', attachmentId: 'attachment' };
    expect(parseTerminalStreamClientMessage(detach)).toEqual(detach);
    const output = { type: 'terminal-output', terminalId: 'terminal', attachmentId: 'attachment', sequence: 1, data: 'text' };
    expect(parseTerminalStreamServerMessage(output)).toEqual(output);
  });
});
