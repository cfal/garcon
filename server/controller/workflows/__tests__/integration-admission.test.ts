import { afterEach, expect, spyOn, test } from 'bun:test';
import { GIT_OPERATION_TIMEOUT_MS } from '../../../../common/git-execution.js';
import type { WorkflowManagedTarget } from '../../../../common/workflows.js';
import type { WorkflowIntegrationRepositoryPort, WorkflowIntegrationResult, WorkflowRepositoryPort } from '../contracts.js';
import { createWorkflowDispatchPort } from '../dispatch.js';
import { WorkflowIntegrationAdmission } from '../integration-admission.js';
import { workflowIntegrationManifest } from '../integration-manifest.js';
import { workflowDigest } from '../inputs.js';
import { readWorkflowCommitSources } from '../commit-inputs.js';
import { recoverWorkflowAttempts, suspendWorkflowAdmission } from '../recovery.js';
import { automaticRetryAllowed } from '../transitions.js';
import { effectFence, prepareManagedTarget } from './fixture.js';
import { integrationFixture, now, observedRepository } from './integration-fixture.js';

const fixtures: ReturnType<typeof integrationFixture>[] = [];
afterEach(() => fixtures.splice(0).forEach(f => f.cleanup()));

async function setup() {
  const f = integrationFixture(); fixtures.push(f); await f.produce();
  const attempt = f.attempts.reserve(f.id, 'integrate')!;
  const controls = { calls: 0, beforePrepare: () => {}, beforeRun: async () => {}, beforeInspect: async () => {},
    result: (resource: WorkflowManagedTarget): WorkflowIntegrationResult => ({ kind: 'integrated', ...observedRepository(resource) }),
    repository: null as Awaited<ReturnType<WorkflowRepositoryPort['prepare']>> | null,
    observation: (resource: WorkflowManagedTarget, inputs: readonly string[]) => ({ ...observedRepository(resource),
      lineage: inputs.map(commit => ({ commit, containsAncestor: true })) }) };
  const repositories = { async prepare(current) {
    controls.beforePrepare();
    if (controls.repository) return controls.repository;
    return { kind: 'prepared', resource: prepareManagedTarget(f.resources, current) };
  } } satisfies WorkflowRepositoryPort;
  const integration = { async prepare(manifest) {
    return { async run() {
      controls.calls++;
      const row = f.attempts.get(attempt.attemptId);
      expect(row).toMatchObject({ dispatchPhase: 'dispatching', chatId: null, turnId: null, effectiveInput: null });
      const intent = f.store.read(db => db.query<{ id: string }, [string]>("SELECT id FROM operation_intents WHERE attempt_id=? AND kind='integrate'").get(row.attemptId))!;
      expect(f.resources.get(intent.id).status).toBe('dispatching');
      expect(manifest.request.operationId).toBe(row.managedTarget!.operationId);
      expect(manifest.request.operationId).not.toBe(intent.id);
      await controls.beforeRun();
      return controls.result(manifest.resource);
    } };
  }, async inspect(resource, inputs) { await controls.beforeInspect(); return controls.observation(resource, inputs); } } satisfies WorkflowIntegrationRepositoryPort;
  const admission = new WorkflowIntegrationAdmission(f.attempts, f.resources, repositories, integration, { now });
  return { ...f, get store() { return f.store; }, get service() { return f.service; }, storeControls: f.controls, attempt, controls, admission, integration,
    current: () => f.attempts.get(attempt.attemptId),
    artifacts: () => f.service.detail(f.id).artifacts.filter(artifact => artifact.attempt.taskId === 'integrate'),
    claims: () => f.store.read(db => db.query('SELECT quarantined,retained FROM resource_claims WHERE attempt_id=?').all(attempt.attemptId)),
    operation: () => f.store.read(db => db.query<{ id: string; status: string; result_json: string }, [string]>(
      "SELECT id,status,result_json FROM operation_intents WHERE attempt_id=? AND kind='integrate'").get(attempt.attemptId)) };
}

