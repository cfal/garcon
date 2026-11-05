import { afterEach, expect, test } from 'bun:test';
import type { WorkflowAttemptResult, WorkflowPlan } from '../../../../common/workflows.js';
import { WorkflowAttempts, type WorkflowAttemptFence } from '../attempts.js';
import { workflowEffectiveInput, workflowStartInput } from '../inputs.js';
import { WorkflowResources } from '../resources.js';
import { readDependencyArtifacts } from '../records.js';
import { fixture, managedTarget, plan, prepareManagedTarget } from './fixture.js';

const fixtures: ReturnType<typeof fixture>[] = [];
const clear: WorkflowAttemptFence = { revoked: false, reason: null };
const revoked: WorkflowAttemptFence = { revoked: true, reason: 'Manual steer.' };
const observed: WorkflowAttemptResult = { executionScope: null, certainty: 'definite', detail: 'Synthetic terminal.',
  commandOutcome: null, receivedOutputCoverage: 'complete', outputCaptured: false, termination: 'observed' };

function setup(input: WorkflowPlan = plan()) {
  const f = fixture(); fixtures.push(f);
  const clock = { value: Date.parse('2026-01-01T00:00:00.000Z') };
  const attempts = new WorkflowAttempts(f.store, { now: () => new Date(clock.value).toISOString() });
  const resources = new WorkflowResources(f.store, () => new Date(clock.value).toISOString());
  const id = f.write({ action: 'create', captainChatId: null, plan: input }).workflowId;
  f.activate(id);
  const claims = (attemptId: string) => f.store.read(db => db.query('SELECT * FROM resource_claims WHERE attempt_id=?').all(attemptId));
  function prepareResource(attemptId: string, resourceKey: string) {
    return prepareManagedTarget(resources, attempts.get(attemptId), resourceKey);
  }
  function prepared(taskId = 'check') {
    let attempt = attempts.reserve(id, taskId)!;
    attempts.beginPreparation(attempt.attemptId);
    attempt = attempts.bindTarget(attempt.attemptId, prepareResource(attempt.attemptId, attempt.attemptId));
    const effective = workflowEffectiveInput(workflowStartInput(attempt, input.tasks.find(task => task.id === taskId)!));
    const key = { serverInstanceId: 'synthetic-controller', chatId: '1234567890123456',
      turnId: crypto.randomUUID(), clientRequestId: attempt.requestId };
    return attempts.bindPrepared(attempt.attemptId, key, effective);
  }
  function dispatched() { const attempt = prepared(); return attempts.markDispatching(attempt.attemptId, clear); }
  return { ...f, get store() { return f.store; }, get service() { return f.service; }, id, attempts, claims, prepared, dispatched, prepareResource, clock };
}
afterEach(() => fixtures.splice(0).forEach(f => f.cleanup()));

test('reserves one exact attempt and captures approved input before dispatch', () => {
  const f = setup();
  const attempt = f.prepared();
  expect(attempt.dispatchPhase).toBe('prepared');
  expect(attempt.effectiveInput?.projectPath).toBe(attempt.target?.projectPath);
  expect(f.attempts.reserve(f.id, 'check')).toBeNull();
  expect(f.attempts.markDispatching(attempt.attemptId, clear).dispatchPhase).toBe('dispatching');
  expect(() => f.attempts.markDispatching(attempt.attemptId, clear)).toThrow('dispatch phase');
  expect(f.claims(attempt.attemptId)).toHaveLength(1);
});

test('prepared target rejects executor, repository, remote and base substitution', () => {
  const f = setup();
  const attempt = f.attempts.reserve(f.id, 'check')!;
  f.attempts.beginPreparation(attempt.attemptId);
  for (const patch of [{ executorId: '11111111-1111-4111-8111-111111111111' }, { repositoryId: 'other' }, { baseCommit: 'b'.repeat(40) },
    { remote: { name: 'origin', url: 'https://example.invalid/other.git' } }]) {
    expect(() => f.attempts.bindTarget(attempt.attemptId, { ...managedTarget(attempt), target: { ...attempt.target!, ...patch } })).toThrow('approved target');
  }
  expect(f.claims(attempt.attemptId)).toHaveLength(0);
});

