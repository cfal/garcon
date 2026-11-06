import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import type { WorkflowAttempt, WorkflowPlan, WorkflowRevocationKind } from '../../../../common/workflows.js';
import { WorkflowAttempts } from '../attempts.js';
import type { WorkflowDispatchPort, WorkflowEffectFence } from '../contracts.js';
import { WorkflowReconciler } from '../reconciler.js';
import { fixture, plan } from './fixture.js';

const fixtures: ReturnType<typeof fixture>[] = [];
const reconcilers: WorkflowReconciler[] = [];
const now = () => '2026-01-01T00:00:00.000Z';
function setup(input: WorkflowPlan = plan()) {
  const f = fixture(); fixtures.push(f);
  const id = f.write({ action: 'create', plan: input, captainChatId: null }).workflowId; f.activate(id);
  const attempts = new WorkflowAttempts(f.store, { now });
  const observations: { attempt: WorkflowAttempt; fence: WorkflowEffectFence }[] = [];
  const finish = Promise.withResolvers<void>();
  const port = {
    available: mock(() => true),
    dispatch: mock(async (attempt: WorkflowAttempt, fence: WorkflowEffectFence) => { observations.push({ attempt, fence }); await finish.promise; }),
    stop: mock(async (_attempt: WorkflowAttempt, _kind: WorkflowRevocationKind) => {}),
  } satisfies WorkflowDispatchPort;
  const failures: unknown[] = [];
  const yielded = mock(async () => {});
  const reconciler = new WorkflowReconciler(f.store, attempts, port, { now, onFailure: error => failures.push(error), yield: yielded });
  reconcilers.push(reconciler);
  return { ...f, id, attempts, observations, finish, port, failures, yielded, reconciler };
}
afterEach(() => {
  reconcilers.splice(0).forEach(reconciler => reconciler.beginShutdown());
  fixtures.splice(0).forEach(f => f.cleanup());
});

test('disabled construction has no admissions and coalesced wakeups dispatch exactly once', async () => {
  const f = setup();
  for (let index = 0; index < 20; index++) f.reconciler.wake(f.id);
  await f.reconciler.flush();
  expect(f.service.attempts(f.id)).toEqual([]);
  f.reconciler.start();
  for (let index = 0; index < 20; index++) f.reconciler.wake(f.id);
  await f.reconciler.flush();
  expect(f.observations).toHaveLength(1);
  expect(f.service.attempts(f.id)).toHaveLength(1);
  f.reconciler.beginShutdown(); f.finish.resolve(); await f.reconciler.waitForSettlements();
});

test('offline targets remain blocked without consuming admission retries', async () => {
  const f = setup(); f.port.available.mockReturnValue(false);
  f.reconciler.start(); await f.reconciler.flush();
  expect(f.service.attempts(f.id)).toEqual([]);
  f.port.available.mockReturnValue(true);
  f.reconciler.wake(); await f.reconciler.flush();
  expect(f.observations).toHaveLength(1);
  f.reconciler.beginShutdown(); f.finish.resolve(); await f.reconciler.waitForSettlements();
});

test('at most two tasks per executor dispatch while unknown attempts retain capacity', async () => {
  const original = plan(); const first = original.tasks[0]!;
  const f = setup({ ...original, tasks: [first, { ...first, id: 'second' }, { ...first, id: 'third' }] });
  f.reconciler.start(); await f.reconciler.flush();
  expect(f.observations).toHaveLength(2);
  f.attempts.observe(f.observations[0]!.attempt.attemptId, { resolution: 'unknown', result: { certainty: 'unknown',
    detail: 'Synthetic lost result.', commandOutcome: null, receivedOutputCoverage: 'unknown', outputCaptured: false, termination: 'unknown' } }, { revoked: false, reason: null });
  f.finish.resolve(); await f.reconciler.waitForSettlements();
  await f.reconciler.flush();
  expect(f.observations).toHaveLength(2);
  expect(f.service.attempts(f.id)).toHaveLength(2);
});

