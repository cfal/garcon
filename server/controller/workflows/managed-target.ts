import type { WorkflowManagedTarget } from '../../../common/workflows.js';
import { parseWorkflowRepository, workflowCommit, workflowId, workflowRecord, workflowText } from '../../../common/workflow-validation.js';
import { workflowConflict } from './errors.js';
import type { ManagedWorktreeSnapshot } from '../../../common/git-managed-worktrees.js';

export function matchesManagedTarget(input: WorkflowManagedTarget, observed: ManagedWorktreeSnapshot): boolean {
  return observed.operationId === input.operationId && observed.managedResourceId === input.managedResourceId
    && observed.repositoryIdentity === input.repositoryIdentity && observed.worktreeIdentity === input.worktreeIdentity
    && observed.worktreePath === input.target.projectPath && observed.branch === input.branch && observed.baseCommit === input.head;
}

export function parseManagedTarget(value: unknown): WorkflowManagedTarget {
  try {
    const raw = workflowRecord(value, ['operationId', 'resourceKey', 'target', 'managedResourceId',
      'repositoryIdentity', 'worktreeIdentity', 'branch', 'head', 'baseTree', 'instanceId', 'sourceProjectPath']);
    return { operationId: workflowId(raw.operationId), resourceKey: workflowText(raw.resourceKey, 'resource key'),
      target: parseWorkflowRepository(raw.target), managedResourceId: workflowId(raw.managedResourceId),
      repositoryIdentity: workflowText(raw.repositoryIdentity, 'repository identity'),
      worktreeIdentity: workflowText(raw.worktreeIdentity, 'worktree identity'),
      branch: workflowText(raw.branch, 'managed branch', 256), head: workflowCommit(raw.head), baseTree: workflowCommit(raw.baseTree),
      instanceId: workflowText(raw.instanceId, 'runtime instance'), sourceProjectPath: workflowText(raw.sourceProjectPath, 'source project path') };
  } catch { return workflowConflict('Invalid managed repository observation.'); }
}

export function managedTargetRequest(target: WorkflowManagedTarget) {
  return { target: target.target, managedResourceId: target.managedResourceId, branch: target.branch, sourceProjectPath: target.sourceProjectPath };
}
