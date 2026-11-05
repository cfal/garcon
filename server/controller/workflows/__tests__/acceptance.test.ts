import { afterEach, expect, test } from 'bun:test';
import type { WorkflowApprovalManifest, WorkflowPlanTask } from '../../../../common/workflows.js';
import { requireWorkflowGates } from '../acceptance.js';
import { workflowDigest } from '../inputs.js';
import { fixture, plan } from './fixture.js';

const fixtures: ReturnType<typeof fixture>[] = [];
afterEach(() => fixtures.splice(0).forEach(f => f.cleanup()));

test.each(['matching', 'unapproved', 'rejected', 'generation', 'artifacts'] as const)('approval gate rechecks its exact manifest: %s', kind => {
  const f = fixture(); fixtures.push(f);
  const check = { ...plan().tasks[0]!, dependsOn: ['gate'], acceptance: [{ kind: 'approval' as const, taskId: 'gate' }] };
  if (check.spec.kind !== 'command') throw new Error('Synthetic task kind.');
  const gate: WorkflowPlanTask = { ...check, id: 'gate', dependsOn: [], acceptance: [],
    spec: { kind: 'approval', purpose: 'manual', requirements: [] } };
  const workflowId = f.write({ action: 'create', captainChatId: null, plan: { ...plan(), tasks: [gate, check] } }).workflowId;
  f.activate(workflowId);
  const manifest: WorkflowApprovalManifest = { gateId: gate.id, taskId: gate.id, planRevision: 1,
    planDigest: f.service.detail(workflowId).active!.digest, generation: kind === 'generation' ? 2 : 1,
    artifacts: kind === 'artifacts' ? [{ id: 'synthetic-artifact', digest: workflowDigest('synthetic') }] : [], publication: null };
  const manifestDigest = workflowDigest(manifest);
  f.store.transaction(db => db.query('INSERT INTO gate_manifests VALUES (?,?,?,?)')
    .run(workflowId, gate.id, manifestDigest, JSON.stringify(manifest)));
  if (kind !== 'unapproved') f.write({ action: 'approve', workflowId, gateId: gate.id, manifestDigest,
    decision: kind === 'rejected' ? 'reject' : 'approve' });
  const target = check.spec.target;
  const verify = () => f.store.read(db => requireWorkflowGates(db, { workflowId, target }, check, target.baseCommit));
  if (kind === 'matching') expect(verify).not.toThrow();
  else expect(verify).toThrow();
});