test('prepared input drift cannot replace the approved command, settings or selection', () => {
  const f = setup();
  let attempt = f.attempts.reserve(f.id, 'check')!;
  f.attempts.beginPreparation(attempt.attemptId);
  attempt = f.attempts.bindTarget(attempt.attemptId, f.prepareResource(attempt.attemptId, 'resource'));
  const input = workflowStartInput(attempt, plan().tasks[0]!);
  const key = { serverInstanceId: 'synthetic-controller', chatId: '1234567890123456', turnId: crypto.randomUUID(), clientRequestId: attempt.requestId };
  for (const changed of [{ ...input, command: 'printf changed' }, { ...input, model: 'zsh' },
    { ...input, permissionMode: 'bypassPermissions' as const }, { ...input, providerRevision: 2 },
    { ...input, preambles: [{ id: 'synthetic', contentDigest: 'sha256:changed' }] }]) {
    expect(() => f.attempts.bindPrepared(attempt.attemptId, key, workflowEffectiveInput(changed))).toThrow('approved input');
  }
  expect(f.attempts.get(attempt.attemptId).effectiveInput).toBeNull();
  expect(f.attempts.bindPrepared(attempt.attemptId, key, workflowEffectiveInput(input)).dispatchPhase).toBe('prepared');
});

test('pause, task hold and sticky revocation each prevent dispatch', () => {
  for (const action of ['pause', 'hold', 'revoke'] as const) {
    const f = setup(); const attempt = f.prepared();
    if (action === 'pause') f.write({ action: 'pause', workflowId: f.id });
    if (action === 'hold') f.store.transaction(db => db.query("UPDATE tasks SET hold='intervention' WHERE workflow_id=?").run(f.id));
    expect(() => f.attempts.markDispatching(attempt.attemptId, action === 'revoke' ? revoked : clear)).toThrow();
    expect(f.attempts.get(attempt.attemptId).dispatchPhase).toBe('prepared');
  }
});

test('terminal persistence retains claims throughout output inspection', () => {
  const f = setup(); const attempt = f.dispatched();
  const checking = f.attempts.observe(attempt.attemptId, { resolution: 'checking', result: observed }, clear);
  expect(checking.resolution).toBe('open');
  expect(f.service.detail(f.id).tasks[0]?.phase).toBe('checking');
  expect(f.claims(attempt.attemptId)).toHaveLength(1);
  expect(f.attempts.reserve(f.id, 'check')).toBeNull();
  const revision = f.service.detail(f.id).workflow.revision;
  expect(f.attempts.observe(attempt.attemptId, { resolution: 'unknown', result: { ...observed, certainty: 'unknown' } }, clear)).toEqual(checking);
  expect(f.service.detail(f.id).workflow.revision).toBe(revision);
});

test('steer then terminal commits the intervention hold before deferred revocation handling', () => {
  const f = setup(); const attempt = f.dispatched();
  const terminal = f.attempts.observe(attempt.attemptId, { resolution: 'checking', result: observed }, revoked);
  expect(terminal).toMatchObject({ resolution: 'unknown', controlState: 'revoked', revocationReason: 'Manual steer.' });
  f.reopen();
  const task = f.service.detail(f.id).tasks[0]!;
  expect(task.hold).toBe('intervention');
  expect(task.attempt?.result).toEqual(observed);
  expect(task.phase).toBe('outcome-unknown');
});

