import { afterEach, expect, test } from 'bun:test';
import type { WorkflowMutation, WorkflowAttemptResult } from '../../../../common/workflows.js';
import { WorkflowAttempts } from '../attempts.js';
import { readWorkflowCommitSources } from '../commit-inputs.js';
import { workflowEffectiveInput, workflowStartInput, workflowDigest } from '../inputs.js';
import { WorkflowResources } from '../resources.js';
import { WorkflowService } from '../service.js';
import { browser, effectFence, fixture, local, prepareManagedTarget } from './fixture.js';
import { integrationPlan, now, observedRepository } from './integration-fixture.js';

const fixtures: ReturnType<typeof fixture>[] = [];
afterEach(() => fixtures.splice(0).forEach(f => f.cleanup()));
function setup() {
  const f = fixture(); fixtures.push(f);
  const plan = integrationPlan(1);
  const id = f.write({ action: 'create', captainChatId: null, plan }).workflowId;
  f.activate(id);
  const attempts = new WorkflowAttempts(f.store, { now });
  const resources = new WorkflowResources(f.store, now);
  const task = plan.tasks[0]!;
  let attempt = attempts.beginPreparation(attempts.reserve(id, task.id)!.attemptId);
  attempt = attempts.bindTarget(attempt.attemptId, prepareManagedTarget(resources, attempt));
  attempt = attempts.bindPrepared(attempt.attemptId, { serverInstanceId: 'old-controller', chatId: '1234567890123456',
    turnId: 'synthetic-turn', clientRequestId: attempt.requestId }, workflowEffectiveInput(workflowStartInput(attempt, task)));
  attempts.markDispatching(attempt.attemptId, effectFence());
  const result: WorkflowAttemptResult = { certainty: 'definite', termination: 'observed', detail: 'Terminal persisted before crash.',
    commandOutcome: null, executionScope: { executorId: 'local', instanceId: attempt.managedTarget!.instanceId },
    receivedOutputCoverage: 'gapped', outputCaptured: false };
  attempts.observe(attempt.attemptId, { resolution: 'checking', result, retainControl: true }, effectFence());
  attempts.holdOutput(attempt.attemptId, 'Output capture lost.', effectFence());
  attempts.releaseControl(attempt.attemptId, effectFence());
  const repository = { ...observedRepository(attempt.managedTarget!), instanceId: 'replacement-runtime' };
  let observations = 0;
  const hooks = { async beforeObserve() {}, assertCurrent() {} };
  const service = new WorkflowService(f.store, { enabled: () => f.controls.enabled, now,
    async observeAdoption() { observations++; await hooks.beforeObserve(); return { kind: 'commit', repository, assertCurrent: () => hooks.assertCurrent() }; } });
  const mutation: WorkflowMutation = { action: 'resolve', workflowId: id, taskId: task.id, generation: 1,
    attemptId: attempt.attemptId, resolution: 'adopt', commit: repository.commit.commit, releaseRisk: false, evidence: 'Independent operator inspection.' };
  const request = { expectedStoreId: service.bootstrap().storeId, operationId: crypto.randomUUID(), mutation };
  return { ...f, id, service, attempts, attempt, repository, request, hooks, result,
    observations: () => observations, run: () => service.executeHttp(request, browser) };
}

test('disabled adoption after runtime restart preserves original evidence and feeds an exact downstream commit', async () => {
  const f = setup(); f.controls.enabled = false;
  const before = f.attempts.get(f.attempt.attemptId).result;
  const result = await f.run();
  expect(await f.run()).toEqual(result);
  expect(f.observations()).toBe(1);
  expect(f.attempts.get(f.attempt.attemptId)).toMatchObject({ resolution: 'succeeded', controlState: 'released', result: before });
  expect(f.service.detail(f.id).artifacts).toMatchObject([{ kind: 'commit', provenance: 'operator-attested', outcome: 'pass',
    receivedOutputCoverage: 'gapped', git: { scope: 'operator-adopted', runtimeInstanceId: 'replacement-runtime' } }]);
  const downstream = f.attempts.reserve(f.id, 'integrate')!;
  expect(downstream).not.toBeNull();
  const task = integrationPlan(1).tasks[1]!;
  const sources = f.store.read(db => readWorkflowCommitSources(db, downstream, task));
  expect(sources[0]).toMatchObject({ input: { commit: f.repository.commit.commit }, managed: { instanceId: 'replacement-runtime' } });
  expect(f.attempts.get(f.attempt.attemptId).managedTarget!.instanceId).toBe('synthetic-runtime');
});