test('integration uses ordered exact inputs, settles one non-chat artifact and unlocks a consumer', async () => {
  const f = await setup();
  const inputs = f.store.read(db => readWorkflowCommitSources(db, f.attempt, f.task));
  expect(inputs.map(source => source.input.taskId)).toEqual(['source1', 'source0']);
  await f.admission.dispatch(f.attempt, effectFence());
  expect(f.current()).toMatchObject({ resolution: 'succeeded', result: { outputCaptured: true, receivedOutputCoverage: 'unknown', executionScope: null } });
  expect(f.artifacts()).toMatchObject([{ kind: 'commit', provenance: 'runtime-observed', outcome: 'pass', commandOutcome: null,
    git: { scope: 'managed-integration', inputs: inputs.map(source => source.input) } }]);
  expect(f.artifacts()[0]!.git).not.toHaveProperty('effectiveInputDigest');
  expect(f.claims()).toEqual([{ retained: 1, quarantined: 0 }]);
  expect(f.attempts.reserve(f.id, 'check')?.target?.baseCommit).toBe('d'.repeat(40));
  await f.admission.dispatch(f.attempt, effectFence());
  expect(f.controls.calls).toBe(1);
  expect(f.artifacts()).toHaveLength(1);
});

test('no-op integration is valid when every input is already an ancestor', async () => {
  const f = await setup();
  f.controls.result = resource => ({ kind: 'integrated', ...observedRepository(resource, resource.head) });
  f.controls.observation = (resource, inputs) => ({ ...observedRepository(resource, resource.head), lineage: inputs.map(commit => ({ commit, containsAncestor: true })) });
  await f.admission.dispatch(f.attempt, effectFence());
  expect(f.current().resolution).toBe('succeeded');
  expect(f.artifacts()[0]?.commit).toBe(f.attempt.target!.baseCommit);
});

test('verification budget allows every bounded read rather than one aggregate call timeout', async () => {
  const f = await setup();
  const timeout = spyOn(AbortSignal, 'timeout');
  try {
    await f.admission.dispatch(f.attempt, effectFence());
    expect(timeout).toHaveBeenCalledWith(5 * GIT_OPERATION_TIMEOUT_MS);
    expect(f.current().resolution).toBe('succeeded');
  } finally { timeout.mockRestore(); }
});

test('conflicts retain bounded diagnostics and the worktree without automatic retry', async () => {
  const f = await setup();
  f.controls.result = resource => ({ kind: 'conflicts', ...observedRepository(resource), paths: Array.from({ length: 1024 }, (_, i) => `${i}/${'x'.repeat(4090)}`) });
  await f.admission.dispatch(f.attempt, effectFence());
  expect(f.current()).toMatchObject({ resolution: 'failed', dispatchPhase: 'settled', controlState: 'released', result: { certainty: 'definite', termination: 'observed' } });
  expect(f.operation()?.status).toBe('succeeded');
  const result = JSON.parse(f.operation()!.result_json);
  expect(result).toMatchObject({ kind: 'conflicts', pathCount: 1024, pathsTruncated: true });
  expect(Buffer.byteLength(f.operation()!.result_json)).toBeLessThan(16384);
  expect(f.claims()).toEqual([{ retained: 1, quarantined: 0 }]);
  expect(f.artifacts()).toHaveLength(0);
  expect(automaticRetryAllowed({ ...f.task, retry: { ...f.task.retry, maxAttempts: 2, repeatableFailure: true } }, f.current(), 1)).toBe(false);
  await recoverWorkflowAttempts(f.store, now);
  expect(f.current().resolution).toBe('failed');
});