test('failed, interrupted and unknown terminals do not fabricate success or non-execution', () => {
  const f = setup(); const attempt = f.dispatched();
  expect(() => f.attempts.observe(attempt.attemptId, { resolution: 'checking', result: { ...observed, termination: 'unknown' } }, clear)).toThrow();
  expect(() => f.attempts.observe(attempt.attemptId, { resolution: 'not-started', result: observed }, clear)).toThrow();
  expect(() => f.attempts.observe(attempt.attemptId, { resolution: 'checking', result: { ...observed, outputCaptured: true } }, clear)).toThrow();
  f.attempts.observe(attempt.attemptId, { resolution: 'interrupted', result: { ...observed, termination: 'unknown' } }, clear);
  expect(f.service.detail(f.id).tasks[0]?.hold).toBe('intervention');
  expect(f.claims(attempt.attemptId)).toMatchObject([{ quarantined: 1 }]);
});

test('only a definite repeatable execution failure admits a fresh attempt after backoff', () => {
  const original = plan(); const task = original.tasks[0]!;
  const retryPlan = { ...original, tasks: [{ ...task, retry: { maxAttempts: 2, backoffMs: 5000, repeatableFailure: true } }] };
  for (const termination of ['observed', 'unknown'] as const) {
    const f = setup(retryPlan); const attempt = f.dispatched();
    f.attempts.observe(attempt.attemptId, { resolution: 'failed', result: { ...observed, termination } }, clear);
    expect(f.attempts.reserve(f.id, 'check')).toBeNull();
    f.clock.value += 5000;
    const retry = f.attempts.reserve(f.id, 'check');
    if (termination === 'unknown') expect(retry).toBeNull();
    else expect(retry?.requestId).not.toBe(attempt.requestId);
  }
});

test('not-started admission failures are separately bounded', () => {
  const f = setup();
  for (let index = 0; index < 3; index++) {
    const attempt = f.attempts.reserve(f.id, 'check')!;
    expect(attempt).not.toBeNull();
    f.attempts.observe(attempt.attemptId, { resolution: 'not-started', result: { ...observed, certainty: 'not-started', termination: 'not-started' } }, clear);
    f.clock.value += 1000;
  }
  expect(f.attempts.reserve(f.id, 'check')).toBeNull();
  expect(f.service.detail(f.id).tasks[0]?.blockedReason).toBe('Admission retry limit reached.');
});

test('pause during preparation does not consume the admission rejection budget', () => {
  const f = setup();
  for (let index = 0; index < 4; index++) {
    const attempt = f.attempts.reserve(f.id, 'check')!; expect(attempt).not.toBeNull();
    f.attempts.beginPreparation(attempt.attemptId);
    f.write({ action: 'pause', workflowId: f.id });
    f.attempts.observe(attempt.attemptId, { resolution: 'not-started', result: { ...observed, certainty: 'not-started', termination: 'not-started' } }, clear);
    expect(f.attempts.get(attempt.attemptId).admissionFailure).toBe(false);
    const workflow = f.service.detail(f.id).workflow;
    f.write({ action: 'resume', workflowId: f.id, controlEpoch: workflow.controlEpoch, planRevision: workflow.activePlanRevision! });
    f.clock.value += 1000;
  }
  expect(f.attempts.reserve(f.id, 'check')).not.toBeNull();
});

test('superseded non-start settles without poisoning the replacement generation', () => {
  const f = setup(); const attempt = f.attempts.reserve(f.id, 'check')!;
  f.attempts.beginPreparation(attempt.attemptId);
  f.write({ action: 'plan', workflowId: f.id, expectedPlanRevision: 1,
    plan: { ...plan(), tasks: [{ ...plan().tasks[0]!, title: 'Revised task' }] } });
  f.activate(f.id);
  f.attempts.observe(attempt.attemptId, { resolution: 'not-started', result: { ...observed, certainty: 'not-started', termination: 'not-started' } }, clear);
  expect(f.service.detail(f.id).tasks[0]).toMatchObject({ generation: 2, hold: 'none', phase: 'ready' });
  expect(f.attempts.reserve(f.id, 'check')).not.toBeNull();
});