test('revocation synchronously fences effects without writing workflow storage', async () => {
  const f = setup(); f.reconciler.start(); await f.reconciler.flush();
  expect(f.observations[0]!.fence.revoked).toBe(false);
  f.controls.failCommit = true;
  expect(() => f.reconciler.revoke(f.id)).not.toThrow();
  expect(f.observations[0]!.fence.revoked).toBe(true);
  f.reconciler.beginShutdown(); f.finish.resolve(); await f.reconciler.waitForSettlements();
});

test('pausing admissions drains in-flight work without revoking its output observation', async () => {
  const f = setup(); f.reconciler.start(); await f.reconciler.flush();
  f.reconciler.pauseAdmission();
  expect(f.observations[0]!.fence.revoked).toBe(false);
  expect(f.observations[0]!.fence.shutdown.aborted).toBe(false);
  f.finish.resolve(); await f.reconciler.waitForSettlements();
  expect(f.observations).toHaveLength(1);
});

test('Stop requests are coalesced against captured attempts and persist no implicit replacement', async () => {
  const f = setup(); const stopped = Promise.withResolvers<void>();
  f.port.stop.mockImplementation(() => stopped.promise);
  f.reconciler.start(); await f.reconciler.flush();
  f.reconciler.stopRunning(f.id); f.reconciler.stopRunning(f.id);
  expect(f.observations[0]!.fence.revoked).toBe(true);
  await Promise.resolve();
  expect(f.port.stop).toHaveBeenCalledTimes(1);
  expect(f.port.stop.mock.calls[0]![0].attemptId).toBe(f.observations[0]!.attempt.attemptId);
  f.reconciler.beginShutdown(); stopped.resolve(); f.finish.resolve(); await f.reconciler.waitForSettlements();
});

test('unclassified dispatch failure fences scheduling and holds the exact attempt', async () => {
  const f = setup(); f.port.dispatch.mockRejectedValueOnce(new Error('Synthetic unclassified dispatch failure.'));
  f.reconciler.start(); await f.reconciler.waitForSettlements();
  expect(f.failures).toHaveLength(1);
  expect(f.service.detail(f.id).tasks[0]).toMatchObject({ hold: 'intervention', phase: 'outcome-unknown' });
  expect(f.service.attempts(f.id)[0]?.resolution).toBe('unknown');
  f.reconciler.start(); f.reconciler.wake(); await f.reconciler.flush();
  expect(f.port.dispatch).toHaveBeenCalledTimes(1);
});

test('large candidate passes yield every 32 tasks rather than blocking ordinary work', async () => {
  const original = plan(); const first = original.tasks[0]!;
  const f = setup({ ...original, goal: { kind: 'artifacts', taskIds: ['task-0'] },
    tasks: Array.from({ length: 100 }, (_, index) => ({ ...first, id: `task-${index}` })) });
  f.port.available.mockReturnValue(false);
  f.reconciler.start(); await f.reconciler.flush();
  expect(f.port.available).toHaveBeenCalledTimes(100);
  expect(f.yielded.mock.calls.length).toBeGreaterThanOrEqual(4);
  expect(f.service.attempts(f.id)).toEqual([]);
});

test('candidate yield budget spans multiple small workflows', async () => {
  const original = plan();
  const input = { ...original, tasks: Array.from({ length: 20 }, (_, index) => ({ ...original.tasks[0]!, id: index ? `task-${index}` : 'check' })) };
  const f = setup(input);
  for (let index = 0; index < 3; index++) {
    const id = f.write({ action: 'create', plan: input, captainChatId: null }).workflowId; f.activate(id);
  }
  let sinceYield = 0; let largest = 0;
  f.port.available.mockImplementation(() => { largest = Math.max(largest, ++sinceYield); return false; });
  f.yielded.mockImplementation(async () => { sinceYield = 0; });
  f.reconciler.start(); await f.reconciler.flush();
  expect(f.port.available).toHaveBeenCalledTimes(80); expect(largest).toBeLessThanOrEqual(32);
});

