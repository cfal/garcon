import { afterEach, expect, test } from 'bun:test';
import { WorkflowAttempts } from '../attempts.js';
import { recoverWorkflowAttempts } from '../recovery.js';
import { WorkflowResources } from '../resources.js';
import { effectFence, fixture, managedTarget } from './fixture.js';
import { managedTargetRequest } from '../managed-target.js';

const fixtures: ReturnType<typeof fixture>[] = [];
const now = () => '2026-01-01T00:00:00.000Z';
const clear = effectFence();
function setup() {
  const f = fixture(); fixtures.push(f);
  const id = f.create().workflowId; f.activate(id);
  const attempts = new WorkflowAttempts(f.store, { now });
  const attempt = attempts.reserve(id, 'check')!; attempts.beginPreparation(attempt.attemptId);
  const resources = new WorkflowResources(f.store, now);
  const resource = managedTarget(attempt, 'synthetic-resource');
  const input = { operationId: resource.operationId, attemptId: attempt.attemptId,
    kind: 'worktree' as const, resourceKey: resource.resourceKey, payload: JSON.stringify(managedTargetRequest(resource)) };
  return { ...f, get store() { return f.store; }, get service() { return f.service; }, id, attempts, attempt, resources, input, resource };
}
afterEach(() => fixtures.splice(0).forEach(f => f.cleanup()));

test('creation intent and exclusive claim commit before any external dispatch', () => {
  const f = setup();
  expect(() => f.attempts.bindTarget(f.attempt.attemptId, f.resource)).toThrow('creation intent');
  const operation = f.resources.plan(f.input);
  expect(operation.status).toBe('planned');
  expect(f.store.read(db => db.query('SELECT attempt_id FROM resource_claims').all())).toEqual([{ attempt_id: f.attempt.attemptId }]);
  expect(() => f.attempts.bindTarget(f.attempt.attemptId, f.resource)).toThrow('creation intent');
  expect(f.resources.begin(operation.id, clear).status).toBe('dispatching');
  f.resources.observe(operation.id, 'succeeded', JSON.stringify(f.resource));
  expect(f.attempts.bindTarget(f.attempt.attemptId, f.resource).target).toEqual(f.resource.target);
});

test('an uncertain effect cannot be repeated or relabeled not-dispatched from absence', () => {
  const f = setup(); const operation = f.resources.plan(f.input);
  f.resources.begin(operation.id, clear);
  f.resources.observe(operation.id, 'unknown', 'Lost reply.');
  expect(() => f.resources.begin(operation.id, clear)).toThrow();
  expect(() => f.resources.observe(operation.id, 'not-started', 'No matching resource.')).toThrow('does not prove');
  expect(() => f.resources.plan({ ...f.input, operationId: crypto.randomUUID() })).toThrow('previous resource');
  expect(f.store.read(db => db.query('SELECT quarantined FROM resource_claims').all())).toEqual([{ quarantined: 1 }]);
});

test('pause or effect revocation prevents resource dispatch without losing the intent', () => {
  const f = setup(); const operation = f.resources.plan(f.input);
  expect(() => f.resources.begin(operation.id, { ...clear, revoked: true, reason: 'Manual takeover.' })).toThrow();
  expect(() => f.resources.begin(operation.id, { ...clear, shutdown: AbortSignal.abort() })).toThrow('shutdown');
  f.write({ action: 'pause', workflowId: f.id });
  expect(() => f.resources.begin(operation.id, clear)).toThrow();
  expect(f.resources.get(operation.id).status).toBe('planned');
});

test('two planned operations cannot mutate an attempt resource concurrently', () => {
  const f = setup(); const first = f.resources.plan(f.input);
  const second = f.resources.plan({ ...f.input, operationId: crypto.randomUUID() });
  f.resources.begin(first.id, clear);
  expect(() => f.resources.begin(second.id, clear)).toThrow('remains unsettled');
  expect(f.resources.get(second.id).status).toBe('planned');
});

test('restart never replays dispatched resource creation', async () => {
  const f = setup(); const operation = f.resources.plan(f.input);
  f.resources.begin(operation.id, clear);
  f.reopen(); await recoverWorkflowAttempts(f.store, now);
  expect(new WorkflowResources(f.store, now).get(operation.id).status).toBe('unknown');
  expect(f.service.attempts(f.id)[0]?.resolution).toBe('not-started');
  expect(f.store.read(db => db.query('SELECT quarantined FROM resource_claims').all())).toEqual([{ quarantined: 1 }]);
  expect(f.service.detail(f.id).tasks[0]).toMatchObject({ phase: 'outcome-unknown', hold: 'output-unknown' });
  f.write({ action: 'resolve', workflowId: f.id, taskId: 'check', generation: 1, attemptId: f.attempt.attemptId,
    resolution: 'abandon', evidence: 'Explicit synthetic resource-risk release.', commit: null, releaseRisk: true });
  f.write({ action: 'retry', workflowId: f.id, taskId: 'check', generation: 1, attemptId: f.attempt.attemptId });
  expect(new WorkflowAttempts(f.store, { now }).reserve(f.id, 'check')).not.toBeNull();
});

