import { expect, mock, test } from 'bun:test';
import type { AgentHistoryImport, AgentIntegration, AgentImportedTranscriptRow } from '@garcon/server-agent-interface';
import { AssistantMessage } from '../../../common/chat-types.js';
import { NodeDeadline } from '../../execution-nodes/deadline.js';
import { NodeHistoryMemoryBudget } from '../../execution-nodes/transport/provider-history-memory.js';
import { decodeNodeHistoryRow } from '../../execution-nodes/transport/provider-history-row.js';
import { LocalProviderHistoryImportService } from '../local-provider-history-import.js';
import { NodeHistoryImportCursor, type NodeHistoryCursorOptions } from '../provider-history-cursor.js';

const at = '2026-01-01T00:00:00.000Z';
const row = (index = 1) => ({ message: new AssistantMessage(at, `Synthetic row ${index}`), providerMeta: { index } });
const grant = { controllerBootId: 'synthetic-controller', nodeBootId: 'synthetic-node', logicalSessionId: 'synthetic-session', transferId: 'synthetic-transfer' };
const signal = () => new AbortController().signal;
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function fixture(load: AgentHistoryImport['load']) {
  const integration = {
    descriptor: { id: 'synthetic', label: 'Synthetic', icon: null, supportedPermissionModes: ['default'],
      supportedThinkingModes: ['none'], supportsImages: false, supportsProjectPathUpdate: false,
      requiresNativePathForProjectPathUpdate: false, supportedEndpointProtocols: [], configuration: [] },
    settings: { defaults: () => ({ ownerId: 'synthetic', schemaVersion: 1, values: {} }), describe: () => [],
      migrate: async (input) => input, parse: (input) => input, applyPatch: (input) => input },
  } satisfies Pick<AgentIntegration, 'descriptor' | 'settings'>;
  const lifetime = new AbortController();
  const memory = new NodeHistoryMemoryBudget(16 * 1024 * 1024);
  const received: AgentImportedTranscriptRow[] = [];
  const transfer = mock<NodeHistoryCursorOptions['transfer']>(async (bytes) => { received.push(decodeNodeHistoryRow(bytes, memory)); });
  const release = mock(() => {});
  let now = 0;
  const createClock = () => ({ read: () => ({ elapsedMs: now, discontinuity: false }) });
  const timers = new Set<{ at: number; callback(): void }>();
  const cursor = new NodeHistoryImportCursor({
    source: new LocalProviderHistoryImportService(integration, { load }),
    request: { chat: { chatId: '1000000000000001', agentId: 'synthetic', agentSessionId: 'synthetic-native',
      projectPath: '/synthetic/project', model: 'synthetic-model', nativeSession: null, carryOverRevision: '', nativeSeedReceipt: null, settings: null } },
    signal: lifetime.signal, memory, transfer, release, createClock,
    scheduleTimeout(callback, delay) { const timer = { at: now + delay, callback }; timers.add(timer); return { cancel: () => timers.delete(timer) }; },
  });
  return { cursor, lifetime, memory, received, transfer, release, timers,
    deadline: (ms = 60_000) => new NodeDeadline(ms, createClock()),
    advance(ms: number) { now += ms; for (const timer of [...timers]) if (timer.at <= now) { timers.delete(timer); timer.callback(); } },
  };
}

test.each(['mutate', 'truncate'])('pulls one row at a time from a complete 257-row snapshot (%s)', async (change) => {
  const batch = Array.from({ length: 257 }, (_, index) => row(index));
  const advanced = mock(() => {});
  const f = fixture(async function* () { advanced(); yield []; yield batch; advanced(); });
  expect(advanced).not.toHaveBeenCalled();
  for (let index = 0; index < 257; index++) {
    const offer = await f.cursor.next(index + 1, signal(), f.deadline());
    expect(offer.kind).toBe('row');
    if (offer.kind !== 'row') throw new Error('Expected row');
    if (!index) {
      if (change === 'mutate') batch[256]!.message.content = 'Synthetic mutation';
      else batch.length = 256;
    }
    expect(advanced).toHaveBeenCalledTimes(1);
    await f.cursor.transfer(index + 1, grant, offer.descriptor, signal(), f.deadline());
    expect(f.transfer.mock.calls[index]?.slice(1, 4)).toEqual([index + 1, grant, offer.descriptor]);
    expect(f.release).not.toHaveBeenCalled();
  }
  expect(f.received[256]).toEqual(row(256));
  expect(await f.cursor.next(258, signal(), f.deadline())).toEqual({ kind: 'eof', sequence: 258 });
  expect(await f.cursor.settled).toEqual({ kind: 'complete' });
  expect(advanced).toHaveBeenCalledTimes(2);
  expect(f.release).toHaveBeenCalledTimes(1);
  expect(f.memory.reservedBytes).toBe(0);
  expect(f.timers.size).toBe(0);
});

