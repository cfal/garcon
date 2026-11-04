import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { chmodSync, existsSync, mkdirSync, statSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { WorkflowStore, inspectWorkflowProviderReferences } from '../store.js';
import { WorkflowService } from '../service.js';
import { fixture, plan, local, browser } from './fixture.js';

const fixtures: ReturnType<typeof fixture>[] = [];
function setup() { const item = fixture(); fixtures.push(item); return item; }
afterEach(() => fixtures.splice(0).forEach(item => item.cleanup()));

test('submissions validate the actual graph before any durable mutation', () => {
  const f = setup();
  expect(() => f.write({ action: 'create', captainChatId: null,
    plan: { ...plan(), tasks: [{ ...plan().tasks[0]!, dependsOn: ['absent'] }] } })).toThrow(expect.objectContaining({ code: 'WORKFLOW_INVALID_PLAN' }));
  expect(f.service.list().workflows).toHaveLength(0);
  expect(f.create().revision).toBe(2);
});
test('exact mutation recovery precedes advanced plan revision checks', () => {
  const f = setup();
  const id = f.create().workflowId;
  const operationId = crypto.randomUUID();
  const mutation = { action: 'plan' as const, workflowId: id, expectedPlanRevision: 1, plan: { ...plan(), title: 'Revision two' } };
  const first = f.write(mutation, browser, operationId);
  expect(f.write(mutation, browser, operationId)).toEqual(first);
  expect(() => f.write(mutation)).toThrow(expect.objectContaining({ code: 'WORKFLOW_CONFLICT' }));
  expect(() => f.write(mutation, local, operationId)).toThrow(expect.objectContaining({ code: 'WORKFLOW_CONFLICT' }));
  f.service.expireResult(operationId);
  f.reopen();
  expect(() => f.write(mutation, browser, operationId)).toThrow(expect.objectContaining({ code: 'WORKFLOW_RESULT_EXPIRED' }));
  expect(f.service.detail(id).draft.revision).toBe(2);
});
test('current authorization precedes completed result lookup', () => {
  const f = setup();
  const id = f.create().workflowId;
  const request = { operationId: crypto.randomUUID(), mutation: { action: 'activate', workflowId: id, manifestDigest: f.service.detail(id).activationDigest } };
  f.service.execute(request, browser);
  expect(() => f.service.execute(request, { ...browser, browserSession: false })).toThrow(expect.objectContaining({ code: 'WORKFLOW_FORBIDDEN' }));
  expect(() => f.service.execute(request, { ...browser, assertCurrent() { throw new Error('Revoked'); } })).toThrow('Revoked');
});
test('staged edits do not change active tasks and Stop has no revision precondition', () => {
  const f = setup();
  const id = f.create().workflowId;
  f.activate(id);
  const original = f.service.detail(id);
  expect(original.tasks[0]!.phase).toBe('ready');
  f.write({ action: 'plan', workflowId: id, expectedPlanRevision: 1, plan: { ...plan(), tasks: [{ ...plan().tasks[0]!, title: 'New task' }] } });
  const staged = f.service.detail(id);
  expect(staged.active).toEqual(original.active);
  expect(staged.tasks).toEqual(original.tasks);
  f.write({ action: 'stop', workflowId: id }, local);
  expect(f.service.detail(id).workflow.desired).toBe('paused');
});
test('SQLite excludes unsettled attempts even across generations', () => {
  const f = setup();
  const id = f.create().workflowId;
  f.activate(id);
  f.store.read(database => {
    const insert = database.query(`INSERT INTO attempts (id,workflow_id,task_id,plan_revision,generation,input_digest,
      dispatch_phase,resolution,control_state,request_id,target_json,created_at)
      VALUES (?,?,?,1,?,'sha256:synthetic','dispatching',?,'leased',?,'null','2026-01-01T00:00:00.000Z')`);
    insert.run('first', id, 'check', 1, 'unknown', 'request-one');
    expect(() => insert.run('second', id, 'check', 2, 'open', 'request-two')).toThrow();
    database.query("UPDATE attempts SET resolution='abandoned',control_state='released' WHERE id='first'").run();
    expect(() => insert.run('second', id, 'check', 2, 'open', 'request-two')).toThrow();
    database.query("UPDATE attempts SET dispatch_phase='settled' WHERE id='first'").run();
    insert.run('second', id, 'check', 2, 'open', 'request-two');
  });
});
test('private storage, WAL durability, readonly inspection and missing initialized authority', () => {
  const f = setup();
  f.create();
  for (const suffix of ['', '-wal', '-shm']) expect(statSync(join(f.directory, `workflows.sqlite${suffix}`)).mode & 0o777).toBe(0o600);
  expect(inspectWorkflowProviderReferences(f.directory, true)).toEqual(new Set());
  const missing = join(f.directory, 'missing'); mkdirSync(missing);
  expect(inspectWorkflowProviderReferences(missing, false)).toEqual(new Set());
  expect(inspectWorkflowProviderReferences(missing, true)).toBeNull();
  expect(existsSync(join(missing, 'workflows.sqlite'))).toBe(false);
  symlinkSync(join(f.directory, 'workflows.sqlite'), join(missing, 'workflows.sqlite'));
  expect(inspectWorkflowProviderReferences(missing, true)).toBeNull();
  chmodSync(join(f.directory, 'workflows.sqlite'), 0o644);
  expect(inspectWorkflowProviderReferences(f.directory, true)).toBeNull();
});
test('unknown commit failure rolls back records and fences all subsequent reads', () => {
  const f = setup();
  const first = f.create();
  f.controls.failCommit = true;
  expect(() => f.write({ action: 'pause', workflowId: first.workflowId })).toThrow(expect.objectContaining({ code: 'WORKFLOW_UNAVAILABLE' }));
  expect(() => f.service.list()).toThrow(expect.objectContaining({ code: 'WORKFLOW_UNAVAILABLE' }));
  f.reopen();
  expect(f.service.detail(first.workflowId).workflow.desired).toBe('draft');
  expect(f.service.activity(first.workflowId)).toHaveLength(1);
});
test('corrupt and newer schema storage is never replaced or migrated', () => {
  const f = setup();
  f.create(); f.store.close();
  const path = join(f.directory, 'workflows.sqlite');
  const db = new Database(path); db.exec('PRAGMA user_version=99'); db.close();
  expect(() => new WorkflowStore(f.directory)).toThrow(expect.objectContaining({ code: 'WORKFLOW_UNAVAILABLE' }));
  expect(inspectWorkflowProviderReferences(f.directory, true)).toBeNull();
  const verify = new Database(path, { readonly: true });
  expect(verify.query('PRAGMA user_version').get()).toEqual({ user_version: 99 }); verify.close();
});

test('post-commit invalidation failures do not make a durable mutation appear rejected', () => {
  const f = setup();
  const service = new WorkflowService(f.store, { enabled: () => true,
    onInvalidated() { throw new Error('Synthetic invalidation failure'); } });
  const request = { operationId: crypto.randomUUID(), mutation: { action: 'create', plan: plan(), captainChatId: null } };
  const result = service.execute(request, browser);
  expect(service.execute(request, browser)).toEqual(result);
  expect(service.detail(result.workflowId).draft.plan).toEqual(plan());
});

test('a failed post-commit control callback fences future effects while retaining its mutation result', () => {
  const f = setup(); const id = f.create().workflowId; f.activate(id);
  const service = new WorkflowService(f.store, { enabled: () => true,
    onControl() { throw new Error('Synthetic control failure'); } });
  const request = { operationId: crypto.randomUUID(), mutation: { action: 'stop', workflowId: id } };
  const result = service.execute(request, browser);
  expect(() => service.detail(id)).toThrow(expect.objectContaining({ code: 'WORKFLOW_UNAVAILABLE' }));
  f.reopen();
  expect(f.service.execute(request, browser)).toEqual(result);
  expect(f.service.detail(id).workflow.desired).toBe('paused');
});
