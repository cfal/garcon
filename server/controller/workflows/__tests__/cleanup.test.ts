import { afterEach, expect, test } from 'bun:test';
import { cleanupWorkflowResource, planWorkflowCleanup } from '../cleanup.js';
import { WORKFLOW_LIMITS } from '../../../../common/workflows.js';
import { recoverWorkflowAttempts } from '../recovery.js';
import { WorkflowService } from '../service.js';
import { browser, local } from './fixture.js';
import { integrationFixture, integrationPlan, now } from './integration-fixture.js';

const fixtures: ReturnType<typeof integrationFixture>[] = [];
afterEach(() => fixtures.splice(0).forEach(f => f.cleanup()));
async function setup() {
  const plan = integrationPlan(1);
  const f = integrationFixture({ ...plan, tasks: [plan.tasks[0]!], goal: { kind: 'artifacts', taskIds: ['source0'] } });
  fixtures.push(f); await f.produce();
  f.write({ action: 'pause', workflowId: f.id }); f.write({ action: 'archive', workflowId: f.id });
  const attempt = f.service.attempts(f.id)[0]!;
  let calls = 0;
  const service = new WorkflowService(f.store, { enabled: () => false, now, async cleanup() { calls++; } });
  const request = { expectedStoreId: service.bootstrap().storeId, operationId: crypto.randomUUID(), mutation: {
    action: 'cleanup' as const, workflowId: f.id, attemptId: attempt.attemptId, resourceKey: attempt.managedTarget!.resourceKey,
    expectedHead: f.service.artifacts(f.id)[0]!.commit! } };
  return { ...f, service, attempt, request, calls: () => calls };
}

test('cleanup records its intent with the browser receipt before dispatch, never replays after response loss', async () => {
  const f = await setup();
  await expect(f.service.executeHttp(f.request, local)).rejects.toThrow('browser');
  const result = await f.service.executeHttp(f.request, browser);
  expect(f.resources.get(f.request.operationId).status).toBe('planned');
  expect(await f.service.executeHttp(f.request, browser)).toEqual(result); expect(f.calls()).toBe(1);
  f.service.expireResult(f.request.operationId);
  await expect(f.service.executeHttp(f.request, browser)).rejects.toThrow('expired'); expect(f.calls()).toBe(1);
});

test.each(['active', 'quarantine', 'risk-release', 'unknown-writer', 'unsettled-operation', 'wrong-owner'] as const)(
  'cleanup refuses %s before recording an effect', async fault => {
    const f = await setup();
    f.store.transaction(db => {
      if (fault === 'active') db.query("UPDATE workflows SET archived=0,desired='active' WHERE id=?").run(f.id);
      if (fault === 'quarantine') db.query('UPDATE resource_claims SET quarantined=1 WHERE attempt_id=?').run(f.attempt.attemptId);
      if (fault === 'risk-release') db.query('UPDATE resource_claims SET risk_released=1 WHERE attempt_id=?').run(f.attempt.attemptId);
      if (fault === 'unknown-writer') db.query("UPDATE attempts SET resolution='unknown' WHERE id=?").run(f.attempt.attemptId);
      if (fault === 'unsettled-operation') db.query("UPDATE operation_intents SET status='unknown' WHERE attempt_id=?").run(f.attempt.attemptId);
      if (fault === 'wrong-owner') db.query('DELETE FROM resource_claims WHERE attempt_id=?').run(f.attempt.attemptId);
    });
    await expect(f.service.executeHttp(f.request, browser)).rejects.toThrow('Cleanup requires');
    expect(f.calls()).toBe(0);
  },
);

test('pending manual input rejects removal without executor access or downgrading delivered evidence', async () => {
  const f = await setup(); await f.service.executeHttp(f.request, browser);
  const before = f.service.artifacts(f.id); let resolutions = 0;
  await cleanupWorkflowResource(f.store, f.request.operationId, async () => { resolutions++; throw new Error('Unexpected executor access'); },
    new AbortController().signal, { now, onInvalidated() {}, async inspectWriters() { throw new Error('Pending manual input'); } });
  expect(resolutions).toBe(0); expect(f.resources.get(f.request.operationId).status).toBe('not-started');
  expect(f.service.detail(f.id).outcome).toBe('succeeded'); expect(f.service.artifacts(f.id)).toEqual(before);
  expect(f.service.detail(f.id).resources[0]).toMatchObject({ retained: true, quarantined: false });
});

test.each(['planned', 'dispatching'] as const)('restart during %s cleanup never replays or changes delivered outcome', async phase => {
  const f = await setup(); await f.service.executeHttp(f.request, browser);
  f.store.transaction(db => {
    db.query('UPDATE operation_intents SET status=? WHERE id=?').run(phase, f.request.operationId);
    db.query('INSERT INTO resource_claims VALUES (?,?,?,0,0,1)').run('independent-ref', f.attempt.attemptId, 'local');
  });
  await recoverWorkflowAttempts(f.store, now);
  expect(f.resources.get(f.request.operationId).status).toBe(phase === 'planned' ? 'not-started' : 'unknown');
  expect(f.service.detail(f.id).resources.find(claim => claim.resourceKey === 'independent-ref')?.quarantined).toBe(false);
  expect(f.service.detail(f.id).resources.find(claim => claim.resourceKey === f.request.mutation.resourceKey)?.quarantined).toBe(phase === 'dispatching');
  expect(f.service.detail(f.id).outcome).toBe('succeeded');
  await f.service.executeHttp(f.request, browser); expect(f.calls()).toBe(1);
});

test('three busy refusals do not exhaust cleanup admission, while the overall operation bound remains enforced', async () => {
  const f = await setup();
  for (let i = 0; i < 3; i++) {
    const id = crypto.randomUUID();
    f.store.transaction(db => planWorkflowCleanup(db, f.request.mutation, id));
    await cleanupWorkflowResource(f.store, id, async () => { throw new Error('Must not resolve'); }, new AbortController().signal,
      { now, onInvalidated() {}, async inspectWriters() { throw new Error('Synthetic active writer'); } });
    expect(f.resources.get(id).status).toBe('not-started');
  }
  await expect(f.service.executeHttp(f.request, browser)).resolves.toMatchObject({ workflowId: f.id });
  f.store.transaction(db => {
    db.query("UPDATE operation_intents SET status='not-started' WHERE id=?").run(f.request.operationId);
    const { n } = db.query<{ n: number }, [string]>('SELECT COUNT(*) AS n FROM operation_intents WHERE attempt_id=?').get(f.attempt.attemptId)!;
    for (let i = n; i < WORKFLOW_LIMITS.resourceOperations; i++) db.query("INSERT INTO operation_intents VALUES (?,?,'cleanup',?,'not-started','{}',NULL,0,NULL)")
      .run(crypto.randomUUID(), f.attempt.attemptId, f.request.mutation.resourceKey);
  });
  await expect(f.service.executeHttp({ ...f.request, operationId: crypto.randomUUID() }, browser)).rejects.toThrow('Resource operation limit');
});