test.each(['lost-reply', 'unknown', 'runtime', 'executor', 'marker', 'dirty'] as const)('%s integration is unknown without a second call', async kind => {
  const f = await setup();
  if (kind === 'lost-reply') f.controls.beforeRun = async () => { throw new Error('Synthetic lost reply.'); };
  else f.controls.result = resource => {
    const observed = observedRepository(resource);
    if (kind === 'unknown') return { kind: 'unknown', reason: 'Synthetic uncertainty.', executorId: observed.executorId, instanceId: observed.instanceId };
    if (kind === 'runtime') observed.instanceId = 'different-runtime';
    if (kind === 'executor') observed.executorId = 'different-executor';
    if (kind === 'marker') observed.managed.operationId = 'different-operation';
    if (kind === 'dirty') observed.managed.dirty = true;
    return { kind: 'integrated', ...observed };
  };
  await f.admission.dispatch(f.attempt, effectFence());
  expect(f.current().resolution).toBe('unknown');
  expect(f.operation()?.status).toBe('unknown');
  expect(f.claims()).toEqual([{ retained: 0, quarantined: 1 }]);
  expect(f.artifacts()).toHaveLength(0);
  await f.admission.dispatch(f.attempt, effectFence());
  expect(f.controls.calls).toBe(1);
});

test.each(['pause', 'disable', 'stop'] as const)('%s during the merge drains effects without broadening attribution', async kind => {
  const f = await setup();
  f.controls.beforeRun = async () => {
    if (kind === 'pause') f.write({ action: 'pause', workflowId: f.id });
    if (kind === 'disable') suspendWorkflowAdmission(f.store);
    if (kind === 'stop') await f.admission.stop(f.current());
  };
  await f.admission.dispatch(f.attempt, effectFence());
  expect(f.operation()?.status).toBe('succeeded');
  expect(f.current().resolution).toBe(kind === 'stop' ? 'unknown' : 'succeeded');
  expect(f.artifacts()).toHaveLength(kind === 'stop' ? 0 : 1);
});

test.each(['head', 'runtime', 'dirty', 'root', 'input', 'order', 'stop'] as const)('%s drift during verification never certifies integration', async kind => {
  const f = await setup();
  f.controls.beforeInspect = async () => { if (kind === 'stop') await f.admission.stop(f.current()); };
  f.controls.observation = (resource, inputs) => {
    const observed = { ...observedRepository(resource), lineage: inputs.map(commit => ({ commit, containsAncestor: true })) };
    if (kind === 'head') { observed.managed.head = 'f'.repeat(40); observed.commit.commit = observed.managed.head; }
    if (kind === 'runtime') observed.instanceId = 'different-runtime';
    if (kind === 'dirty') observed.managed.dirty = true;
    if (kind === 'root') observed.commit.containsAncestor = false;
    if (kind === 'input') observed.lineage[0]!.containsAncestor = false;
    if (kind === 'order') observed.lineage.reverse();
    return observed;
  };
  await f.admission.dispatch(f.attempt, effectFence());
  expect(f.current().resolution).toBe('unknown');
  expect(f.claims()).toEqual([{ retained: 0, quarantined: 1 }]);
});

test('definite pre-mutation rejection is not-started with a retained created worktree', async () => {
  const f = await setup(); f.controls.result = () => ({ kind: 'not-started', reason: 'Synthetic rejection.' });
  await f.admission.dispatch(f.attempt, effectFence());
  expect(f.current()).toMatchObject({ resolution: 'not-started', admissionFailure: true });
  expect(f.operation()?.status).toBe('not-started');
  expect(f.claims()).toEqual([{ retained: 1, quarantined: 0 }]);
});

test('paused preparation spends no admission retry and starts no merge', async () => {
  const f = await setup(); f.controls.beforePrepare = () => { f.write({ action: 'pause', workflowId: f.id }); };
  await f.admission.dispatch(f.attempt, effectFence());
  expect(f.current()).toMatchObject({ resolution: 'not-started', admissionFailure: false });
  expect(f.controls.calls).toBe(0);
});

test('held source verification settles preparation without spending admission retries', async () => {
  const f = await setup();
  f.controls.repository = { kind: 'held', detail: 'Synthetic source drift.' };
  await f.admission.dispatch(f.attempt, effectFence());
  expect(f.current()).toMatchObject({ resolution: 'not-started', admissionFailure: false });
  expect(f.service.detail(f.id).tasks.find(task => task.id === 'integrate')).toMatchObject({ hold: 'output-unknown', holdReason: 'Synthetic source drift.' });
  expect(f.attempts.reserve(f.id, 'integrate')).toBeNull();
  expect(f.controls.calls).toBe(0);
});