test.each(['dirty', 'head', 'marker', 'lineage', 'executor', 'busy', 'authority', 'generation', 'unknown-termination', 'unknown-operation'] as const)(
  'adoption rejects %s without artifacts or a mutation receipt', async fault => {
    const f = setup();
    if (fault === 'dirty') f.repository.managed.dirty = true;
    if (fault === 'head') f.repository.managed.head = 'f'.repeat(40);
    if (fault === 'marker') f.repository.managed.operationId = 'replaced';
    if (fault === 'lineage') f.repository.commit.containsAncestor = false;
    if (fault === 'executor') f.repository.executorId = 'other';
    if (fault === 'busy') f.hooks.assertCurrent = () => { throw new Error('Manual execution started.'); };
    if (fault === 'generation') f.hooks.beforeObserve = async () => {
      f.store.transaction(db => db.query('UPDATE tasks SET generation=generation+1 WHERE workflow_id=?').run(f.id));
    };
    if (fault === 'unknown-termination') f.store.transaction(db => db.query('UPDATE attempts SET result_json=? WHERE id=?')
      .run(JSON.stringify({ ...f.result, termination: 'unknown' }), f.attempt.attemptId));
    if (fault === 'unknown-operation') f.store.transaction(db => db.query("UPDATE operation_intents SET status='unknown' WHERE attempt_id=?").run(f.attempt.attemptId));
    await expect(fault === 'authority' ? f.service.executeHttp(f.request, local) : f.run()).rejects.toThrow();
    expect(f.service.detail(f.id).artifacts).toHaveLength(0);
    expect(f.service.operation(f.request.operationId, browser)).toEqual({ kind: 'not-found' });
  },
);

test('revocation during independent observation prevents commit', async () => {
  const f = setup(); let authorized = true;
  f.hooks.beforeObserve = async () => { authorized = false; };
  await expect(f.service.executeHttp(f.request, { ...browser, assertCurrent() { if (!authorized) throw new Error('Revoked'); } })).rejects.toThrow('Revoked');
  expect(f.service.detail(f.id).artifacts).toHaveLength(0);
});

test('storage replacement during independent observation rejects without artifacts or receipt', async () => {
  const f = setup();
  f.hooks.beforeObserve = async () => { f.store.transaction(db => db.query('UPDATE workflow_metadata SET store_id=?').run(crypto.randomUUID())); };
  await expect(f.run()).rejects.toThrow('storage identity changed');
  expect(f.service.detail(f.id).artifacts).toHaveLength(0);
  expect(f.service.operation(f.request.operationId, browser)).toEqual({ kind: 'not-found' });
});

test('conflicting and expired adoption identities never re-observe', async () => {
  const f = setup(); await f.run();
  await expect(f.service.executeHttp({ ...f.request, mutation: { ...f.request.mutation, evidence: 'Changed' } }, browser)).rejects.toThrow();
  f.service.expireResult(f.request.operationId);
  await expect(f.run()).rejects.toThrow('expired');
  expect(f.observations()).toBe(1);
});

test('adoption retains earlier unknown evidence and selects exactly one newly accepted commit', async () => {
  const f = setup();
  const historical = { id: crypto.randomUUID(), attempt: { workflowId: f.id, taskId: f.attempt.taskId,
    generation: 1, attemptId: f.attempt.attemptId, inputDigest: f.attempt.inputDigest }, kind: 'commit', provenance: 'runtime-observed',
    outcome: 'unknown', executorId: 'local', repositoryId: f.attempt.target!.repositoryId, commit: null, dirty: null,
    summary: 'Synthetic prior incomplete observation.', url: null, commandOutcome: null, receivedOutputCoverage: 'gapped',
    observedAt: now(), git: null };
  const payload = JSON.stringify({ ...historical, digest: workflowDigest(historical) });
  f.store.transaction(db => db.query('INSERT INTO artifacts VALUES (?,?,?)').run(historical.id, f.attempt.attemptId, payload));
  await f.run();
  expect(f.store.read(db => db.query<{ payload_json: string }, [string]>('SELECT payload_json FROM artifacts WHERE id=?').get(historical.id)!.payload_json)).toBe(payload);
  const downstream = f.attempts.reserve(f.id, 'integrate')!;
  const sources = f.store.read(db => readWorkflowCommitSources(db, downstream, integrationPlan(1).tasks[1]!));
  expect(sources).toHaveLength(1);
  expect(sources[0]!.input.commit).toBe(f.repository.commit.commit);
});
