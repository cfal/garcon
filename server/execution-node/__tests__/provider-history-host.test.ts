import { expect, mock, test } from 'bun:test';
import type { AgentImportedTranscriptRow } from '@garcon/server-agent-interface';
import { AssistantMessage } from '../../../common/chat-types.js';
import { NodeDeadline } from '../../execution-nodes/deadline.js';
import type { ProviderHistoryImportRequest, ProviderHistoryImportService } from '../../execution-nodes/provider-history-import.js';
import { NodeHistoryMemoryBudget } from '../../execution-nodes/transport/provider-history-memory.js';
import type { NodeProviderHistoryCommand } from '../../execution-nodes/transport/provider-history-wire.js';
import { NodeExecutionResources } from '../execution-resources.js';
import { NodeNativeOccupancy } from '../native-occupancy.js';
import { NodeProviderCapacity } from '../provider-capacity.js';
import { NodeProviderHistoryImportHost } from '../provider-history-host.js';

const session = { controllerBootId: 'synthetic-controller', nodeBootId: 'synthetic-node-boot', logicalSessionId: 'synthetic-session' };
const row = { message: new AssistantMessage('2026-01-01T00:00:00.000Z', 'Synthetic imported row') };
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function fixture(instanceId = 'synthetic-a', source?: ProviderHistoryImportService, maxWindow = 64, workSlots = 1) {
  const lifetime = new AbortController(); let physical = new AbortController(); let attempt = '1'; let admitting = true;
  const instance = { nodeId: 'synthetic-node', instanceId };
  const resources = new NodeExecutionResources(instance.nodeId);
  resources.register({ location: { ...instance, workspaceId: 'synthetic-workspace' }, projectPath: `/synthetic/${instanceId}`, execution: null,
    files: { inspectProject: async () => ({ kind: 'unavailable', reason: 'missing' }) } });
  const capacity = new NodeProviderCapacity(workSlots + 1, 1);
  const occupancy = new NodeNativeOccupancy(2);
  const read = mock((_request: ProviderHistoryImportRequest, _signal: AbortSignal) => (async function* () { yield [row]; })());
  const memory = new NodeHistoryMemoryBudget(1024 * 1024);
  const host = new NodeProviderHistoryImportHost({ instance, session, agentId: 'synthetic', signal: lifetime.signal,
    capacity, occupancy, memory, resources, facets: { native: source ?? { read }, legacy: null }, maxWindow,
    assertAdmission() { if (!admitting) throw new Error('Synthetic suspended admission'); },
    capture(target) {
      const captured = physical;
      if (target.bulkAttemptId !== attempt || target.connectionId !== 1) throw new Error('Synthetic physical mismatch');
      return { signal: captured.signal, validate: () => captured.signal.throwIfAborted(), transfer: async () => {} };
    },
  });
  const command = (operationId = '1', after = 0): Extract<NodeProviderHistoryCommand, { operation: 'open' }> => ({
    method: 'provider-history-import', operation: 'open', after, identity: { ...session, operationId }, instanceId, connectionId: 1, bulkAttemptId: attempt,
    workspaceId: 'synthetic-workspace', facet: 'native', chat: { chatId: '1000000000000001', agentId: 'synthetic', agentSessionId: 'colliding-native-id',
      model: '', nativeSession: null, carryOverRevision: '', nativeSeedReceipt: null, settings: null },
  });
  const target = (operationId = '1') => { const { method, identity, instanceId, connectionId, bulkAttemptId } = command(operationId); return { method, identity, instanceId, connectionId, bulkAttemptId }; };
  return { host, command, target, lifetime, resources, read, capacity, occupancy, memory,
    call: (command: NodeProviderHistoryCommand) => host.execute(command, new AbortController().signal, new NodeDeadline(60_000)),
    suspend() { admitting = false; }, resume() { admitting = true; },
    replaceBulk() { physical.abort(new Error('Synthetic bulk replaced')); physical = new AbortController(); attempt = '2'; },
  };
}

