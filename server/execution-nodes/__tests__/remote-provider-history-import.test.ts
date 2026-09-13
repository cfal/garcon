import { afterEach, expect, mock, test } from 'bun:test';
import type { AgentChatReference, AgentImportedTranscriptRow } from '@garcon/server-agent-interface';
import { AssistantMessage } from '../../../common/chat-types.js';
import { parseNodeBulkFrameText } from '../transport/bulk-channel-wire.js';
import { historyFixture, tick } from './remote-provider-history-fixture.js';
import { RemoteProviderHistoryImportService, type RemoteProviderHistoryConnection } from '../remote-provider-history-import.js';

const fixtures: ReturnType<typeof historyFixture>[] = [];
afterEach(async () => { for (const f of fixtures.splice(0)) await f.close(); });
const fixture = (load: Parameters<typeof historyFixture>[0]) => { const f = historyFixture(load); fixtures.push(f); return f; };
const row = (content = 'Synthetic row') => ({ message: new AssistantMessage('2026-01-01T00:00:00.000Z', content) });
const caller = () => new AbortController();

test('captured connection ports support class getters and preserve their method receiver through cleanup', async () => {
  const f = fixture(async function* () { yield [row()]; });
  class Connection implements RemoteProviderHistoryConnection {
    #validations = 0;
    #cleanups = 0;
    get nodeId() { return f.binding.nodeId; }
    get session() { return f.binding.session; }
    get connectionId() { return f.binding.connectionId; }
    get bulkAttemptId() { return f.binding.bulkAttemptId; }
    get signal() { return f.binding.signal; }
    get controlSignal() { return f.binding.controlSignal; }
    get service() { return f.binding.service; }
    get receiver() { return f.binding.receiver; }
    get bulk() { return f.binding.bulk; }
    validate() { this.#validations++; f.binding.validate(); }
    validateControl() { this.#cleanups++; f.binding.validateControl(); }
    get calls() { return { validations: this.#validations, cleanups: this.#cleanups }; }
  }
  const connection = new Connection();
  const service = new RemoteProviderHistoryImportService({ nodeId: connection.nodeId, instanceId: 'synthetic-instance' }, 'native',
    () => ({ nodeId: connection.nodeId, workspaceId: 'synthetic-workspace' }), () => connection);
  const iterator = service.read(f.request, caller().signal)[Symbol.asyncIterator]();
  expect((await iterator.next()).value).toEqual([row()]);
  await iterator.return!();
  expect(connection.calls.validations).toBeGreaterThan(0);
  expect(connection.calls.cleanups).toBeGreaterThan(0);
  expect(f.commands.at(-1)?.operation).toBe('cancel');
});

test('captures chat settings and native data before lazy open, then yields reconstructed singleton rows without prefetch', async () => {
  const loaded = mock((_chat: AgentChatReference) => {}); const advanced = mock(() => {});
  const large = row('Synthetic '.repeat(40_000));
  const f = fixture(async function* (request) {
    loaded(request.chat); yield []; yield [large, row('Synthetic second')]; advanced();
  });
  const iterable = f.importer().read(f.request, caller().signal);
  f.request.chat.settings!.values.key = 'mutated'; f.request.chat.nativeSession!.value.key = 'mutated';
  expect(f.commands).toHaveLength(0); expect(loaded).not.toHaveBeenCalled();
  const iterator = iterable[Symbol.asyncIterator]();
  const first = await iterator.next();
  expect(first.value).toEqual([large]); expect(first.value![0]!.message).toBeInstanceOf(AssistantMessage);
  expect(loaded.mock.calls[0]![0]).toMatchObject({ projectPath: '/synthetic/node-project',
    settings: { values: { key: 'original' } }, nativeSession: { value: { key: 'original' } } });
  expect(f.commands.map((command) => command.operation)).toEqual(['open', 'next', 'transfer']);
  expect(advanced).not.toHaveBeenCalled(); expect(f.receiver.reservedBytes).toBe(0);
  expect((await iterator.next()).value).toEqual([row('Synthetic second')]);
  expect(advanced).not.toHaveBeenCalled(); expect((await iterator.next()).done).toBe(true);
  expect(advanced).toHaveBeenCalledTimes(1); expect(f.occupancy.active).toBe(0);
  expect(f.commands.some((command) => command.operation === 'cancel')).toBe(false);
  expect(f.senderMemory.reservedBytes + f.receiverMemory.reservedBytes).toBe(0);
  expect(f.deadlines.every((ms) => ms > 0 && ms <= 300_000)).toBe(true);
});

test('only explicit normal EOF succeeds empty and the two nullable facets never substitute', async () => {
  const loaded = mock(() => {});
  const f = fixture(async function* () { loaded(); yield []; });
  const native = f.importer().read(f.request, caller().signal)[Symbol.asyncIterator]();
  expect((await native.next()).done).toBe(true);
  const legacy = f.importer('legacy').read(f.request, caller().signal)[Symbol.asyncIterator]();
  await expect(legacy.next()).rejects.toMatchObject({ code: 'NODE_HISTORY_UNAVAILABLE' });
  expect(loaded).toHaveBeenCalledTimes(1);
});

test.each(['open', 'next', 'transfer', 'eof'] as const)('a lost %s reply fails the complete import and never retries', async (lost) => {
  const f = fixture(async function* () { yield [row()]; });
  f.afterReply(async (command, reply) => (lost === 'eof' ? reply.operation === 'eof' : command.operation === lost)
    ? { kind: 'unknown' } : reply);
  const iterator = f.importer().read(f.request, caller().signal)[Symbol.asyncIterator]();
  if (lost === 'eof') expect((await iterator.next()).value).toEqual([row()]);
  await expect(iterator.next()).rejects.toMatchObject({ code: 'NODE_HISTORY_UNAVAILABLE' });
  expect(f.commands.filter((command) => command.operation === 'open')).toHaveLength(1);
  expect(f.commands.filter((command) => command.operation === 'cancel')).toHaveLength(1);
  expect(f.receiver.reservedBytes).toBe(0);
  await tick(); expect(f.occupancy.active).toBe(0);
});

test('verified bytes alone never yield when the sender completion acknowledgement is lost', async () => {
  const f = fixture(async function* () { yield [row()]; });
  const completion = Promise.withResolvers<void>();
  f.upstream((frame) => {
    const payload = parseNodeBulkFrameText(frame.payload)!;
    if (payload.type !== 'node-bulk-result' || payload.command !== 'node-bulk-complete') f.sender.receive(frame);
    else completion.resolve();
    return true;
  });
  const iterator = f.importer().read(f.request, caller().signal)[Symbol.asyncIterator]();
  let delivered = false;
  const waiting = iterator.next().then(() => { delivered = true; }, (error: unknown) => error);
  await completion.promise; expect(f.receiver.reservedBytes).toBeGreaterThan(0); expect(delivered).toBe(false);
  for (const expire of [...f.creditTimers]) expire();
  expect(await waiting).toMatchObject({ code: 'NODE_HISTORY_UNAVAILABLE' });
  expect(delivered).toBe(false); expect(f.receiver.reservedBytes).toBe(0);
});

test('cancellation at EOF preserves the exact caller reason', async () => {
  const f = fixture(async function* () {}); const controller = caller(); const reason = new Error('Synthetic EOF cancellation');
  f.afterReply(async (_command, reply) => { if (reply.operation === 'eof') controller.abort(reason); return reply; });
  const iterator = f.importer().read(f.request, controller.signal)[Symbol.asyncIterator]();
  await expect(iterator.next()).rejects.toBe(reason);
  expect(f.commands.at(-1)?.operation).toBe('cancel');
});

test('lost chunk credit maps receiver retirement into the closed history failure contract', async () => {
  const f = fixture(async function* () { yield [row()]; });
  const offered = Promise.withResolvers<void>();
  f.downstream((frame) => {
    if (parseNodeBulkFrameText(frame.payload)?.type === 'node-bulk-credit-chunk') offered.resolve();
    else f.receiver.receive(frame);
  });
  const iterator = f.importer().read(f.request, caller().signal)[Symbol.asyncIterator]();
  const reading = iterator.next().catch((error: unknown) => error);
  await offered.promise;
  for (const expire of [...f.creditTimers]) expire();
  expect(await reading).toMatchObject({ code: 'NODE_HISTORY_UNAVAILABLE' });
  expect(f.receiverMemory.reservedBytes).toBe(0);
  expect(f.senderMemory.reservedBytes).toBe(0);
  expect(f.control.signal.aborted).toBe(false);
});

test('return interrupts a pending advancement while the instance retains capacity through actual cleanup', async () => {
  const advancement = Promise.withResolvers<IteratorResult<readonly AgentImportedTranscriptRow[]>>();
  const cleanup = Promise.withResolvers<IteratorResult<readonly AgentImportedTranscriptRow[]>>();
  const returned = mock(() => cleanup.promise);
  const f = fixture(() => ({ [Symbol.asyncIterator]: () => ({ next: () => advancement.promise, return: returned }) }));
  const iterator = f.importer().read(f.request, caller().signal)[Symbol.asyncIterator]();
  const waiting = iterator.next(); await tick();
  expect((await iterator.return!()).done).toBe(true); expect((await waiting).done).toBe(true);
  expect(f.capacity.reserve('work')).toBeNull(); expect(returned).not.toHaveBeenCalled();
  advancement.resolve({ done: false, value: [row()] }); await tick();
  expect(returned).toHaveBeenCalledTimes(1); expect(f.occupancy.active).toBe(1);
  cleanup.resolve({ done: true, value: undefined }); await tick();
  expect(f.occupancy.active).toBe(0);
});

test('caller cancellation while consumption is paused sends exact cleanup without another pull', async () => {
  const returned = mock(() => {});
  const f = fixture(async function* () { try { yield [row()]; } finally { returned(); } });
  const controller = caller(); const iterator = f.importer().read(f.request, controller.signal)[Symbol.asyncIterator]();
  await iterator.next(); controller.abort(new Error('Synthetic paused cancellation')); await tick();
  expect(returned).toHaveBeenCalledTimes(1); expect(f.commands.at(-1)?.operation).toBe('cancel');
  await expect(iterator.return!()).rejects.toBe(controller.signal.reason);
  expect(f.commands.filter((command) => command.operation === 'cancel')).toHaveLength(1);
});

test('bulk loss fails the captured import and uses surviving control for exact cleanup', async () => {
  const f = fixture(async function* () { yield [row()]; });
  f.downstream(() => f.bulkLifetime.abort(new Error('Synthetic replaced bulk')));
  const iterator = f.importer().read(f.request, caller().signal)[Symbol.asyncIterator]();
  await expect(iterator.next()).rejects.toThrow('Synthetic replaced bulk');
  expect(f.commands.at(-1)).toMatchObject({ operation: 'cancel', bulkAttemptId: 'synthetic-bulk', connectionId: 1 });
  expect(f.control.signal.aborted).toBe(false); expect(f.receiver.reservedBytes).toBe(0);
});

test('source failure and lost cleanup reply are retained together', async () => {
  const f = fixture(async function* () { throw new Error('Synthetic source failure'); });
  f.afterReply(async (command, reply) => command.operation === 'cancel' ? { kind: 'unknown' } : reply);
  const iterator = f.importer().read(f.request, caller().signal)[Symbol.asyncIterator]();
  const result = await iterator.next().catch((error: unknown) => error);
  expect(result).toBeInstanceOf(AggregateError);
  expect((result as AggregateError).errors).toMatchObject([
    { code: 'NODE_HISTORY_SOURCE_FAILED' }, { code: 'NODE_HISTORY_CLEANUP_UNCONFIRMED' },
  ]);
});

test('a wrong import reply cannot deliver or retarget a row', async () => {
  const f = fixture(async function* () { yield [row()]; });
  f.afterReply(async (_command, reply) => reply.operation === 'row' ? { ...reply, instanceId: 'synthetic-other-instance' } : reply);
  const iterator = f.importer().read(f.request, caller().signal)[Symbol.asyncIterator]();
  await expect(iterator.next()).rejects.toMatchObject({ code: 'NODE_HISTORY_UNAVAILABLE' });
  expect(f.commands.map((command) => command.operation)).toEqual(['open', 'next', 'cancel']);
});
