import { expect, mock, test } from 'bun:test';
import type { AgentSessionConfigurationPrepareRequest } from '@garcon/server-agent-interface';
import { SessionConfigurationNotDeliveredError, SessionConfigurationPreparations } from '../session-configuration.js';

function request(signal = new AbortController().signal): AgentSessionConfigurationPrepareRequest {
  const configuration = { model: 'synthetic-model', permissionMode: 'default' as const, thinkingMode: 'none' as const,
    settings: { ownerId: 'synthetic-provider', schemaVersion: 1, values: { nested: { value: 'saved' } } }, endpoint: null };
  return { expected: { chatId: '1000000000000001', agentSessionId: 'synthetic-session',
    projectPath: '/synthetic/project', nativeSession: { ownerId: 'synthetic-provider', schemaVersion: 1, value: { id: 'synthetic-native' } } },
    previous: structuredClone(configuration), next: structuredClone(configuration), signal };
}

async function prepare(service: SessionConfigurationPreparations, input = request()) {
  const prepared = await service.prepare(input);
  if (prepared.kind !== 'prepared') throw new Error('Expected a captured configuration target');
  return prepared.target;
}

test('configuration preparation owns snapshots and performs no mutation before commit', async () => {
  const input = request();
  let captured: AgentSessionConfigurationPrepareRequest | undefined;
  const mutation = mock(() => undefined);
  const service = new SessionConfigurationPreparations((snapshot) => {
    captured = snapshot;
    return { validate: () => true, async deliver(beforeMutation) { beforeMutation(); mutation(); return 'applied'; } };
  });
  const target = await prepare(service, input);
  input.next.settings.values.nested = { value: 'changed' };
  expect(captured?.next.settings.values.nested).toEqual({ value: 'saved' });
  expect(captured?.signal).toBe(input.signal);
  expect(mutation).not.toHaveBeenCalled();
  expect(Object.keys(target)).toEqual([]);
  expect(await service.commit(target, input.signal)).toEqual({ kind: 'applied' });
  expect(mutation).toHaveBeenCalledTimes(1);
  expect(await service.commit(target, input.signal)).toEqual({ kind: 'rejected', reason: 'target-changed' });
  service.cancel(target);
});

test('absence is persistable while a conflicting native target is rejected', async () => {
  const absent = new SessionConfigurationPreparations(() => null);
  expect(await absent.prepare(request())).toEqual({ kind: 'not-required' });
  const conflicting = new SessionConfigurationPreparations(() => ({ kind: 'rejected', reason: 'target-conflict' }));
  expect(await conflicting.prepare(request())).toEqual({ kind: 'rejected', reason: 'target-conflict' });
});

test('configuration cancellation and foreign tokens never reach a provider mutation', async () => {
  const mutation = mock(() => undefined);
  const service = new SessionConfigurationPreparations(() => ({ validate: () => true,
    async deliver(beforeMutation) { beforeMutation(); mutation(); return 'applied'; } }));
  const cancelled = new AbortController();
  const abandoned = await prepare(service, request(cancelled.signal));
  cancelled.abort();
  const explicit = await prepare(service);
  service.cancel(explicit);
  service.cancel(explicit);
  for (const target of [abandoned, explicit, {}]) {
    expect(await service.commit(target, new AbortController().signal)).toEqual({ kind: 'rejected', reason: 'target-changed' });
  }
  const other = new SessionConfigurationPreparations(() => null);
  expect(await other.commit(await prepare(service), new AbortController().signal)).toEqual({ kind: 'rejected', reason: 'target-changed' });
  expect(mutation).not.toHaveBeenCalled();
});