test('colliding native IDs stay on the captured instance and owner-installed project path', async () => {
  const a = fixture('synthetic-a'); const b = fixture('synthetic-b');
  try {
    for (const f of [a, b]) {
      expect(await f.call(f.command())).toMatchObject({ operation: 'opened' });
      expect(f.read.mock.calls[0]![0].chat.projectPath).toBe(`/synthetic/${f.command().instanceId}`);
      expect(await f.call({ ...f.target(), operation: 'next', sequence: 1 })).toMatchObject({ operation: 'row', sequence: 1 });
    }
    expect(await a.call({ ...a.command('9'), instanceId: 'synthetic-b' })).toMatchObject({ operation: 'failed', code: 'NODE_HISTORY_INVALID' });
    expect(a.read).toHaveBeenCalledTimes(1);
  } finally { a.host.close(); b.host.close(); await tick(); }
  expect(a.occupancy.active + b.occupancy.active).toBe(0);
});

test('legacy and native facets remain separate and identities cannot reopen after a lost open reply', async () => {
  const f = fixture();
  expect(await f.call({ ...f.command('2'), facet: 'legacy' })).toMatchObject({ operation: 'failed', code: 'NODE_HISTORY_UNAVAILABLE' });
  expect(f.read).not.toHaveBeenCalled();
  await f.call(f.command());
  expect(await f.call({ ...f.target(), operation: 'cancel' })).toMatchObject({ operation: 'cancelled', settled: false });
  await tick();
  expect(await f.call({ ...f.target(), operation: 'cancel' })).toMatchObject({ operation: 'cancelled', settled: true });
  expect(await f.call(f.command())).toMatchObject({ operation: 'failed', code: 'NODE_HISTORY_INVALID' });
  expect(f.read).toHaveBeenCalledTimes(1);
  f.host.close();
});

test('cancellation retains shared provider and native occupancy through pending cleanup', async () => {
  const cleanup = Promise.withResolvers<IteratorResult<readonly AgentImportedTranscriptRow[]>>();
  const f = fixture('synthetic-a', { read: () => ({ [Symbol.asyncIterator]: () => ({ next: async () => ({ done: false, value: [row] }), return: () => cleanup.promise }) }) });
  await f.call(f.command());
  await f.call({ ...f.target(), operation: 'next', sequence: 1 });
  f.suspend();
  expect(await f.call({ ...f.target(), operation: 'cancel' })).toMatchObject({ operation: 'cancelled', settled: false });
  expect(f.capacity.reserve('work')).toBeNull();
  expect(() => f.occupancy.reserveExecution(f.command().chat.chatId)).toThrow('reserved');
  const status = f.capacity.reserve('status'); expect(status).not.toBeNull(); status!();
  cleanup.resolve({ done: true, value: undefined }); await tick();
  expect(await f.call({ ...f.target(), operation: 'cancel' })).toMatchObject({ operation: 'cancelled', settled: true });
  expect(f.occupancy.active).toBe(0); expect(f.memory.reservedBytes).toBe(0);
  const release = f.capacity.reserve('work'); expect(release).not.toBeNull(); release!();
  f.host.close();
});

test('bulk-only replacement cancels the captured import and cannot retarget its operation', async () => {
  const pending = Promise.withResolvers<IteratorResult<readonly AgentImportedTranscriptRow[]>>();
  const f = fixture('synthetic-a', { read: () => ({ [Symbol.asyncIterator]: () => ({ next: () => pending.promise }) }) });
  const original = f.target();
  await f.call(f.command());
  const reading = f.call({ ...original, operation: 'next', sequence: 1 });
  await tick(); f.replaceBulk();
  expect(await reading).toMatchObject({ operation: 'failed' });
  expect(await f.call({ ...f.target(), operation: 'next', sequence: 1 })).toMatchObject({ operation: 'failed', code: 'NODE_HISTORY_INVALID' });
  expect(await f.call(f.command('2'))).toMatchObject({ operation: 'failed', code: 'NODE_CAPACITY' });
  pending.resolve({ done: true, value: undefined }); await tick();
  expect(await f.call({ ...original, operation: 'cancel' })).toMatchObject({ operation: 'cancelled', settled: true });
  expect(f.occupancy.active).toBe(0); f.host.close();
});

