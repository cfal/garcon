import { afterEach, expect, test } from 'bun:test';
import { WorkflowAttempts } from '../attempts.js';
import { workflowEffectiveInput, workflowStartInput } from '../inputs.js';
import { recoverWorkflowAttempts, suspendWorkflowAdmission } from '../recovery.js';
import { WorkflowResources } from '../resources.js';
import { readDependencyArtifacts } from '../records.js';
import { fixture, plan, prepareManagedTarget } from './fixture.js';

const fixtures: ReturnType<typeof fixture>[] = [];
const now = () => '2026-01-01T00:00:00.000Z';
const clear = { revoked: false, reason: null };
function setup() {
  const f = fixture(); fixtures.push(f);
  const id = f.create().workflowId; f.activate(id);
  const attempts = new WorkflowAttempts(f.store, { now });
  const resources = new WorkflowResources(f.store, now);
  let attempt = attempts.reserve(id, 'check')!;
  const prepare = () => {
    attempts.beginPreparation(attempt.attemptId);
    attempt = attempts.bindTarget(attempt.attemptId, prepareManagedTarget(resources, attempt, 'synthetic-resource'));
    attempts.bindPrepared(attempt.attemptId, { serverInstanceId: 'synthetic-controller', chatId: '1234567890123456',
      turnId: crypto.randomUUID(), clientRequestId: attempt.requestId }, workflowEffectiveInput(workflowStartInput(attempt, plan().tasks[0]!)));
  };
  return { ...f, get store() { return f.store; }, get service() { return f.service; }, id, attempts, attempt, prepare };
}
afterEach(() => fixtures.splice(0).forEach(f => f.cleanup()));

for (const phase of ['planned', 'preparing', 'prepared'] as const) {
  test(`restart before dispatch classifies ${phase} as not-started without replay`, async () => {
    const f = setup();
    if (phase === 'prepared') f.prepare();
    else if (phase === 'preparing') f.attempts.beginPreparation(f.attempt.attemptId);
    f.reopen();
    expect(await recoverWorkflowAttempts(f.store, now)).toBe(1);
    const saved = f.service.attempts(f.id)[0]!;
    expect(saved.resolution).toBe('not-started');
    expect(saved.result?.termination).toBe('not-started');
    expect(saved.requestId).toBe(f.attempt.requestId);
    const attempts = new WorkflowAttempts(f.store, { now });
    expect(attempts.reserve(f.id, 'check')).toBeNull();
    expect(await recoverWorkflowAttempts(f.store, now)).toBe(0);
  });
}

test('restart after dispatch is unknown, retains capacity and never starts another attempt', async () => {
  const f = setup(); f.prepare(); f.attempts.markDispatching(f.attempt.attemptId, clear);
  f.reopen();
  await recoverWorkflowAttempts(f.store, now);
  expect(f.service.detail(f.id).tasks[0]).toMatchObject({ hold: 'output-unknown', phase: 'outcome-unknown' });
  expect(f.service.attempts(f.id)[0]).toMatchObject({ resolution: 'unknown', result: { certainty: 'unknown', termination: 'unknown' } });
  expect(f.store.read(db => db.query('SELECT quarantined FROM resource_claims').all())).toEqual([{ quarantined: 1 }]);
  const attempts = new WorkflowAttempts(f.store, { now });
  expect(attempts.reserve(f.id, 'check')).toBeNull();
  expect(f.service.attempts(f.id)).toHaveLength(1);
});

test('terminal without accepted output remains an observation gap across restart', async () => {
  const f = setup(); f.prepare(); f.attempts.markDispatching(f.attempt.attemptId, clear);
  f.attempts.observe(f.attempt.attemptId, { resolution: 'checking', result: { certainty: 'definite', detail: 'Completed.',
    commandOutcome: null, receivedOutputCoverage: 'complete', termination: 'observed', outputCaptured: false } }, clear);
  f.reopen(); await recoverWorkflowAttempts(f.store, now);
  expect(f.service.attempts(f.id)[0]).toMatchObject({ resolution: 'unknown', result: { certainty: 'definite', termination: 'observed', outputCaptured: false } });
  expect(f.store.read(db => db.query('SELECT quarantined FROM resource_claims').all())).toEqual([{ quarantined: 1 }]);
  expect(f.service.detail(f.id).tasks[0]?.hold).toBe('output-unknown');
});

test.each([false, true])('restart preserves accepted evidence before control release: intervention=%s', async intervention => {
  const f = setup(); f.prepare(); f.attempts.markDispatching(f.attempt.attemptId, clear);
  f.attempts.observe(f.attempt.attemptId, { resolution: 'checking', retainControl: true,
    result: { certainty: 'definite', detail: 'Synthetic accepted output.', commandOutcome: null,
      receivedOutputCoverage: 'complete', termination: 'observed', outputCaptured: false } }, clear);
  const artifact = { digest: 'sha256:synthetic-output', commit: 'b'.repeat(40) };
  f.store.transaction(db => {
    db.query("UPDATE attempts SET resolution='succeeded',result_json=json_set(result_json,'$.outputCaptured',json('true')) WHERE id=?")
      .run(f.attempt.attemptId);
    db.query('INSERT INTO artifacts VALUES (?,?,?)').run('synthetic-artifact', f.attempt.attemptId, JSON.stringify(artifact));
  });
  if (intervention) f.attempts.revoke(f.attempt.attemptId, 'Synthetic post-acceptance Stop.');
  f.reopen();
  expect(await recoverWorkflowAttempts(f.store, now)).toBe(1);
  expect(f.service.attempts(f.id)[0]).toMatchObject({ resolution: 'succeeded', dispatchPhase: 'settled',
    controlState: intervention ? 'revoked' : 'released', result: { certainty: 'definite', outputCaptured: true } });
  expect(f.store.read(db => db.query('SELECT payload_json FROM artifacts').all())).toEqual([{ payload_json: JSON.stringify(artifact) }]);
  expect(f.store.read(db => db.query('SELECT retained,quarantined FROM resource_claims').all())).toEqual([{ retained: 1, quarantined: 0 }]);
  expect(f.service.detail(f.id).tasks[0]).toMatchObject({ hold: intervention ? 'intervention' : 'none', phase: intervention ? 'outcome-unknown' : 'succeeded' });
  expect(f.store.read(db => readDependencyArtifacts(db, f.id, ['check']))).toHaveLength(intervention ? 0 : 1);
  if (intervention) expect(() => f.write({ action: 'resolve', workflowId: f.id, taskId: 'check',
    attemptId: f.attempt.attemptId, generation: 1, resolution: 'not-started', releaseRisk: false,
    evidence: 'Synthetic incorrect non-start assertion.', commit: null })).toThrow('Definite execution evidence');
  expect(await recoverWorkflowAttempts(f.store, now)).toBe(0);
});

