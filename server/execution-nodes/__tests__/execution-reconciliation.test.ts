import { afterEach, expect, mock, test } from 'bun:test';
import type { NodeExecutionReceipt } from '../../execution-node/operation-table.js';
import { NodeExecutionReconciliation, type NodeExecutionConnection } from '../execution-reconciliation.js';
import type { NodeExecutionResult } from '../transport/execution-receipt-wire.js';
import type { NodeExecutionCommand } from '../transport/execution-wire.js';

const session = { controllerBootId: 'synthetic-controller', nodeBootId: 'synthetic-node', logicalSessionId: 'synthetic-session' };
const identity = (id = 'synthetic-operation') => ({ ...session, operationId: id });
const receipt = (patch: Partial<NodeExecutionReceipt> = {}): NodeExecutionReceipt => ({
  identity: identity(), runId: 'synthetic-run', phase: 'dispatched', dispatch: 'completed', abort: null, control: null, ...patch,
});
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });

function fixture(maxIdentities?: number) {
  const lifetime = new AbortController();
  const manager = new NodeExecutionReconciliation({ session, instanceIds: new Set(['synthetic-first', 'synthetic-second']),
    signal: lifetime.signal, maxIdentities, validate() {} });
  cleanup.push(() => lifetime.abort());
  const handler = mock(async (command: NodeExecutionCommand, _signal: AbortSignal): Promise<NodeExecutionResult> =>
    command.method === 'status' ? { kind: 'status', receipt: receipt({ identity: command.identity }) } : { kind: 'abort-result', requested: true });
  const calls: { instanceId: string; command: NodeExecutionCommand }[] = [];
  let next = 0;
  const connection = (): NodeExecutionConnection & { disconnect(): void } => {
    const closing = new AbortController();
    return { session, connectionId: ++next, signal: closing.signal, validate() { closing.signal.throwIfAborted(); },
      execution(instanceId) { return { async call(command, signal) { calls.push({ instanceId, command }); return handler(command, signal); } }; },
      disconnect() { closing.abort(); },
    };
  };
  const connect = () => { const current = connection(); manager.attach(current); return current; };
  return { manager, lifetime, handler, calls, connection, connect,
    track: (id?: string, instanceId = 'synthetic-first') => manager.track(instanceId, identity(id), 'synthetic-run'),
    aborts: () => calls.filter(({ command }) => command.method === 'abort-run'),
  };
}

test('a partition retains only the captured Stop intent and recovery checks status before its first abort', async () => {
  const f = fixture(); const first = f.track(); const sibling = f.track('synthetic-sibling', 'synthetic-second');
  const old = f.connect(); old.disconnect();
  expect(await first.interrupt()).toBe(false);
  expect(f.calls).toEqual([]);
  const current = f.connect();
  await f.manager.reconcile(current.connectionId, current.signal);
  expect(f.calls.map(({ instanceId, command }) => [instanceId, command.method])).toEqual([
    ['synthetic-first', 'status'], ['synthetic-first', 'abort-run'], ['synthetic-first', 'status'], ['synthetic-second', 'status'],
  ]);
  expect(f.aborts()[0]?.command).toEqual({ method: 'abort-run', identity: first.identity, runId: 'synthetic-run' });
  expect(sibling.receipt?.identity.operationId).toBe('synthetic-sibling');
});

test('an unknown abort reply is inspected on reconnect without resending the mutation', async () => {
  const f = fixture(); const operation = f.track();
  const old = f.connect();
  f.handler.mockImplementation(async (command) => command.method === 'status'
    ? { kind: 'status', receipt: receipt() } : { kind: 'unknown' });
  expect(await operation.interrupt()).toBe(false);
  old.disconnect(); const current = f.connect();
  await f.manager.reconcile(current.connectionId, current.signal);
  expect(await operation.interrupt()).toBe(false);
  expect(f.aborts()).toHaveLength(1);
});

