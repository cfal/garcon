import type { Database } from 'bun:sqlite';
import type { WorkflowAttempt, WorkflowPlanTask } from '../../../common/workflows.js';
import { workflowConflict } from './errors.js';
import { workflowDigest } from './inputs.js';
import { readApprovals, readDependencyArtifacts, readGateManifests, readPlan, readTasks } from './records.js';

export function requireWorkflowGates(db: Database, attempt: Pick<WorkflowAttempt, 'workflowId' | 'target'>,
  task: WorkflowPlanTask, commit: string): void {
  for (const requirement of task.acceptance) {
    if (requirement.kind === 'artifact') continue;
    if (requirement.kind === 'independent-review') {
      const dependencies = readDependencyArtifacts(db, attempt.workflowId, [requirement.taskId]);
      if (!dependencies.some(artifact => artifact.kind === 'review'
        && artifact.provenance === 'agent-asserted' && artifact.outcome === 'pass'
        && artifact.repositoryId === attempt.target?.repositoryId && artifact.commit === commit)) {
        workflowConflict('No current independent review accepts this exact commit.');
      }
    } else {
      const gate = readGateManifests(db, attempt.workflowId).find(value => value.manifest.taskId === requirement.taskId);
      const source = readTasks(db, attempt.workflowId).find(value => value.id === requirement.taskId);
      const approved = gate && readApprovals(db, attempt.workflowId).some(value => value.gateId === gate.manifest.gateId
        && value.manifestDigest === gate.digest && value.decision === 'approve');
      if (!gate || !source || gate.manifest.generation !== source.generation || !approved) {
        workflowConflict('No current exact-manifest approval accepts this input.');
      }
      const definition = readPlan(db, attempt.workflowId, gate.manifest.planRevision).plan.tasks.find(value => value.id === source.id);
      const inputs = definition && readDependencyArtifacts(db, attempt.workflowId, definition.dependsOn)
        .map(({ id, digest }) => ({ id, digest })).sort((a, b) => a.id.localeCompare(b.id));
      if (!inputs || workflowDigest(inputs) !== workflowDigest([...gate.manifest.artifacts].sort((a, b) => a.id.localeCompare(b.id)))
        || gate.manifest.publication && gate.manifest.publication.headCommit !== commit) {
        workflowConflict('Approval inputs changed before evidence acceptance.');
      }
    }
  }
}