test('unknown cancellation fences only its ordinal and out-of-order opens remain admissible', async () => {
  const f = fixture();
  const cancelled = { ...f.target(), identity: { ...session, operationId: '2' }, operation: 'cancel' } as const;
  expect(await f.call(cancelled)).toMatchObject({ operation: 'cancelled', settled: true });
  expect(await f.call(f.command('2'))).toMatchObject({ operation: 'failed', code: 'NODE_HISTORY_INVALID' });
  expect(await f.call(f.command('1'))).toMatchObject({ operation: 'opened' });
  expect(f.read).toHaveBeenCalledTimes(1);
  f.host.close(); await tick();
});


test('ten thousand sequential imports on one physical attempt never exhaust identities', async () => {
  const f = fixture('synthetic-a', { read: () => (async function* () {})() });
  try {
    for (let ordinal = 1; ordinal <= 10_000; ordinal++) {
      const command = f.command(String(ordinal));
      expect(await f.call(command)).toMatchObject({ operation: 'opened' });
      const { method, identity, instanceId, connectionId, bulkAttemptId } = command;
      expect(await f.call({ method, identity, instanceId, connectionId, bulkAttemptId, operation: 'next', sequence: 1 }))
        .toMatchObject({ operation: 'eof' });
    }
    expect(f.occupancy.active).toBe(0);
  } finally { f.host.close(); }
});

test('unknown cancels for an uninstalled attempt cannot consume history capacity', async () => {
  const f = fixture(); f.suspend();
  try {
    for (let ordinal = 1; ordinal <= 5000; ordinal++) {
      expect(await f.call({ ...f.target(), identity: { ...session, operationId: String(ordinal) }, bulkAttemptId: '9', operation: 'cancel' }))
        .toMatchObject({ operation: 'cancelled', settled: true });
    }
    f.resume();
    expect(await f.call(f.command())).toMatchObject({ operation: 'opened' });
    expect(f.read).toHaveBeenCalledTimes(1);
  } finally { f.host.close(); await tick(); }
});


test('a full sparse window recovers through a retirement hint while retaining live work', async () => {
  const f = fixture('synthetic-a', undefined, 3, 2);
  try {
    expect(await f.call(f.command())).toMatchObject({ operation: 'opened' });
    for (const ordinal of ['3', '5']) {
      expect(await f.call({ ...f.target(ordinal), operation: 'cancel' })).toMatchObject({ operation: 'cancelled', settled: true });
    }
    expect(await f.call(f.command('7'))).toMatchObject({ operation: 'failed', code: 'NODE_HISTORY_UNAVAILABLE' });
    expect(await f.call({ ...f.target(), operation: 'next', sequence: 1 })).toMatchObject({ operation: 'row' });
    const next = f.command('6', 5);
    expect(await f.call({ ...next, chat: { ...next.chat, chatId: '1000000000000002' } })).toMatchObject({ operation: 'opened' });
    expect(await f.call(f.command('3'))).toMatchObject({ operation: 'failed', code: 'NODE_HISTORY_INVALID' });
    expect(await f.call(f.command('4'))).toMatchObject({ operation: 'failed', code: 'NODE_HISTORY_INVALID' });
    expect(await f.call({ ...f.target(), operation: 'cancel' })).toMatchObject({ operation: 'cancelled', settled: false });
  } finally { f.host.close(); await tick(); }
});

test('a held oldest cleanup does not fill the window with later completed imports', async () => {
  const cleanup = Promise.withResolvers<IteratorResult<readonly AgentImportedTranscriptRow[]>>();
  const f = fixture('synthetic-a', { read: (request) => request.chat.chatId === '1000000000000001'
    ? { [Symbol.asyncIterator]: () => ({ next: async () => ({ done: false, value: [row] }), return: () => cleanup.promise }) }
    : (async function* () {})() }, 2, 2);
  try {
    await f.call(f.command());
    expect(await f.call({ ...f.target(), operation: 'cancel' })).toMatchObject({ settled: false });
    for (let ordinal = 2; ordinal <= 200; ordinal++) {
      const next = f.command(String(ordinal), ordinal - 1);
      expect(await f.call({ ...next, chat: { ...next.chat, chatId: '1000000000000002' } })).toMatchObject({ operation: 'opened' });
      expect(await f.call({ ...f.target(String(ordinal)), operation: 'next', sequence: 1 })).toMatchObject({ operation: 'eof' });
      expect(f.occupancy.active).toBe(1);
    }
    expect(await f.call({ ...f.target(), operation: 'cancel' })).toMatchObject({ settled: false });
    expect(() => f.occupancy.reserveExecution(f.command().chat.chatId)).toThrow('reserved');
    cleanup.resolve({ done: true, value: undefined }); await tick();
    expect(await f.call({ ...f.target(), operation: 'cancel' })).toMatchObject({ settled: true });
    expect(await f.call(f.command())).toMatchObject({ operation: 'failed', code: 'NODE_HISTORY_INVALID' });
  } finally { cleanup.resolve({ done: true, value: undefined }); f.host.close(); await tick(); }
});

