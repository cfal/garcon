import { afterEach, expect, test } from 'bun:test';
import type { WorkflowPlanTask } from '../../../../common/workflows.js';
import { WorkflowApprovals } from '../approvals.js';
import { fixture, local, plan } from './fixture.js';

const fixtures: ReturnType<typeof fixture>[] = [];
afterEach(() => fixtures.splice(0).forEach(f => f.cleanup()));
function setup() {
  const f = fixture(); fixtures.push(f);
  const check = { ...plan().tasks[0]!, dependsOn: ['gate'] };
  const gate: WorkflowPlanTask = { ...check, id: 'gate', title: 'Decision', dependsOn: [],
    spec: { kind: 'approval', purpose: 'manual', requirements: [] } };
  const id = f.write({ action: 'create', captainChatId: null, plan: { ...plan(), tasks: [gate, check] } }).workflowId;
  f.activate(id);
  let invalidations = 0;
  const approvals = new WorkflowApprovals(f.store, { now: () => new Date().toISOString(), onInvalidated: () => invalidations++ });
  return { f, id, approvals, invalidations: () => invalidations };
}

test.each(['approve', 'reject'] as const)('human %s settles a gate without a chat and preserves exact operation recovery', decision => {
  const { f, id, approvals, invalidations } = setup();
  approvals.prepare(id); approvals.prepare(id);
  expect(invalidations()).toBe(1);
  const gate = f.service.detail(id).gates[0]!;
  const operationId = crypto.randomUUID();
  const mutation = { action: 'approve' as const, workflowId: id, gateId: 'gate', manifestDigest: gate.digest, decision };
  expect(() => f.write(mutation, local)).toThrow('browser');
  const result = f.write(mutation, undefined, operationId);
  expect(f.write(mutation, undefined, operationId)).toEqual(result);
  const detail = f.service.detail(id);
  expect(detail.tasks.find(task => task.id === 'gate')?.phase).toBe(decision === 'approve' ? 'succeeded' : 'failed');
  expect(detail.tasks.find(task => task.id === 'check')?.phase).toBe(decision === 'approve' ? 'ready' : 'blocked');
  const attempts = f.service.attempts(id);
  expect(attempts).toHaveLength(1);
  expect(attempts[0]?.chatId).toBeNull();
  expect(attempts[0]?.effectiveInput).toBeNull();
  approvals.prepare(id);
  expect(invalidations()).toBe(1);
});

test('replanning invalidates approval and rejected decisions never repeat automatically', () => {
  const { f, id, approvals } = setup();
  approvals.prepare(id);
  const original = f.service.detail(id);
  f.write({ action: 'plan', workflowId: id, expectedPlanRevision: 1,
    plan: { ...original.draft.plan, tasks: original.draft.plan.tasks.map(task => ({ ...task, title: `${task.title} revised` })) } });
  f.activate(id);
  expect(() => f.write({ action: 'approve', workflowId: id, gateId: 'gate', manifestDigest: original.gates[0]!.digest,
    decision: 'approve' })).toThrow('manifest changed');
  approvals.prepare(id);
  expect(f.service.detail(id).gates[0]?.manifest.generation).toBe(2);
});

test('cancel and dependency changes reject stale approval without leaving an attempt', () => {
  const { f, id, approvals } = setup(); approvals.prepare(id);
  const digest = f.service.detail(id).gates[0]!.digest;
  f.write({ action: 'cancel', workflowId: id });
  expect(() => f.write({ action: 'approve', workflowId: id, gateId: 'gate', manifestDigest: digest, decision: 'approve' })).toThrow('no longer current');
  expect(f.service.attempts(id)).toHaveLength(0);
});