test.each(['pause', 'disable', 'stop'] as const)('%s during conflicts preserves the definite failure and retained worktree', async kind => {
  const f = await setup();
  f.controls.result = resource => ({ kind: 'conflicts', ...observedRepository(resource), paths: ['synthetic.txt'] });
  f.controls.beforeRun = async () => {
    if (kind === 'pause') f.write({ action: 'pause', workflowId: f.id });
    if (kind === 'disable') suspendWorkflowAdmission(f.store);
    if (kind === 'stop') await f.admission.stop(f.current());
  };
  await f.admission.dispatch(f.attempt, effectFence());
  expect(f.current()).toMatchObject({ resolution: 'failed', result: { certainty: 'definite' } });
  expect(f.claims()).toEqual([{ retained: 1, quarantined: 0 }]);
  expect(f.artifacts()).toHaveLength(0);
  expect(f.service.detail(f.id).tasks.find(task => task.id === 'integrate')?.hold).toBe(kind === 'stop' ? 'intervention' : 'none');
});

test('task-kind routing cannot send integration through chat admission', async () => {
  const f = await setup();
  const port = createWorkflowDispatchPort(f.attempts, { async dispatch() { throw new Error('Unexpected chat'); }, async stop() { throw new Error('Unexpected chat'); } }, f.admission, () => true);
  expect(port.available(f.task, f.service.detail(f.id).active!.plan)).toBe(true);
  await port.dispatch(f.attempt, effectFence());
  expect(f.current().resolution).toBe('succeeded');
});

test.each(['prepared', 'dispatching', 'result'] as const)('restart at %s integration boundary never replays a merge', async boundary => {
  const f = await setup();
  let attempt = f.attempts.beginPreparation(f.attempt.attemptId);
  attempt = f.attempts.bindTarget(attempt.attemptId, prepareManagedTarget(f.resources, attempt));
  const manifest = f.store.read(db => workflowIntegrationManifest(db, attempt));
  const operationId = crypto.randomUUID();
  f.resources.plan({ operationId, attemptId: attempt.attemptId, kind: 'integrate', resourceKey: attempt.managedTarget!.resourceKey,
    payload: JSON.stringify({ manifest, digest: workflowDigest(manifest) }) });
  f.attempts.bindIntegrationPrepared(attempt.attemptId, operationId);
  if (boundary !== 'prepared') f.attempts.markIntegrationDispatching(attempt.attemptId, operationId, effectFence());
  if (boundary === 'result') f.resources.observe(operationId, 'succeeded', JSON.stringify(f.controls.result(attempt.managedTarget!)));
  await recoverWorkflowAttempts(f.store, now);
  expect(f.current().resolution).toBe(boundary === 'prepared' ? 'not-started' : 'unknown');
  expect(f.resources.get(operationId).status).toBe(boundary === 'prepared' ? 'not-started' : boundary === 'result' ? 'succeeded' : 'unknown');
  expect(f.artifacts()).toHaveLength(0);
});

test('atomic dispatch rolls back both phase changes on storage failure', async () => {
  const f = await setup();
  let attempt = f.attempts.beginPreparation(f.attempt.attemptId);
  attempt = f.attempts.bindTarget(attempt.attemptId, prepareManagedTarget(f.resources, attempt));
  const manifest = f.store.read(db => workflowIntegrationManifest(db, attempt));
  const operationId = crypto.randomUUID();
  f.resources.plan({ operationId, attemptId: attempt.attemptId, kind: 'integrate', resourceKey: attempt.managedTarget!.resourceKey,
    payload: JSON.stringify({ manifest, digest: workflowDigest(manifest) }) });
  f.attempts.bindIntegrationPrepared(attempt.attemptId, operationId);
  f.storeControls.failCommit = true;
  expect(() => f.attempts.markIntegrationDispatching(attempt.attemptId, operationId, effectFence())).toThrow();
  f.reopen();
  expect(f.service.attempts(f.id).find(row => row.attemptId === attempt.attemptId)?.dispatchPhase).toBe('prepared');
  expect(f.store.read(db => db.query('SELECT status FROM operation_intents WHERE id=?').get(operationId))).toEqual({ status: 'planned' });
});
