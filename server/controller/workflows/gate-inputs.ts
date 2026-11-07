import type { Database } from 'bun:sqlite';
import type { WorkflowApprovalManifest } from '../../../common/workflows.js';
import { workflowConflict } from './errors.js';
import { readDependencyArtifacts, readWorkflowSchedule } from './records.js';

export function workflowGateInputs(db: Database, workflowId: string, gateId: string) {
  return workflowGateInputsFromSchedule(db, readWorkflowSchedule(db, workflowId), gateId);
}

export function workflowGateInputsFromSchedule(db: Database, schedule: ReturnType<typeof readWorkflowSchedule>, gateId: string) {
  const { workflow, active: plan } = schedule;
  if (workflow.archived || workflow.desired === 'canceled' || plan === null) workflowConflict('Approval is no longer current.');
  const definition = plan.plan.tasks.find(task => task.id === gateId);
  const task = schedule.tasks.find(task => task.id === gateId);
  if (!definition || definition.spec.kind !== 'approval' || !task || task.hold !== 'none') workflowConflict('Approval gate changed.');
  if (!definition.dependsOn.every(id => schedule.tasks.some(dependency => dependency.id === id && dependency.phase === 'succeeded'))) {
    workflowConflict('Approval dependencies are not complete.');
  }
  const dependencies = readDependencyArtifacts(db, workflow.id, definition.dependsOn);
  const manifest: WorkflowApprovalManifest = { gateId, taskId: gateId, generation: task.generation,
    planRevision: plan.revision, planDigest: plan.digest,
    artifacts: dependencies.map(({ id, digest }) => ({ id, digest })).sort((a, b) => a.id.localeCompare(b.id)), publication: null };
  return { workflow, plan, definition, task, dependencies, manifest };
}
