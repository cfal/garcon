import type { WorkflowManagedTarget } from '../../../common/workflows.js';
import { parseWorkflowRepository, workflowCommit, workflowId, workflowRecord, workflowText } from '../../../common/workflow-validation.js';
import { workflowConflict } from './errors.js';

export function parseManagedTarget(value: unknown): WorkflowManagedTarget {
  try {
    const raw = workflowRecord(value, ['operationId', 'resourceKey', 'target', 'managedResourceId',
      'repositoryIdentity', 'worktreeIdentity', 'branch', 'head']);
    return { operationId: workflowId(raw.operationId), resourceKey: workflowText(raw.resourceKey, 'resource key'),
      target: parseWorkflowRepository(raw.target), managedResourceId: workflowId(raw.managedResourceId),
      repositoryIdentity: workflowText(raw.repositoryIdentity, 'repository identity'),
      worktreeIdentity: workflowText(raw.worktreeIdentity, 'worktree identity'),
      branch: workflowText(raw.branch, 'managed branch', 256), head: workflowCommit(raw.head) };
  } catch { return workflowConflict('Invalid managed repository observation.'); }
}

export function managedTargetRequest(target: WorkflowManagedTarget) {
  return { target: target.target, managedResourceId: target.managedResourceId, branch: target.branch };
}
