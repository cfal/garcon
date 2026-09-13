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

function fixture(instanceId = 'synthetic-a', source?: ProviderHistoryImportService, maxIdentities = 4096) {
  const lifetime = new AbortController(); let physical = new AbortController(); let attempt = 'synthetic-bulk-a'; let admitting = true;
  const instance = { nodeId: 'synthetic-node', instanceId };
  const resources = new NodeExecutionResources(instance.nodeId);
  resources.register({ location: { ...instance, workspaceId: 'synthetic-workspace' }, projectPath: `/synthetic/${instanceId}`, execution: null,
    files: { inspectProject: async () => ({ kind: 'unavailable', reason: 'missing' }) } });
  const capacity = new NodeProviderCapacity(2, 1);
  const occupancy = new NodeNativeOccupancy(2);
  const read = mock((_request: ProviderHistoryImportRequest, _signal: AbortSignal) => (async function* () { yield [row]; })());
  const memory = new NodeHistoryMemoryBudget(1024 * 1024);
  const host = new NodeProviderHistoryImportHost({ instance, session, agentId: 'synthetic', signal: lifetime.signal,
    capacity, occupancy, memory, resources, facets: { native: source ?? { read }, legacy: null }, maxIdentities,
    assertAdmission() { if (!admitting) throw new Error('Synthetic suspended admission'); },
    capture(target) {
      const captured = physical;
      if (target.bulkAttemptId !== attempt || target.connectionId !== 1) throw new Error('Synthetic physical mismatch');
      return { signal: captured.signal, validate: () => captured.signal.throwIfAborted(), transfer: async () => {} };
    },
  });
  const command = (operationId = 'synthetic-operation'): Extract<NodeProviderHistoryCommand, { operation: 'open' }> => ({
    method: 'provider-history-import', operation: 'open', identity: { ...session, operationId }, instanceId, connectionId: 1, bulkAttemptId: attempt,
    workspaceId: 'synthetic-workspace', facet: 'native', chat: { chatId: '1000000000000001', agentId: 'synthetic', agentSessionId: 'colliding-native-id',
      model: '', nativeSession: null, carryOverRevision: '', nativeSeedReceipt: null, settings: null },
  });
  const target = () => { const { method, identity, instanceId, connectionId, bulkAttemptId } = command(); return { method, identity, instanceId, connectionId, bulkAttemptId }; };
  return { host, command, target, lifetime, resources, read, capacity, occupancy, memory,
    call: (command: NodeProviderHistoryCommand) => host.execute(command, new AbortController().signal, new NodeDeadline(60_000)),
    suspend() { admitting = false; },
    replaceBulk() { physical.abort(new Error('Synthetic bulk replaced')); physical = new AbortController(); attempt = 'synthetic-bulk-b'; },
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
    expect(await a.call({ ...a.command('foreign-instance'), instanceId: 'synthetic-b' })).toMatchObject({ operation: 'failed', code: 'NODE_HISTORY_INVALID' });
    expect(a.read).toHaveBeenCalledTimes(1);
  } finally { a.host.close(); b.host.close(); await tick(); }
  expect(a.occupancy.active + b.occupancy.active).toBe(0);
});

test('legacy and native facets remain separate and identities cannot reopen after a lost open reply', async () => {
  const f = fixture();
  expect(await f.call({ ...f.command('legacy'), facet: 'legacy' })).toMatchObject({ operation: 'failed', code: 'NODE_HISTORY_UNAVAILABLE' });
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
  expect(await f.call(f.command('new-operation'))).toMatchObject({ operation: 'failed', code: 'NODE_CAPACITY' });
  pending.resolve({ done: true, value: undefined }); await tick();
  expect(await f.call({ ...original, operation: 'cancel' })).toMatchObject({ operation: 'cancelled', settled: true });
  expect(f.occupancy.active).toBe(0); f.host.close();
});

test('cleanup consumes unknown identities and exhausted tombstones never permit redispatch', async () => {
  const f = fixture('synthetic-a', undefined, 1);
  expect(await f.call({ ...f.target(), operation: 'cancel' })).toMatchObject({ operation: 'cancelled', settled: true });
  expect(await f.call(f.command())).toMatchObject({ operation: 'failed', code: 'NODE_HISTORY_INVALID' });
  expect(await f.call(f.command('second'))).toMatchObject({ operation: 'failed', code: 'NODE_CAPACITY' });
  expect(f.read).not.toHaveBeenCalled(); f.host.close();
});