test('restart safely settles an intent that never reached its dispatch boundary', async () => {
  const f = setup(); const operation = f.resources.plan(f.input);
  f.reopen(); await recoverWorkflowAttempts(f.store, now);
  expect(new WorkflowResources(f.store, now).get(operation.id).status).toBe('not-started');
  expect(f.store.read(db => db.query('SELECT * FROM resource_claims').all())).toEqual([]);
});

test('operator-confirmed chat non-start does not release a separate unknown Git operation', async () => {
  const f = setup(); const operation = f.resources.plan(f.input);
  f.resources.begin(operation.id, clear);
  f.attempts.revoke(f.attempt.attemptId, 'Manual Stop.');
  f.reopen(); await recoverWorkflowAttempts(f.store, now);
  f.write({ action: 'resolve', workflowId: f.id, taskId: 'check', generation: 1,
    attemptId: f.attempt.attemptId, resolution: 'not-started', evidence: 'Synthetic non-execution observation.', commit: null, releaseRisk: false });
  expect(f.store.read(db => db.query('SELECT quarantined FROM resource_claims').all())).toEqual([{ quarantined: 1 }]);
  expect(new WorkflowResources(f.store, now).get(operation.id).status).toBe('unknown');
  expect(f.service.detail(f.id).tasks[0]?.hold).toBe('output-unknown');
  f.write({ action: 'resolve', workflowId: f.id, taskId: 'check', generation: 1,
    attemptId: f.attempt.attemptId, resolution: 'abandon', evidence: 'Synthetic risk release.', commit: null, releaseRisk: true });
  expect(f.service.detail(f.id).tasks[0]?.hold).toBe('none');
});

test('exact resource reconciliation releases capacity without silently clearing operator attention', async () => {
  const f = setup(); const operation = f.resources.plan(f.input);
  f.resources.begin(operation.id, clear); f.reopen(); await recoverWorkflowAttempts(f.store, now);
  new WorkflowResources(f.store, now).observe(operation.id, 'succeeded', JSON.stringify(f.resource));
  expect(f.store.read(db => db.query('SELECT retained,quarantined FROM resource_claims').all())).toEqual([{ retained: 1, quarantined: 0 }]);
  expect(f.service.detail(f.id).tasks[0]?.hold).toBe('output-unknown');
  f.write({ action: 'resolve', workflowId: f.id, taskId: 'check', generation: 1, attemptId: f.attempt.attemptId,
    resolution: 'not-started', evidence: 'Synthetic reconciled repository and non-dispatched chat.', commit: null, releaseRisk: false });
  expect(new WorkflowAttempts(f.store, { now: () => '2026-01-02T00:00:00.000Z' }).reserve(f.id, 'check')).not.toBeNull();
});

test('one successful worktree cannot bind a different planned resource or marker', () => {
  const f = setup(); f.resources.plan(f.input); f.resources.begin(f.input.operationId, clear);
  f.resources.observe(f.input.operationId, 'succeeded', JSON.stringify(f.resource));
  const other = managedTarget(f.attempt, 'other-resource');
  f.resources.plan({ ...f.input, operationId: other.operationId, resourceKey: other.resourceKey,
    payload: JSON.stringify(managedTargetRequest(other)) });
  expect(() => f.attempts.bindTarget(f.attempt.attemptId, other)).toThrow('creation intent');
  expect(() => f.attempts.bindTarget(f.attempt.attemptId, { ...other, operationId: f.resource.operationId })).toThrow('creation intent');
  for (const patch of [{ managedResourceId: 'other-marker' }, { worktreeIdentity: 'other-worktree' },
    { target: { ...f.resource.target, projectPath: f.attempt.target!.projectPath } }]) {
    expect(() => f.attempts.bindTarget(f.attempt.attemptId, { ...f.resource, ...patch })).toThrow('exact creation');
  }
  expect(() => f.attempts.bindTarget(f.attempt.attemptId, { ...f.resource, target: { ...f.resource.target, projectPath: '' } }))
    .toThrow(expect.objectContaining({ code: 'WORKFLOW_CONFLICT' }));
  expect(f.attempts.bindTarget(f.attempt.attemptId, f.resource).managedTarget).toEqual(f.resource);
});

test('unknown storage commit cannot authorize a resource effect', () => {
  const f = setup(); const operation = f.resources.plan(f.input);
  f.controls.failCommit = true;
  expect(() => f.resources.begin(operation.id, clear)).toThrow(expect.objectContaining({ code: 'WORKFLOW_UNAVAILABLE' }));
  f.reopen();
  expect(new WorkflowResources(f.store, now).get(operation.id).status).toBe('planned');
});
