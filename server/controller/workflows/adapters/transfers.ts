import { AgentCallError, type ExecutionRuntimeApi } from '@garcon/server-agent-interface';
import type { ExactRemoteRefRequest, PushExactRefRequest } from '../../../../common/git-delivery.js';
import { GitServiceError } from '../../../../common/git-error.js';
import { GIT_OPERATION_TIMEOUT_MS, type GitExecutorScope } from '../../../../common/git-execution.js';
import { WORKFLOW_LIMITS, type WorkflowAttempt, type WorkflowPlanTask } from '../../../../common/workflows.js';
import { DomainError } from '../../../common/domain-error.js';
import { readWorkflowCommitSources } from '../commit-inputs.js';
import type { WorkflowEffectFence } from '../contracts.js';
import { workflowConflict } from '../errors.js';
import { workflowDigest, workflowNeedsTransfer } from '../inputs.js';
import { matchesManagedTarget } from '../managed-target.js';
import { readPlan } from '../records.js';
import type { WorkflowResources } from '../resources.js';
import { definitelyNotDispatched, inspectWorkflowRepository, type WorkflowRuntimeResolver } from './repository-runtime.js';

type GitService = Awaited<ReturnType<ExecutionRuntimeApi['getGitService']>>;

export async function prepareWorkflowInputs(resources: WorkflowResources, resolve: WorkflowRuntimeResolver,
  attempt: WorkflowAttempt, task: WorkflowPlanTask, destination: GitExecutorScope & { projectPath: string; git: GitService },
  fence: WorkflowEffectFence): Promise<{ kind: 'available' } | { kind: 'not-started' | 'unknown' | 'held'; detail: string }> {
  if (!('target' in task.spec)) return workflowConflict('Repository inputs require a target.');
  const target = task.spec.target;
  const { sources, policy } = resources.store.read(db => ({ sources: readWorkflowCommitSources(db, attempt, task),
    policy: readPlan(db, attempt.workflowId, attempt.planRevision).plan.policy }));
  const signal = AbortSignal.any([fence.shutdown, fence.revokedSignal]);
  const reads = { signal, timeoutMs: GIT_OPERATION_TIMEOUT_MS };
  const effects = { signal: fence.shutdown, timeoutMs: GIT_OPERATION_TIMEOUT_MS };
  const transfers = [];
  for (const source of sources) {
    if (!workflowNeedsTransfer(source.approvedTarget, target)) {
      await inspectInput(source.input.commit);
      continue;
    }
    let observation;
    try { observation = await inspectWorkflowRepository(resolve, source.managed, signal); }
    catch (error) {
      if (error instanceof DomainError && error.code === 'WORKFLOW_CONFLICT'
        || error instanceof GitServiceError && ['GIT_INVALID_INPUT', 'GIT_NOT_REPO'].includes(error.code)) {
        return { kind: 'held', detail: 'Transfer source identity changed or is unavailable; operator resolution is required.' };
      }
      throw error;
    }
    if (!matchesManagedTarget(source.managed, observation.managed) || observation.managed.dirty
      || observation.managed.head !== source.input.commit || observation.commit.commit !== source.input.commit
      || observation.commit.tree !== source.outputTree || observation.commit.containsAncestor !== true) {
      return { kind: 'held', detail: 'Source commit no longer matches its retained managed output; operator resolution is required.' };
    }
    const remote = source.approvedTarget.remote;
    if (!policy.allowRemoteWrites || !remote || !target.remote || remote.url !== target.remote.url) {
      return workflowConflict('Cross-clone inputs require an explicitly shared approved remote.');
    }
    const sourceGit = await (await resolve(source.approvedTarget.executorId)).getGitService(reads);
    const ref = `refs/heads/garcon/transfers/${crypto.randomUUID()}`;
    const push: PushExactRefRequest = { projectPath: source.managed.sourceProjectPath, remote: remote.name,
      expectedRemoteUrl: remote.url, ref, commit: source.input.commit, expectedRemoteCommit: null };
    const fetch: ExactRemoteRefRequest = { projectPath: destination.projectPath, remote: target.remote.name,
      expectedRemoteUrl: target.remote.url, ref, commit: source.input.commit };
    const sourceScope = { executorId: source.approvedTarget.executorId, instanceId: source.managed.instanceId };
    const destinationScope = { executorId: destination.executorId, instanceId: destination.instanceId };
    const binding = { version: 1, input: source.input, source: sourceScope, destination: destinationScope, push, fetch };
    const pushIntent = { operationId: crypto.randomUUID(), attemptId: attempt.attemptId, kind: 'transfer' as const,
      executorId: sourceScope.executorId, resourceKey: workflowDigest({ remoteUrl: remote.url, ref }),
      payload: JSON.stringify({ ...binding, direction: 'push' }) };
    const fetchIntent = { operationId: crypto.randomUUID(), attemptId: attempt.attemptId, kind: 'transfer' as const,
      executorId: destination.executorId, resourceKey: workflowDigest({ executorId: destination.executorId, projectPath: destination.projectPath, ref }),
      payload: JSON.stringify({ ...binding, direction: 'fetch' }) };
    transfers.push({ pushIntent, fetchIntent, push, fetch, sourceScope, sourceGit });
  }
  // Persists both immutable endpoint intents before any remote write, with room checked for preparation and settlement.
  const futureOperations = task.spec.kind === 'publish-pr' ? 3 : task.spec.kind === 'integrate' ? 2 : 1;
  const intents = transfers.flatMap(transfer => [transfer.pushIntent, transfer.fetchIntent]);
  resources.preflight(attempt.attemptId, intents.length + futureOperations,
    intents.reduce((bytes, intent) => bytes + Buffer.byteLength(intent.payload) + WORKFLOW_LIMITS.evidenceBytes, 0)
      + futureOperations * 2 * WORKFLOW_LIMITS.evidenceBytes);
  for (const intent of intents) resources.plan(intent);
  for (const transfer of transfers) {
    const pushed = await mutate('push', transfer.pushIntent.operationId, transfer.sourceScope, transfer.push,
      () => transfer.sourceGit.pushExactRef(transfer.push, { ...effects, instanceId: transfer.sourceScope.instanceId }));
    if (pushed.kind !== 'available') return pushed;
    const fetched = await mutate('fetch', transfer.fetchIntent.operationId, destination, transfer.fetch,
      () => destination.git.fetchExactRef(transfer.fetch, { ...effects, instanceId: destination.instanceId }));
    if (fetched.kind !== 'available') return fetched;
    await inspectInput(transfer.fetch.commit);
  }
  return { kind: 'available' };

  async function inspectInput(commit: string): Promise<void> {
    const inspected = await destination.git.inspectCommit({ projectPath: destination.projectPath, commit, ancestor: target.baseCommit }, reads);
    if (inspected.executorId !== destination.executorId || inspected.instanceId !== destination.instanceId
      || inspected.commit !== commit || inspected.containsAncestor !== true) workflowConflict('Transferred input lineage or runtime changed.');
  }

  async function mutate(direction: 'push' | 'fetch', operationId: string, scope: GitExecutorScope, request: ExactRemoteRefRequest,
    run: () => Promise<GitExecutorScope & { success: true; ref: string; commit: string }>) {
    resources.begin(operationId, fence);
    try {
      const result = await run();
      if (result.executorId !== scope.executorId || result.instanceId !== scope.instanceId
        || result.ref !== request.ref || result.commit !== request.commit || result.success !== true) throw new Error('Transfer identity changed.');
      resources.observe(operationId, 'succeeded', JSON.stringify({ executorId: result.executorId, instanceId: result.instanceId,
        ref: result.ref, commit: result.commit, success: true }));
      return { kind: 'available' as const };
    } catch (error) {
      const kind = definitelyNotDispatched(error) ? 'not-started' as const : 'unknown' as const;
      const staleSource = direction === 'push' && error instanceof AgentCallError
        && error.outcome === 'not-dispatched' && error.code === 'STALE_RESOURCE';
      const detail = staleSource ? 'Transfer source runtime changed before push; operator resolution is required.'
        : kind === 'unknown' ? 'Commit transfer could not be confirmed; retain its ref without replay.'
        : 'Commit transfer was rejected before dispatch.';
      resources.observe(operationId, kind, JSON.stringify({ detail }));
      return { kind: staleSource ? 'held' as const : kind, detail };
    }
  }
}