test('unknown Git operations retain claims even after proven chat non-start', () => {
  const f = setup(); const attempt = f.prepared();
  f.store.transaction(db => db.query("INSERT INTO operation_intents VALUES (?,?,'worktree',?,'unknown','{}',NULL,0,NULL)").run(crypto.randomUUID(), attempt.attemptId, attempt.attemptId));
  f.attempts.observe(attempt.attemptId, { resolution: 'not-started', result: { ...observed, certainty: 'not-started', termination: 'not-started' } }, clear);
  expect(f.claims(attempt.attemptId)).toHaveLength(1);
  f.clock.value += 1000;
  expect(f.attempts.reserve(f.id, 'check')).toBeNull();
});

test('current-generation exclusion survives activation while an attempt is unsettled', () => {
  const f = setup(); const attempt = f.dispatched();
  f.write({ action: 'plan', workflowId: f.id, expectedPlanRevision: 1,
    plan: { ...plan(), tasks: [{ ...plan().tasks[0]!, title: 'Revised task' }] } });
  f.activate(f.id);
  expect(f.attempts.reserve(f.id, 'check')).toBeNull();
  const terminal = f.attempts.observe(attempt.attemptId, { resolution: 'checking', result: observed }, clear);
  expect(terminal.controlState).toBe('revoked');
  expect(f.service.detail(f.id).tasks[0]?.generation).toBe(2);
  expect(f.attempts.reserve(f.id, 'check')).toBeNull();
});

test('capacity is global, per workflow and per executor, including quarantined claims', () => {
  const original = plan(); const task = original.tasks[0]!;
  const input = { ...original, tasks: [task, { ...task, id: 'second' }, { ...task, id: 'third' }] };
  const f = setup(input);
  const first = f.attempts.reserve(f.id, 'check')!;
  expect(f.attempts.reserve(f.id, 'second')).not.toBeNull();
  expect(f.attempts.reserve(f.id, 'third')).toBeNull();
  const other = f.write({ action: 'create', captainChatId: null, plan: input }).workflowId;
  f.activate(other);
  expect(f.attempts.reserve(other, 'check')).toBeNull();
  f.store.transaction(db => {
    db.query("UPDATE attempts SET resolution='abandoned',control_state='released' WHERE id=?").run(first.attemptId);
    db.query('INSERT INTO resource_claims VALUES (?,?,?,1,0,0)').run('quarantined', first.attemptId, 'local');
  });
  expect(f.attempts.reserve(other, 'check')).toBeNull();
});

test('storage failure cannot advance dispatch or erase reserved identity', () => {
  const f = setup(); const attempt = f.prepared();
  f.controls.failCommit = true;
  expect(() => f.attempts.markDispatching(attempt.attemptId, clear)).toThrow(expect.objectContaining({ code: 'WORKFLOW_UNAVAILABLE' }));
  f.reopen();
  const saved = f.service.attempts(f.id)[0]!;
  expect(saved.dispatchPhase).toBe('prepared');
  expect(saved.requestId).toBe(attempt.requestId);
});

test('dependency input binding rejects a newly held upstream task', () => {
  const original = plan(); const task = original.tasks[0]!;
  const f = setup({ ...original, tasks: [task, { ...task, id: 'next', dependsOn: ['check'] }] });
  const attempt = f.dispatched();
  expect(f.attempts.reserve(f.id, 'next')).toBeNull();
  f.store.transaction(db => {
    db.query("UPDATE attempts SET resolution='succeeded',dispatch_phase='settled',control_state='released' WHERE id=?").run(attempt.attemptId);
    db.query('DELETE FROM resource_claims WHERE attempt_id=?').run(attempt.attemptId);
    db.query('INSERT INTO artifacts VALUES (?,?,?)').run('synthetic-artifact', attempt.attemptId,
      JSON.stringify({ digest: 'sha256:synthetic-artifact', commit: 'a'.repeat(40) }));
  });
  const dependent = f.attempts.reserve(f.id, 'next')!;
  expect(dependent).not.toBeNull();
  f.attempts.beginPreparation(dependent.attemptId);
  f.store.transaction(db => db.query("UPDATE tasks SET hold='intervention' WHERE workflow_id=? AND id='check'").run(f.id));
  expect(() => f.attempts.bindTarget(dependent.attemptId, managedTarget(dependent))).toThrow('Dependency evidence');
});

