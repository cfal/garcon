import type { Database } from 'bun:sqlite';
import type { IntegrateCommitsRequest } from '../../../common/git-delivery.js';
import type { WorkflowAttempt, WorkflowCommitInput, WorkflowManagedTarget } from '../../../common/workflows.js';
import { readWorkflowCommitSources } from './commit-inputs.js';
import { workflowConflict } from './errors.js';
import { workflowDigest } from './inputs.js';
import { readPlan } from './records.js';
import { requireOperation } from './resource-dispatch.js';

export interface WorkflowIntegrationManifest {
  readonly version: 1;
  readonly attemptId: string;
  readonly inputDigest: string;
  readonly resource: WorkflowManagedTarget;
  readonly inputs: readonly WorkflowCommitInput[];
  readonly request: IntegrateCommitsRequest;
}

export function workflowIntegrationManifest(db: Database, attempt: WorkflowAttempt): WorkflowIntegrationManifest {
  const task = readPlan(db, attempt.workflowId, attempt.planRevision).plan.tasks.find(task => task.id === attempt.taskId)!;
  const resource = attempt.managedTarget;
  if (task.spec.kind !== 'integrate' || !resource || attempt.chatId || attempt.turnId || attempt.serverInstanceId || attempt.effectiveInput) {
    return workflowConflict('Integration requires an owned non-chat attempt.');
  }
  const inputs = readWorkflowCommitSources(db, attempt, task).map(source => source.input);
  return { version: 1, attemptId: attempt.attemptId, inputDigest: attempt.inputDigest, resource, inputs,
    request: { projectPath: resource.sourceProjectPath, worktreePath: resource.target.projectPath,
      managedResourceId: resource.managedResourceId, operationId: resource.operationId,
      expectedRepositoryIdentity: resource.repositoryIdentity, expectedWorktreeIdentity: resource.worktreeIdentity,
      expectedHead: resource.head, expectedBranch: resource.branch, commits: inputs.map(input => input.commit), strategy: 'ordered-merge' } };
}

export function requireIntegrationOperation(db: Database, attempt: WorkflowAttempt, operationId: string) {
  const operation = requireOperation(db, operationId);
  const manifest = workflowIntegrationManifest(db, attempt);
  const digest = workflowDigest(manifest);
  let payload: unknown;
  try { payload = JSON.parse(operation.payload); }
  catch { return workflowConflict('Integration intent is invalid.'); }
  if (operation.attemptId !== attempt.attemptId || operation.kind !== 'integrate'
    || operation.resourceKey !== manifest.resource.resourceKey || workflowDigest(payload) !== workflowDigest({ manifest, digest })
    || db.query<{ count: number }, [string]>("SELECT COUNT(*) AS count FROM operation_intents WHERE attempt_id=? AND kind='integrate'")
      .get(attempt.attemptId)!.count !== 1
    || !db.query('SELECT 1 FROM resource_claims WHERE resource_key=? AND attempt_id=? AND quarantined=0 AND risk_released=0 AND retained=0')
      .get(operation.resourceKey, attempt.attemptId)
    || db.query("SELECT 1 FROM operation_intents WHERE attempt_id=? AND id!=? AND status NOT IN ('succeeded','not-started') LIMIT 1")
      .get(attempt.attemptId, operationId)) {
    return workflowConflict('Integration intent no longer matches its exact prepared inputs.');
  }
  return { operation, manifest, digest };
}