test('a definitive abort refusal preserves an unsent intent for the next recovery', async () => {
  const f = fixture(); const operation = f.track(); const old = f.connect();
  f.handler.mockImplementationOnce(async () => ({ kind: 'status', receipt: receipt() }))
    .mockImplementationOnce(async () => ({ kind: 'rejected', code: 'NODE_CAPACITY' }));
  expect(await operation.interrupt()).toBe(false);
  old.disconnect(); const current = f.connect();
  await f.manager.reconcile(current.connectionId, current.signal);
  expect(f.aborts()).toHaveLength(2);
});

test.each(['pending', 'requested', 'unconfirmed'] as const)('an existing %s abort receipt prevents a second mutation', async (abort) => {
  const f = fixture(); const operation = f.track(); const current = f.connect();
  f.handler.mockImplementation(async () => ({ kind: 'status', receipt: receipt({ abort }) }));
  expect(await operation.interrupt()).toBe(abort === 'requested');
  await f.manager.reconcile(current.connectionId, current.signal);
  expect(f.aborts()).toEqual([]);
});

test('a Stop captured for the prior run cannot interrupt a successor on the same node operation', async () => {
  const f = fixture(); const operation = f.track();
  expect(await operation.interrupt()).toBe(false);
  const current = f.connect();
  f.handler.mockImplementation(async (command) => command.method === 'status'
    ? { kind: 'status', receipt: receipt({ runId: 'synthetic-successor' }) } : { kind: 'abort-result', requested: true });
  await f.manager.reconcile(current.connectionId, current.signal);
  expect(f.aborts()).toEqual([]);
  operation.advanceRun('synthetic-run', 'synthetic-successor');
  expect(await operation.interrupt()).toBe(true);
  expect(f.aborts()).toHaveLength(1);
});

test.each(['ended', 'failed', 'released', 'expired'] as const)('a %s receipt makes a pending Stop inert', async (phase) => {
  const f = fixture(); const operation = f.track();
  expect(await operation.interrupt()).toBe(false);
  const current = f.connect();
  f.handler.mockImplementation(async () => ({ kind: 'status', receipt: receipt({ phase }) }));
  await f.manager.reconcile(current.connectionId, current.signal);
  expect(f.aborts()).toEqual([]);
});

test('a superseded physical status completion cannot update a receipt or deliver a pending Stop', async () => {
  const f = fixture(); const operation = f.track(); const first = f.connect();
  const delayed = Promise.withResolvers<NodeExecutionResult>();
  f.handler.mockImplementationOnce(() => delayed.promise);
  const stopped = operation.interrupt();
  first.disconnect(); const current = f.connect();
  delayed.resolve({ kind: 'status', receipt: receipt() });
  expect(await stopped).toBe(false);
  expect(operation.receipt).toBeNull(); expect(f.aborts()).toEqual([]);
  await f.manager.reconcile(current.connectionId, current.signal);
  expect(f.aborts()).toHaveLength(1);
});

test('an older status read on the same connection cannot replace the latest receipt', async () => {
  const f = fixture(); const operation = f.track(); const current = f.connect();
  const delayed = Promise.withResolvers<NodeExecutionResult>();
  f.handler.mockImplementationOnce(() => delayed.promise).mockImplementationOnce(async () => ({ kind: 'status', receipt: receipt({ phase: 'ended' }) }));
  const first = f.manager.reconcile(current.connectionId, current.signal);
  await f.manager.reconcile(current.connectionId, current.signal);
  delayed.resolve({ kind: 'status', receipt: receipt() }); await first;
  expect(operation.receipt?.phase).toBe('ended');
});

test('concurrent Stop calls share one status check and one native abort attempt', async () => {
  const f = fixture(); const operation = f.track(); f.connect();
  const delayed = Promise.withResolvers<NodeExecutionResult>();
  f.handler.mockImplementationOnce(() => delayed.promise);
  const first = operation.interrupt(); const second = operation.interrupt();
  delayed.resolve({ kind: 'status', receipt: receipt() });
  expect(await Promise.all([first, second])).toEqual([true, true]);
  expect(f.calls.map(({ command }) => command.method)).toEqual(['status', 'abort-run']);
});