test('dependency artifacts exclude unsuccessful and superseded attempts', () => {
  const f = setup(); const attempt = f.dispatched();
  f.store.transaction(db => {
    db.query('INSERT INTO artifacts VALUES (?,?,?)').run('old-artifact', attempt.attemptId,
      JSON.stringify({ digest: 'sha256:synthetic-artifact', commit: 'a'.repeat(40) }));
  });
  expect(f.store.read(db => readDependencyArtifacts(db, f.id, ['check']))).toEqual([]);
  f.store.transaction(db => db.query("UPDATE attempts SET resolution='succeeded',control_state='released' WHERE id=?").run(attempt.attemptId));
  expect(f.store.read(db => readDependencyArtifacts(db, f.id, ['check']))).toEqual([]);
  f.store.transaction(db => db.query("UPDATE attempts SET dispatch_phase='settled' WHERE id=?").run(attempt.attemptId));
  expect(f.store.read(db => readDependencyArtifacts(db, f.id, ['check']))).toHaveLength(1);
  f.store.transaction(db => db.query('UPDATE tasks SET generation=generation+1,input_digest=NULL WHERE workflow_id=?').run(f.id));
  expect(f.store.read(db => readDependencyArtifacts(db, f.id, ['check']))).toEqual([]);
});

test('notification failure after commit cannot misreport an attempt reservation', () => {
  const f = setup();
  const attempts = new WorkflowAttempts(f.store, { now: () => new Date(f.clock.value).toISOString(),
    onInvalidated: () => f.store.close() });
  const reserved = attempts.reserve(f.id, 'check');
  expect(reserved).not.toBeNull();
  f.reopen();
  expect(f.service.attempts(f.id)[0]?.attemptId).toBe(reserved!.attemptId);
});

test('late finalization cannot release abandoned resource risk without termination evidence', () => {
  const f = setup(); const attempt = f.dispatched();
  f.store.transaction(db => db.query("UPDATE attempts SET resolution='unknown',dispatch_phase='settled',control_state='revoked' WHERE id=?").run(attempt.attemptId));
  f.write({ action: 'resolve', workflowId: f.id, taskId: 'check', attemptId: attempt.attemptId,
    generation: 1, resolution: 'abandon', releaseRisk: false, evidence: 'Synthetic abandonment without risk release.', commit: null });
  expect(f.attempts.get(attempt.attemptId).result).toBeNull();
  const before = f.service.detail(f.id);
  f.attempts.releaseControl(attempt.attemptId, revoked);
  expect(f.service.detail(f.id)).toEqual(before);
  expect(f.claims(attempt.attemptId)).toMatchObject([{ quarantined: 1, retained: 0, risk_released: 0 }]);
});

test('a queued Stop after released success leaves the result and task hold intact', () => {
  const f = setup(); const attempt = f.dispatched();
  f.store.transaction(db => db.query("UPDATE attempts SET resolution='succeeded',dispatch_phase='settled',control_state='released',result_json=? WHERE id=?")
    .run(JSON.stringify({ ...observed, outputCaptured: true }), attempt.attemptId));
  const revision = f.service.detail(f.id).workflow.revision;
  f.attempts.revoke(attempt.attemptId, 'Queued Stop.');
  f.attempts.releaseControl(attempt.attemptId, revoked);
  expect(f.service.detail(f.id).workflow.revision).toBe(revision);
  expect(f.service.detail(f.id).tasks[0]).toMatchObject({ phase: 'succeeded', hold: 'none' });
});
