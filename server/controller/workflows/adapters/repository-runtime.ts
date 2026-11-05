import { AgentCallError, type ExecutionRuntimeApi } from '@garcon/server-agent-interface';
import { GitServiceError } from '../../../../common/git-error.js';
import { GIT_OPERATION_TIMEOUT_MS } from '../../../../common/git-execution.js';
import type { WorkflowManagedTarget } from '../../../../common/workflows.js';
import { workflowConflict } from '../errors.js';
import { workflowDigest } from '../inputs.js';

export type WorkflowRuntimeResolver = (executorId: string) => Promise<Pick<ExecutionRuntimeApi, 'getGitService' | 'getProjectService'>>;

export function definitelyNotDispatched(error: unknown): boolean {
  return error instanceof AgentCallError && error.outcome === 'not-dispatched'
    || error instanceof GitServiceError && ['GIT_INVALID_INPUT', 'GIT_SERVICE_BUSY', 'GIT_OUTSIDE_BASE', 'GIT_UNAVAILABLE'].includes(error.code);
}

export async function inspectWorkflowRepository(resolve: WorkflowRuntimeResolver, resource: WorkflowManagedTarget,
  signal: AbortSignal, ancestors: readonly string[] = []) {
  return inspectRepository(resolve, resource, signal, ancestors, resource.instanceId);
}

export async function inspectRecoveredWorkflowRepository(resolve: WorkflowRuntimeResolver, resource: WorkflowManagedTarget,
  signal: AbortSignal) {
  return inspectRepository(resolve, resource, signal, [], null);
}

async function inspectRepository(resolve: WorkflowRuntimeResolver, resource: WorkflowManagedTarget,
  signal: AbortSignal, ancestors: readonly string[], expectedInstance: string | null) {
  const runtime = await resolve(resource.target.executorId);
  const git = await runtime.getGitService({ signal });
  const request = { projectPath: resource.sourceProjectPath, worktreePath: resource.target.projectPath,
    managedResourceId: resource.managedResourceId, operationId: resource.operationId };
  const options = { signal, timeoutMs: GIT_OPERATION_TIMEOUT_MS };
  signal.throwIfAborted();
  const before = await git.inspectManagedWorktree(request, options);
  if (!before.managed || before.executorId !== resource.target.executorId || expectedInstance !== null && before.instanceId !== expectedInstance) {
    return workflowConflict('Managed output is unavailable on its prepared runtime.');
  }
  const commit = await git.inspectCommit({ projectPath: resource.target.projectPath,
    commit: before.managed.head, ancestor: resource.head }, options);
  const lineage: { commit: string; containsAncestor: boolean | null }[] = [];
  for (const ancestor of ancestors) {
    const inspected = await git.inspectCommit({ projectPath: resource.target.projectPath, commit: before.managed.head, ancestor }, options);
    if (inspected.executorId !== before.executorId || inspected.instanceId !== before.instanceId
      || inspected.commit !== commit.commit || inspected.tree !== commit.tree) return workflowConflict('Integration lineage runtime changed.');
    lineage.push({ commit: ancestor, containsAncestor: inspected.containsAncestor });
  }
  const after = await git.inspectManagedWorktree(request, options);
  signal.throwIfAborted();
  if (commit.executorId !== before.executorId || commit.instanceId !== before.instanceId
    || after.executorId !== before.executorId || after.instanceId !== before.instanceId
    || !after.managed || workflowDigest(after.managed) !== workflowDigest(before.managed)) {
    return workflowConflict('Managed output changed during observation.');
  }
  return { executorId: after.executorId, instanceId: after.instanceId, managed: after.managed, lineage,
    commit: { commit: commit.commit, tree: commit.tree, parents: commit.parents, containsAncestor: commit.containsAncestor } };
}
