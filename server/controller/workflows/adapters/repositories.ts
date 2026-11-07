import { GIT_OPERATION_TIMEOUT_MS } from '../../../../common/git-execution.js';
import type { WorkflowManagedTarget } from '../../../../common/workflows.js';
import type { WorkflowEvidenceRepositoryPort, WorkflowRepositoryPort } from '../contracts.js';
import { workflowConflict } from '../errors.js';
import { workflowDigest } from '../inputs.js';
import { managedTargetRequest } from '../managed-target.js';
import type { WorkflowResources } from '../resources.js';
import { definitelyNotDispatched, inspectWorkflowRepository, type WorkflowRuntimeResolver } from './repository-runtime.js';
import { prepareWorkflowInputs } from './transfers.js';

export function createWorkflowRepositoryPort(resources: WorkflowResources,
  resolve: WorkflowRuntimeResolver): WorkflowRepositoryPort & WorkflowEvidenceRepositoryPort {
  return {
    async prepare(attempt, task, fence) {
      const target = attempt.target;
      if (!target || !('target' in task.spec)) return workflowConflict('Repository preparation requires an exact target.');
      if (resources.store.read(db => db.query('SELECT 1 FROM operation_intents WHERE attempt_id=? LIMIT 1')
        .get(attempt.attemptId))) return workflowConflict('An attempt cannot repeat managed creation.');
      const signal = AbortSignal.any([fence.shutdown, fence.revokedSignal]);
      const options = { signal, timeoutMs: GIT_OPERATION_TIMEOUT_MS };
      const runtime = await resolve(target.executorId);
      const git = await runtime.getGitService(options);
      signal.throwIfAborted();
      if (fence.revoked) return workflowConflict('Repository preparation was revoked.');
      const repo = await git.getRepoInfo({ projectPath: target.projectPath }, options);
      if (repo.executorId !== target.executorId || !repo.isGitRepository || !repo.currentWorktreePath) {
        return workflowConflict('Selected executor did not confirm the approved repository.');
      }
      const projects = await runtime.getProjectService(options);
      const destination = await projects.inspect({ projectPath: target.worktreeRoot }, options);
      if (destination.resolution.kind !== 'available' || destination.resolution.effectiveProjectKey !== target.worktreeRoot) {
        return workflowConflict('Managed worktree root must be an existing canonical directory on the selected runtime.');
      }
      const root = await git.getRepoInfo({ projectPath: target.worktreeRoot }, options);
      if (root.executorId !== target.executorId || root.instanceId !== repo.instanceId || root.isGitRepository) {
        return workflowConflict('Managed worktree root must be outside every checkout on the selected runtime.');
      }
      const inputs = await prepareWorkflowInputs(resources, resolve, attempt, task,
        { executorId: repo.executorId, instanceId: repo.instanceId, projectPath: repo.currentWorktreePath, git }, fence);
      if (inputs.kind !== 'available') return inputs;
      const base = await git.inspectCommit({ projectPath: repo.currentWorktreePath, commit: target.baseCommit,
        ancestor: task.spec.target.baseCommit }, options);
      if (base.executorId !== target.executorId || base.instanceId !== repo.instanceId || base.containsAncestor !== true) {
        return workflowConflict('Repository input is not descended from the approved base on this runtime.');
      }
      const managedResourceId = crypto.randomUUID();
      const operationId = crypto.randomUUID();
      const worktreePath = `${target.worktreeRoot.replace(/\/$/, '')}/${managedResourceId}`;
      const branch = `garcon/workflows/${managedResourceId}`;
      const preparedTarget = { ...target, projectPath: worktreePath };
      const resourceKey = workflowDigest({ executorId: target.executorId, worktreePath });
      const planned = { target: preparedTarget, managedResourceId, branch, sourceProjectPath: repo.currentWorktreePath };
      resources.plan({ operationId, attemptId: attempt.attemptId, kind: 'worktree', resourceKey, payload: JSON.stringify(planned) });
      resources.begin(operationId, fence);
      try {
        const created = await git.createManagedWorktree({ projectPath: repo.currentWorktreePath, worktreePath,
          managedResourceId, operationId, branch, baseCommit: target.baseCommit }, { ...options, signal: fence.shutdown, instanceId: repo.instanceId });
        const managed = created.managed;
        if (created.executorId !== target.executorId || created.instanceId !== repo.instanceId || managed.operationId !== operationId
          || managed.managedResourceId !== managedResourceId || managed.branch !== branch || managed.baseCommit !== target.baseCommit
          || managed.head !== target.baseCommit || managed.dirty) throw new Error('Managed creation identity changed.');
        const resource: WorkflowManagedTarget = { operationId, resourceKey, managedResourceId,
          target: { ...preparedTarget, projectPath: managed.worktreePath }, sourceProjectPath: repo.currentWorktreePath,
          repositoryIdentity: managed.repositoryIdentity, worktreeIdentity: managed.worktreeIdentity,
          branch, head: managed.head, baseTree: base.tree, instanceId: created.instanceId };
        // Canonical destinations must be approved before any work is attributed to them.
        if (workflowDigest(planned) !== workflowDigest(managedTargetRequest(resource))) throw new Error('Managed destination was not canonical.');
        resources.observe(operationId, 'succeeded', JSON.stringify(resource));
        return { kind: 'prepared', resource };
      } catch (error) {
        const kind = definitelyNotDispatched(error) ? 'not-started' : 'unknown';
        const detail = kind === 'unknown' ? 'Managed creation could not be confirmed. Retain its operation identity without replay.'
          : 'Managed creation was rejected before dispatch.';
        resources.observe(operationId, kind, JSON.stringify({ detail }));
        return { kind, detail };
      }
    },
    inspect: (resource, signal) => inspectWorkflowRepository(resolve, resource, signal),
  };
}