test('replanning one branch leaves the other in-flight effect fence intact', async () => {
  const original = plan(); const first = original.tasks[0]!;
  const input = { ...original, tasks: [first, { ...first, id: 'second' }] };
  const f = setup(input); f.reconciler.start(); await f.reconciler.flush();
  f.write({ action: 'plan', workflowId: f.id, expectedPlanRevision: 1,
    plan: { ...input, tasks: [first, { ...first, id: 'second', title: 'Changed' }] } });
  f.activate(f.id); f.reconciler.refreshControl(f.id);
  expect(f.observations.find(item => item.attempt.taskId === 'check')!.fence.revoked).toBe(false);
  expect(f.observations.find(item => item.attempt.taskId === 'second')!.fence).toMatchObject({ revoked: true, revocationKind: 'superseded' });
  await Promise.resolve();
  expect(f.port.stop).toHaveBeenCalledTimes(1);
  expect(f.port.stop.mock.calls[0]).toEqual([expect.objectContaining({ taskId: 'second', revocationKind: 'superseded' }), 'superseded']);
  f.reconciler.beginShutdown(); f.finish.resolve(); await f.reconciler.waitForSettlements();
});

test('one stale task input holds that task without stopping unrelated admissions', async () => {
  const original = plan(); const first = original.tasks[0]!;
  const f = setup({ ...original, tasks: [first, { ...first, id: 'second' }] });
  const old = f.attempts.reserve(f.id, 'check')!;
  f.attempts.observe(old.attemptId, { resolution: 'not-started', result: { certainty: 'not-started',
    detail: 'Synthetic admission rejection.', commandOutcome: null, receivedOutputCoverage: 'unknown',
    outputCaptured: false, termination: 'not-started' } }, { revoked: false, reason: null });
  f.store.transaction(db => db.query("UPDATE tasks SET input_digest='sha256:stale',next_eligible_at=NULL WHERE workflow_id=? AND id='check'").run(f.id));
  f.reconciler.start(); await f.reconciler.flush();
  expect(f.failures).toEqual([]);
  expect(f.service.detail(f.id).tasks.find(task => task.id === 'check')?.hold).toBe('output-unknown');
  expect(f.observations.map(item => item.attempt.taskId)).toEqual(['second']);
  f.reconciler.beginShutdown(); f.finish.resolve(); await f.reconciler.waitForSettlements();
});

test.each([1, 2])('fan-out stops reserving once workflow concurrency %s is full', async concurrency => {
  const original = plan();
  const f = setup({ ...original, policy: { ...original.policy, concurrency },
    tasks: Array.from({ length: 256 }, (_, index) => ({ ...original.tasks[0]!, id: index ? `task-${index}` : 'check' })) });
  const reserve = spyOn(f.attempts, 'reserve');
  f.reconciler.start(); await f.reconciler.flush();
  expect(reserve).toHaveBeenCalledTimes(concurrency);
  for (let index = 0; index < 3; index++) { f.reconciler.wake(f.id); await f.reconciler.flush(); }
  expect(reserve).toHaveBeenCalledTimes(concurrency);
  f.reconciler.beginShutdown(); f.finish.resolve(); await f.reconciler.waitForSettlements();
});

test('executor capacity skips blocked fan-out while another executor remains admissible', async () => {
  const original = plan(); const first = original.tasks[0]!;
  if (first.spec.kind !== 'command') throw new Error('Expected command fixture.');
  const f = setup({ ...original, tasks: [first, { ...first, id: 'second' }] });
  f.attempts.reserve(f.id, 'check'); f.attempts.reserve(f.id, 'second');
  const tasks = Array.from({ length: 64 }, (_, index) => ({ ...first, id: `task-${index}` }));
  tasks.push({ ...first, id: 'other-executor', spec: { ...first.spec,
    target: { ...first.spec.target, executorId: '11111111-1111-4111-8111-111111111111' } } });
  const other = f.write({ action: 'create', captainChatId: null,
    plan: { ...original, tasks, goal: { kind: 'artifacts', taskIds: ['other-executor'] } } }).workflowId;
  f.activate(other);
  const reserve = spyOn(f.attempts, 'reserve');
  f.reconciler.start(); await f.reconciler.flush();
  expect(reserve).toHaveBeenCalledTimes(1);
  expect(f.observations.map(item => item.attempt.taskId)).toEqual(['other-executor']);
  f.reconciler.beginShutdown(); f.finish.resolve(); await f.reconciler.waitForSettlements();
});
