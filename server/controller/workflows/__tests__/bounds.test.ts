import { afterEach, expect, test } from 'bun:test';
import { WORKFLOW_LIMITS } from '../../../../common/workflows.js';
import { WorkflowAttempts } from '../attempts.js';
import { readAttempts, readWorkflowSchedule } from '../records.js';
import { WorkflowResources } from '../resources.js';
import { fixture, plan } from './fixture.js';

const fixtures: ReturnType<typeof fixture>[] = [];
afterEach(() => fixtures.splice(0).forEach(f => f.cleanup()));
const now = () => '2026-01-01T00:00:00.000Z';
function setup() {
  const f = fixture(); fixtures.push(f);
  const id = f.create().workflowId; f.activate(id);
  const attempts = new WorkflowAttempts(f.store, { now });
  return { ...f, id, attempts };
}

test('history pages enforce aggregate bytes independently of the row limit', () => {
  const f = setup(); const attempt = f.attempts.reserve(f.id, 'check')!;
  f.store.transaction(db => {
    db.query("UPDATE attempts SET resolution='not-started',dispatch_phase='settled',control_state='released' WHERE id=?").run(attempt.attemptId);
    const insert = db.query(`INSERT INTO attempts (id,workflow_id,task_id,plan_revision,generation,input_digest,
      dispatch_phase,resolution,control_state,request_id,target_json,result_json,created_at)
      VALUES (?,?,'check',1,1,?,'settled','not-started','released',?,'null',?,?)`);
    for (let index = 0; index < 200; index++) insert.run(`history-${index}`, f.id, attempt.inputDigest, `request-${index}`,
      JSON.stringify({ certainty: 'not-started', termination: 'not-started', detail: 'x'.repeat(12 * 1024) }), now());
  });
  const page = f.service.attempts(f.id, null, 200);
  expect(page.length).toBeGreaterThan(0);
  expect(page.length).toBeLessThan(200);
  expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(WORKFLOW_LIMITS.pageBytes);
  const next = f.service.attempts(f.id, page.at(-1)!.attemptId, 200);
  expect(next.length).toBeGreaterThan(0);
  expect(new Set([...page, ...next].map(attempt => attempt.attemptId)).size).toBe(page.length + next.length);
});

test('scheduling reads bounded attempt metadata, not retained input or evidence bodies', () => {
  const f = setup(); const attempt = f.attempts.reserve(f.id, 'check')!;
  f.store.transaction(db => {
    db.query("UPDATE attempts SET resolution='not-started',dispatch_phase='settled',control_state='released',effective_input_json=? WHERE id=?")
      .run(JSON.stringify({ retained: 'x'.repeat(64 * 1024) }), attempt.attemptId);
    db.query('INSERT INTO artifacts VALUES (?,?,?)').run('synthetic-unneeded-artifact', attempt.attemptId,
      JSON.stringify({ summary: 'x'.repeat(64 * 1024) }));
  });
  const schedule = f.store.read(db => readWorkflowSchedule(db, f.id));
  expect(schedule.tasks[0]?.attempt).not.toHaveProperty('effectiveInput');
  expect(schedule).not.toHaveProperty('artifacts');
  expect(f.attempts.reserve(f.id, 'check')).not.toBeNull();
});

test('current-attempt reads stay bounded across thousands of retained attempts', () => {
  const f = fixture(); fixtures.push(f);
  const original = plan();
  const tasks = Array.from({ length: 256 }, (_, index) => ({ ...original.tasks[0]!, id: `task-${index}` }));
  const id = f.write({ action: 'create', captainChatId: null,
    plan: { ...original, tasks, goal: { kind: 'artifacts', taskIds: ['task-0'] } } }).workflowId;
  f.activate(id);
  f.store.transaction(db => {
    const insert = db.query(`INSERT INTO attempts (id,workflow_id,task_id,plan_revision,generation,input_digest,
      dispatch_phase,resolution,control_state,request_id,target_json,created_at)
      VALUES (?,?,?,1,1,'synthetic','settled','not-started','released',?,'null',?)`);
    for (let index = 0; index < 4096; index++) insert.run(`history-${index}`, id, tasks[index % tasks.length]!.id,
      `request-${index}`, now());
  });
  const start = performance.now();
  expect(f.store.read(db => readAttempts(db, id))).toHaveLength(256);
  expect(f.store.read(db => readWorkflowSchedule(db, id)).tasks).toHaveLength(256);
  expect(performance.now() - start).toBeLessThan(1000);
});

test('resource metadata is bounded per attempt and per workflow before dispatch', () => {
  const f = setup(); const attempt = f.attempts.reserve(f.id, 'check')!;
  f.attempts.beginPreparation(attempt.attemptId);
  const resources = new WorkflowResources(f.store, now);
  for (let index = 0; index < WORKFLOW_LIMITS.resourceOperations; index++) {
    resources.plan({ operationId: `op-${index}`, attemptId: attempt.attemptId,
      kind: 'worktree', resourceKey: `resource-${index}`, payload: '{}' });
  }
  expect(() => resources.plan({ operationId: 'overflow', attemptId: attempt.attemptId,
    kind: 'worktree', resourceKey: 'overflow', payload: '{}' })).toThrow('operation limit');
  f.store.transaction(db => {
    db.query('DELETE FROM operation_intents WHERE id!=?').run('op-0');
    db.query('UPDATE operation_intents SET payload_json=?').run('x'.repeat(WORKFLOW_LIMITS.workflowResourceBytes));
  });
  expect(() => resources.plan({ operationId: 'over-budget', attemptId: attempt.attemptId,
    kind: 'worktree', resourceKey: 'over-budget', payload: '{}' })).toThrow('metadata limit');
});