test.each(['replaced', 'reused', 'absent'] as const)('revalidates a queued settings target before mutation: %s', async (change) => {
  const original = { revision: 0 };
  let current: typeof original | null = original;
  const entered = Promise.withResolvers<void>();
  const queue = Promise.withResolvers<void>();
  const mutation = mock(() => undefined);
  const service = new SessionConfigurationPreparations(() => {
    const capturedRevision = original.revision;
    return { validate: () => current === original && current.revision === capturedRevision,
      async deliver(beforeMutation) {
        entered.resolve();
        await queue.promise;
        beforeMutation();
        mutation();
        return 'applied';
      } };
  });
  const target = await prepare(service);
  const pending = service.commit(target, new AbortController().signal);
  await entered.promise;
  if (change === 'replaced') current = { revision: 0 };
  else if (change === 'reused') original.revision += 1;
  else current = null;
  queue.resolve();
  expect(await pending).toEqual({ kind: 'rejected', reason: 'target-changed' });
  expect(mutation).not.toHaveBeenCalled();
});

test('cancellation while queued is definitive non-delivery', async () => {
  const queued = Promise.withResolvers<void>();
  const controller = new AbortController();
  const mutation = mock(() => undefined);
  const service = new SessionConfigurationPreparations(() => ({ validate: () => true,
    async deliver(beforeMutation) { await queued.promise; beforeMutation(); mutation(); return 'applied'; } }));
  const pending = service.commit(await prepare(service), controller.signal);
  controller.abort();
  queued.resolve();
  expect(await pending).toEqual({ kind: 'rejected', reason: 'cancelled' });
  expect(mutation).not.toHaveBeenCalled();
});

test.each(['confirmed', 'failed'] as const)('cancellation after delivery retains its actual outcome: %s', async (outcome) => {
  const controller = new AbortController();
  const delivered = Promise.withResolvers<void>();
  const settled = Promise.withResolvers<void>();
  const service = new SessionConfigurationPreparations(() => ({ validate: () => true,
    async deliver(beforeMutation) {
      beforeMutation();
      delivered.resolve();
      await settled.promise;
      if (outcome === 'failed') throw new Error('Synthetic native confirmation loss');
      return 'applied';
    } }));
  const target = await prepare(service, request(controller.signal));
  const pending = service.commit(target, controller.signal);
  await delivered.promise;
  controller.abort();
  service.cancel(target);
  settled.resolve();
  expect(await pending).toEqual({ kind: outcome === 'confirmed' ? 'applied' : 'unknown' });
});

test('a partial mutation cannot become a definite rejection or an absent-target result', async () => {
  let current = true;
  const service = new SessionConfigurationPreparations(() => ({ validate: () => current,
    async deliver(beforeMutation) { beforeMutation(); current = false; beforeMutation(); return 'applied'; } }));
  expect(await service.commit(await prepare(service), new AbortController().signal)).toEqual({ kind: 'unknown' });
  const noOp = new SessionConfigurationPreparations(() => ({ validate: () => true,
    async deliver(beforeMutation) { beforeMutation(); return 'not-required'; } }));
  expect(await noOp.commit(await prepare(noOp), new AbortController().signal)).toEqual({ kind: 'unknown' });
});

test('idle-dependent deferral revalidates after its asynchronous decision', async () => {
  let current = true;
  const gate = Promise.withResolvers<void>();
  const service = new SessionConfigurationPreparations(() => ({ validate: () => current,
    async deliver() { await gate.promise; return 'not-required'; } }));
  const pending = service.commit(await prepare(service), new AbortController().signal);
  current = false;
  gate.resolve();
  expect(await pending).toEqual({ kind: 'rejected', reason: 'target-changed' });
});

test.each([false, true])('provider non-delivery rejection respects an earlier mutation: %s', async (mutated) => {
  const service = new SessionConfigurationPreparations(() => ({ validate: () => true,
    async deliver(beforeMutation) {
      if (mutated) beforeMutation();
      throw new SessionConfigurationNotDeliveredError('target-changed');
    } }));
  expect(await service.commit(await prepare(service), new AbortController().signal))
    .toEqual(mutated ? { kind: 'unknown' } : { kind: 'rejected', reason: 'target-changed' });
});