test('cancellation rejects promptly while ignored advancement and cleanup retain capacity', async () => {
  const advancement = Promise.withResolvers<IteratorResult<readonly AgentImportedTranscriptRow[]>>();
  const cleanup = Promise.withResolvers<IteratorResult<readonly AgentImportedTranscriptRow[]>>();
  const returned = mock(() => cleanup.promise);
  let providerSignal: AbortSignal | undefined;
  const f = fixture((request) => { providerSignal = request.signal; return { [Symbol.asyncIterator]: () => ({ next: () => advancement.promise, return: returned }) }; });
  const waiting = f.cursor.next(1, signal(), f.deadline()).catch((error: unknown) => error);
  await tick();
  const reason = new Error('Synthetic import cancellation');
  f.cursor.cancel(reason);
  expect(await waiting).toBe(reason);
  expect(providerSignal?.aborted).toBe(true);
  expect(f.release).not.toHaveBeenCalled();
  expect(returned).not.toHaveBeenCalled();
  advancement.resolve({ done: false, value: [row()] });
  await tick();
  expect(returned).toHaveBeenCalledTimes(1);
  expect(f.release).not.toHaveBeenCalled();
  cleanup.resolve({ done: true, value: undefined });
  expect((await f.cursor.settled).kind).toBe('cancelled');
  expect(f.release).toHaveBeenCalledTimes(1);
});

test('duplicate advancement fences the cursor without invoking the provider twice', async () => {
  const pending = Promise.withResolvers<void>();
  const advanced = mock(async function* () { await pending.promise; yield [row()]; });
  const f = fixture(advanced);
  const first = f.cursor.next(1, signal(), f.deadline()).catch((error: unknown) => error);
  await tick();
  expect(() => f.cursor.next(1, signal(), f.deadline())).toThrow('Invalid history cursor');
  expect(await first).toMatchObject({ code: 'NODE_HISTORY_INVALID' });
  expect(advanced).toHaveBeenCalledTimes(1);
  expect(f.release).not.toHaveBeenCalled();
  pending.resolve(); await f.cursor.settled;
  expect(f.release).toHaveBeenCalledTimes(1);
});

test('empty normal EOF completes, while cancellation at EOF rejects with its reason', async () => {
  const empty = fixture(async function* () { yield []; });
  expect(await empty.cursor.next(1, signal(), empty.deadline())).toEqual({ kind: 'eof', sequence: 1 });
  expect(await empty.cursor.settled).toEqual({ kind: 'complete' });
  const reason = new Error('Synthetic EOF cancellation');
  const cancelled = fixture(async function* () { cancelled.lifetime.abort(reason); yield []; });
  expect(await cancelled.cursor.next(1, signal(), cancelled.deadline()).catch((error: unknown) => error)).toBe(reason);
  expect((await cancelled.cursor.settled).kind).toBe('cancelled');
});

test('source and cleanup failures survive together', async () => {
  const source = new Error('Synthetic source failure');
  const cleanup = new Error('Synthetic cleanup failure');
  const f = fixture(() => ({ [Symbol.asyncIterator]: () => ({ next: async () => { throw source; }, return: async () => { throw cleanup; } }) }));
  const error = await f.cursor.next(1, signal(), f.deadline()).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(AggregateError);
  expect((error as AggregateError).errors).toEqual([source, cleanup]);
  expect(await f.cursor.settled).toEqual({ kind: 'failed', error });
  expect(f.release).toHaveBeenCalledTimes(1);
});