test('huge retirement hints advance in bounded work and preserve live row transfer', async () => {
  const f = fixture('synthetic-a', undefined, 3, 2);
  try {
    await f.call(f.command());
    const next = f.command(String(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER - 1);
    expect(await f.call({ ...next, chat: { ...next.chat, chatId: '1000000000000002' } })).toMatchObject({ operation: 'opened' });
    const offered = await f.call({ ...f.target(), operation: 'next', sequence: 1 });
    if (offered.operation !== 'row') throw new Error('Synthetic row was not offered');
    expect(await f.call({ ...f.target(), operation: 'transfer', sequence: 1, descriptor: offered.descriptor,
      grant: { ...session, transferId: 'synthetic-grant' } })).toMatchObject({ operation: 'transferred' });
    expect(await f.call({ ...f.target(), operation: 'next', sequence: 2 })).toMatchObject({ operation: 'eof' });
    expect(await f.call(f.command())).toMatchObject({ code: 'NODE_HISTORY_INVALID' });
  } finally { f.host.close(); await tick(); }
});

test('reordered opens consume exact ordinals without rejecting a lower outstanding open', async () => {
  const f = fixture('synthetic-a', { read: () => (async function* () {})() }, 3, 2);
  try {
    const second = f.command('2');
    expect(await f.call({ ...second, chat: { ...second.chat, chatId: '1000000000000002' } })).toMatchObject({ operation: 'opened' });
    expect(await f.call(f.command('1'))).toMatchObject({ operation: 'opened' });
    for (const ordinal of ['2', '1']) {
      expect(await f.call({ ...f.target(ordinal), operation: 'next', sequence: 1 })).toMatchObject({ operation: 'eof' });
      expect(await f.call(f.command(ordinal))).toMatchObject({ code: 'NODE_HISTORY_INVALID' });
    }
  } finally { f.host.close(); await tick(); }
});

test('a retirement hint from an uninstalled attempt cannot fence a valid delayed open', async () => {
  const f = fixture();
  try {
    expect(await f.call({ ...f.command('3', 2), bulkAttemptId: '9' })).toMatchObject({ operation: 'failed' });
    expect(await f.call(f.command())).toMatchObject({ operation: 'opened' });
    expect(f.read).toHaveBeenCalledTimes(1);
  } finally { f.host.close(); await tick(); }
});

test('reentrant cancellation during source construction reports unsettled and retains cleanup', async () => {
  const cleanup = Promise.withResolvers<IteratorResult<readonly AgentImportedTranscriptRow[]>>();
  let cancellation: Promise<unknown> | null = null;
  const f = fixture('synthetic-a', { read: () => {
    cancellation = f.call({ ...f.target(), operation: 'cancel' });
    return { [Symbol.asyncIterator]: () => ({ next: async () => ({ done: false, value: [row] }), return: () => cleanup.promise }) };
  } });
  try {
    await f.call(f.command());
    expect(await cancellation).toMatchObject({ operation: 'cancelled', settled: false });
    expect(f.occupancy.active).toBe(1);
    cleanup.resolve({ done: true, value: undefined }); await tick();
    expect(await f.call({ ...f.target(), operation: 'cancel' })).toMatchObject({ operation: 'cancelled', settled: true });
    expect(f.occupancy.active).toBe(0);
  } finally { cleanup.resolve({ done: true, value: undefined }); f.host.close(); await tick(); }
});