test('retirement cancels a pending receipt read and never rebinds the consumed identity', async () => {
  const f = fixture(1); const operation = f.track(); f.connect();
  const delayed = Promise.withResolvers<NodeExecutionResult>();
  let requestSignal: AbortSignal | null = null;
  f.handler.mockImplementationOnce((_command, signal) => { requestSignal = signal; return delayed.promise; });
  const stopped = operation.interrupt(); operation.retire();
  expect(requestSignal!.aborted).toBe(true);
  delayed.resolve({ kind: 'status', receipt: receipt() });
  expect(await stopped).toBe(false); expect(operation.receipt).toBeNull(); expect(f.aborts()).toEqual([]);
  expect(() => f.track()).toThrow('cannot be rebound');
  expect(() => f.track('synthetic-new')).toThrow('capacity');
});

test('receipt input and exposed snapshots cannot alter the retained identity or abort target', async () => {
  const f = fixture(); const value = identity();
  const operation = f.manager.track('synthetic-first', value, 'synthetic-run'); value.operationId = 'synthetic-foreign';
  const current = f.connect(); const result = receipt();
  f.handler.mockImplementation(async (command) => command.method === 'status' ? { kind: 'status', receipt: result } : { kind: 'abort-result', requested: true });
  await f.manager.reconcile(current.connectionId, current.signal);
  Reflect.set(result, 'runId', 'synthetic-mutated');
  const exposed = operation.receipt!; Reflect.set(exposed.identity, 'operationId', 'synthetic-other');
  expect(operation.receipt?.identity).toEqual(identity());
  expect(operation.receipt?.runId).toBe('synthetic-run');
  expect(operation.identity).toEqual(identity());
});

test('retirement during an abort reply preserves recovery of the other executions', async () => {
  const f = fixture(); const operation = f.track(); const sibling = f.track('synthetic-sibling', 'synthetic-second');
  await operation.interrupt(); const current = f.connect();
  const sent = Promise.withResolvers<void>(); const reply = Promise.withResolvers<NodeExecutionResult>();
  f.handler.mockImplementation(async (command) => {
    if (command.method === 'status') return { kind: 'status', receipt: receipt({ identity: command.identity }) };
    sent.resolve(); return reply.promise;
  });
  const recovery = f.manager.reconcile(current.connectionId, current.signal);
  await sent.promise; operation.retire(); reply.resolve({ kind: 'abort-result', requested: true });
  await expect(recovery).resolves.toBeUndefined();
  expect(operation.receipt).toBeNull(); expect(sibling.receipt?.identity).toEqual(sibling.identity);
  expect(f.calls.map(({ command }) => command.method)).toEqual(['status', 'abort-run', 'status']);
});

test('foreign receipts and uncertain status replies cannot complete recovery or trigger Stop', async () => {
  const f = fixture(); const operation = f.track();
  await operation.interrupt(); const current = f.connect();
  f.handler.mockImplementationOnce(async () => ({ kind: 'status', receipt: receipt({ identity: identity('synthetic-foreign') }) }));
  await expect(f.manager.reconcile(current.connectionId, current.signal)).rejects.toThrow('identity');
  f.handler.mockImplementationOnce(async () => ({ kind: 'unknown' }));
  await expect(f.manager.reconcile(current.connectionId, current.signal)).rejects.toThrow('unavailable');
  expect(f.aborts()).toEqual([]);
});

test('reentrant attachment cannot overwrite the connection installed by validation', async () => {
  const f = fixture(); const first = f.connection(); const replacement = f.connection();
  await f.track().interrupt();
  expect(() => f.manager.attach({ ...first, validate() { f.manager.attach(replacement); } })).toThrow('unavailable');
  await f.manager.reconcile(replacement.connectionId, replacement.signal);
  expect(f.aborts()).toHaveLength(1);
});

test('logical closure cannot retain or reuse controller receipts', async () => {
  const f = fixture(); const operation = f.track(); const current = f.connect();
  await f.manager.reconcile(current.connectionId, current.signal);
  f.lifetime.abort();
  expect(operation.receipt).toBeNull(); expect(await operation.interrupt()).toBe(false);
  expect(() => f.track()).toThrow();
  expect(() => f.manager.attach(f.connection())).toThrow();
});
