import type { Database } from 'bun:sqlite';
import type { WorkflowArtifact, WorkflowAttempt, WorkflowCommitInput, WorkflowManagedTarget,
  WorkflowPlanTask, WorkflowRepositoryTarget } from '../../../common/workflows.js';
import { workflowConflict } from './errors.js';
import { workflowCommitInput, workflowCommitInputIds, workflowDigest } from './inputs.js';
import { readDependencyArtifacts, readPlan, requireAttempt } from './records.js';

export interface WorkflowCommitSource {
  readonly input: WorkflowCommitInput;
  readonly approvedTarget: WorkflowRepositoryTarget;
  readonly managed: WorkflowManagedTarget;
  readonly outputTree: string;
}

export function readWorkflowCommitSources(db: Database, attempt: WorkflowAttempt, task: WorkflowPlanTask): WorkflowCommitSource[] {
  const ids = workflowCommitInputIds(task);
  if (!ids.length) return [];
  if (!('target' in task.spec)) return workflowConflict('Commit inputs require a repository.');
  const repositoryId = task.spec.target.repositoryId;
  const plan = readPlan(db, attempt.workflowId, attempt.planRevision).plan;
  const dependencies = readDependencyArtifacts(db, attempt.workflowId, task.dependsOn);
  return ids.map(taskId => {
    const selected = workflowCommitInput(taskId, repositoryId, dependencies);
    const row = db.query<{ attempt_id: string; payload_json: string }, [string]>(
      'SELECT attempt_id,payload_json FROM artifacts WHERE id=?').get(selected.id);
    if (!row) return workflowConflict('Selected commit artifact disappeared.');
    const artifact: WorkflowArtifact = JSON.parse(row.payload_json);
    const { digest, ...content } = artifact;
    const source = requireAttempt(db, row.attempt_id);
    const managed = source.managedTarget;
    const adopted = artifact.provenance === 'operator-attested' && artifact.git?.scope === 'operator-adopted';
    if (adopted && !db.query('SELECT 1 FROM mutation_results WHERE operation_id=? AND authority_key=?')
      .get(artifact.git.operationId, artifact.git.actor)) return workflowConflict('Adopted commit has no recorded operator decision.');
    const approved = plan.tasks.find(value => value.id === taskId)?.spec;
    if (!approved || !('target' in approved) || !managed || !source.target || !artifact.git
      || digest !== selected.digest || workflowDigest(content) !== digest || artifact.id !== selected.id
      || artifact.attempt.attemptId !== source.attemptId || source.workflowId !== attempt.workflowId || source.taskId !== taskId
      || artifact.attempt.workflowId !== source.workflowId || artifact.attempt.taskId !== taskId
      || artifact.attempt.generation !== source.generation || artifact.attempt.inputDigest !== source.inputDigest
      || artifact.executorId !== managed.target.executorId || approved.target.executorId !== managed.target.executorId
      || !adopted && artifact.git.runtimeInstanceId !== managed.instanceId || artifact.git.repositoryIdentity !== managed.repositoryIdentity
      || artifact.git.worktreeIdentity !== managed.worktreeIdentity || artifact.git.projectPath !== managed.target.projectPath
      || artifact.git.inputCommit !== managed.head || artifact.git.inputTree !== managed.baseTree || artifact.git.containsInput !== true
      || workflowDigest(managed.target) !== workflowDigest(source.target)
      || workflowDigest(managed.target.remote) !== workflowDigest(approved.target.remote)
      || !db.query('SELECT 1 FROM resource_claims WHERE resource_key=? AND attempt_id=? AND retained=1 AND quarantined=0 AND risk_released=0')
        .get(managed.resourceKey, source.attemptId)) {
      return workflowConflict('Selected commit does not match its retained producer evidence.');
    }
    return { input: { taskId, attemptId: source.attemptId, artifactId: artifact.id, digest, commit: selected.commit! },
      approvedTarget: approved.target, managed: adopted ? { ...managed, instanceId: artifact.git.runtimeInstanceId } : managed, outputTree: artifact.git.outputTree };
  });
}