test('cancelled transfers retain their encoded row until the sender actually settles', async () => {
  const f = fixture(async function* () { yield [row()]; });
  const pending = Promise.withResolvers<void>();
  f.transfer.mockImplementation(async () => pending.promise);
  const offer = await f.cursor.next(1, signal(), f.deadline());
  if (offer.kind !== 'row') throw new Error('Expected row');
  const caller = new AbortController();
  const sending = f.cursor.transfer(1, grant, offer.descriptor, caller.signal, f.deadline()).catch((error: unknown) => error);
  await tick(); caller.abort(new Error('Synthetic transfer cancelled'));
  expect(await sending).toBe(caller.signal.reason);
  expect(f.memory.reservedBytes).toBe(offer.descriptor.byteLength);
  expect(f.release).not.toHaveBeenCalled();
  pending.resolve(); await f.cursor.settled;
  expect(f.memory.reservedBytes).toBe(0);
  expect(f.release).toHaveBeenCalledTimes(1);
});

test('idle expiry does not shorten an active provider deadline', async () => {
  const pending = Promise.withResolvers<void>();
  const f = fixture(async function* () { await pending.promise; yield [row()]; });
  const next = f.cursor.next(1, signal(), f.deadline());
  await tick(); f.advance(30_001);
  expect(f.release).not.toHaveBeenCalled();
  pending.resolve(); expect((await next).kind).toBe('row');
  f.advance(30_000);
  expect((await f.cursor.settled).kind).toBe('cancelled');
  expect(f.memory.reservedBytes).toBe(0);
});

test('inherited advancement expiry fences delivery before ignored provider work settles', async () => {
  const pending = Promise.withResolvers<void>();
  const f = fixture(async function* () { await pending.promise; yield [row()]; });
  const next = f.cursor.next(1, signal(), f.deadline(10)).catch((error: unknown) => error);
  await tick(); f.advance(10);
  expect(await next).toMatchObject({ code: 'NODE_HISTORY_UNAVAILABLE' });
  expect(f.release).not.toHaveBeenCalled();
  pending.resolve(); await f.cursor.settled;
  expect(f.transfer).not.toHaveBeenCalled();
  expect(f.release).toHaveBeenCalledTimes(1);
});

test.each([
  ['encoding', 'caller'], ['encoding', 'deadline'], ['transfer', 'caller'], ['transfer', 'deadline'],
] as const)('%s failure remains cancellable by %s while cleanup ignores abort', async (failure, cancellation) => {
  const cleanup = Promise.withResolvers<IteratorResult<readonly AgentImportedTranscriptRow[]>>();
  const cleaning = Promise.withResolvers<void>();
  const returned = mock(() => { cleaning.resolve(); return cleanup.promise; });
  const imported = row();
  if (failure === 'encoding') imported.message.content = 'x'.repeat(3 * 1024 * 1024);
  const f = fixture(() => ({ [Symbol.asyncIterator]: () => ({ next: async () => ({ done: false, value: [imported] }), return: returned }) }));
  const caller = new AbortController();
  const transferFailure = new Error('Synthetic transfer failed before cleanup');
  f.transfer.mockRejectedValue(transferFailure);
  let outcome: unknown;
  let operation: Promise<unknown>;
  if (failure === 'encoding') operation = f.cursor.next(1, caller.signal, f.deadline(100));
  else {
    const offer = await f.cursor.next(1, signal(), f.deadline());
    if (offer.kind !== 'row') throw new Error('Expected row');
    operation = f.cursor.transfer(1, grant, offer.descriptor, caller.signal, f.deadline(100));
  }
  const observed = operation.then((value) => { outcome = value; }, (error: unknown) => { outcome = error; });
  try {
    await cleaning.promise;
    const retainedBytes = f.memory.reservedBytes;
    const reason = new Error('Synthetic cancellation during cleanup');
    if (cancellation === 'caller') caller.abort(reason);
    else f.advance(100);
    await tick();
    if (cancellation === 'caller') expect(outcome).toBe(reason);
    else expect(outcome).toMatchObject({ code: 'NODE_HISTORY_UNAVAILABLE' });
    expect(f.release).not.toHaveBeenCalled();
    expect(f.memory.reservedBytes).toBe(retainedBytes);
    expect(returned).toHaveBeenCalledTimes(1);
  } finally {
    cleanup.resolve({ done: true, value: undefined });
    await observed;
    await f.cursor.settled;
  }
  await tick();
  expect(f.release).toHaveBeenCalledTimes(1);
  expect(f.memory.reservedBytes).toBe(0);
  expect(f.timers.size).toBe(0);
});