test('unaccepted failure cannot retry across a crash that loses the post-terminal takeover fence', async () => {
  const f = setup(); f.prepare(); f.attempts.markDispatching(f.attempt.attemptId, clear);
  f.attempts.observe(f.attempt.attemptId, { resolution: 'failed', retainControl: true,
    result: { certainty: 'definite', detail: 'Synthetic failure before takeover.', commandOutcome: null,
      receivedOutputCoverage: 'complete', termination: 'observed', outputCaptured: false } }, clear);
  // A core takeover can fence memory before its deferred workflow write survives a crash.
  f.reopen(); await recoverWorkflowAttempts(f.store, now);
  expect(f.service.detail(f.id).tasks[0]).toMatchObject({ hold: 'output-unknown', attempt: { resolution: 'unknown',
    result: { certainty: 'definite', termination: 'observed' } } });
  expect(new WorkflowAttempts(f.store, { now }).reserve(f.id, 'check')).toBeNull();
});

test('a retained early non-start terminal cannot authorize retry across a lost control observation', async () => {
  const f = setup(); f.prepare(); f.attempts.markDispatching(f.attempt.attemptId, clear);
  f.attempts.observe(f.attempt.attemptId, { resolution: 'not-started', retainControl: true,
    result: { certainty: 'not-started', detail: 'Synthetic early non-start.', commandOutcome: null,
      receivedOutputCoverage: 'unknown', termination: 'not-started', outputCaptured: false } }, clear);
  expect(f.attempts.reserve(f.id, 'check')).toBeNull();
  f.reopen(); await recoverWorkflowAttempts(f.store, now);
  expect(f.service.detail(f.id).tasks[0]).toMatchObject({ hold: 'output-unknown', attempt: { resolution: 'unknown' } });
});

test('restart preserves intervention and uncertain preparation claims', async () => {
  const f = setup(); f.prepare();
  f.store.transaction(db => db.query("INSERT INTO operation_intents VALUES (?,?,'worktree','synthetic-resource','unknown','{}',NULL,0,NULL)").run(crypto.randomUUID(), f.attempt.attemptId));
  f.attempts.revoke(f.attempt.attemptId, 'Manual Stop.');
  f.reopen(); await recoverWorkflowAttempts(f.store, now);
  expect(f.service.detail(f.id).tasks[0]?.hold).toBe('intervention');
  expect(f.service.attempts(f.id)[0]?.resolution).toBe('not-started');
  expect(f.service.attempts(f.id)[0]?.result?.detail).toContain('repository preparation may have executed');
  expect(f.store.read(db => db.query('SELECT * FROM resource_claims').all())).toHaveLength(1);
});

test('feature disable preserves desired intent, drains results, and requires browser epoch resumption', () => {
  const f = setup(); f.prepare(); f.attempts.markDispatching(f.attempt.attemptId, clear);
  const original = f.service.detail(f.id).workflow;
  suspendWorkflowAdmission(f.store);
  expect(f.service.detail(f.id).workflow.desired).toBe('active');
  f.attempts.observe(f.attempt.attemptId, { resolution: 'not-started', result: { certainty: 'not-started', detail: 'Not dispatched.',
    commandOutcome: null, receivedOutputCoverage: 'unknown', termination: 'not-started', outputCaptured: false } }, clear);
  expect(f.service.detail(f.id).tasks[0]?.phase).toBe('blocked');
  f.write({ action: 'resume', workflowId: f.id, controlEpoch: original.controlEpoch, planRevision: original.activePlanRevision! });
  expect(f.service.detail(f.id).tasks[0]?.phase).toBe('ready');
});

test('recovery commit failure fences the domain instead of permitting retry', async () => {
  const f = setup(); f.prepare(); f.attempts.markDispatching(f.attempt.attemptId, clear);
  f.controls.failCommit = true;
  await expect(recoverWorkflowAttempts(f.store, now)).rejects.toMatchObject({ code: 'WORKFLOW_UNAVAILABLE' });
  expect(() => f.attempts.reserve(f.id, 'check')).toThrow(expect.objectContaining({ code: 'WORKFLOW_UNAVAILABLE' }));
  f.reopen();
  expect(f.service.attempts(f.id)[0]?.dispatchPhase).toBe('dispatching');
  await recoverWorkflowAttempts(f.store, now);
  expect(f.service.attempts(f.id)[0]?.resolution).toBe('unknown');
});
