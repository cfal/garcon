import type { ExecutionGitService, ExecutorCallOptions } from '@garcon/server-agent-interface';
import { AgentCallError } from '@garcon/server-agent-interface';
import type { GitMethod } from '../../../common/git.js';
import type { ExecutionGitRequests, ExecutionGitResults } from '../../../common/git-execution.js';
import { GIT_OPERATION_TIMEOUT_MS, isGitMutation } from '../../../common/git-execution.js';
import { GitServiceError } from '../../../common/git-error.js';
import { validateGitRequest } from '../../../common/git-request-validation.js';
import type { GitCommandTrace, GitReviewRouteMetrics } from '../../runtime/git/types.js';
import { GitDomainError } from '../../runtime/git/git-types.js';
import { gitHttpError } from '../git/http-error.js';
import { classifyGitError } from '../../runtime/git/git-error-classifier.js';
import { jsonError, jsonErrorFromUnknown } from '../../common/http-error.js';
import { isDomainError } from '../../common/domain-error.js';
import { executorIdFromValue } from './executor-target.js';

export type GitServiceResolver = (executorId: string) => Promise<ExecutionGitService>;
interface RouteCallOptions {
  executorId: unknown;
  signal?: AbortSignal;
  trace?: GitCommandTrace[];
  metrics?: GitReviewRouteMetrics;
}
export type GitRouteService = {
  [K in GitMethod]: (input: ExecutionGitRequests[K] & RouteCallOptions) => Promise<ExecutionGitResults[K]>;
} & { toHttpError(error: unknown): Response };

export function gitRouteFailure(error: unknown): Response {
  if (error instanceof GitServiceError) return jsonError(error.message, error.status, error.code, false);
  if (error instanceof GitDomainError) return gitHttpError(error, classifyGitError);
  if (error instanceof AgentCallError || isDomainError(error)) return jsonErrorFromUnknown(error);
  return jsonError('Internal server error', 500, 'INTERNAL_ERROR', false);
}

export function createGitRouteService(resolve: GitServiceResolver, timeoutMs = GIT_OPERATION_TIMEOUT_MS): GitRouteService {
  async function invoke<K extends GitMethod>(method: K, options: ExecutionGitRequests[K] & RouteCallOptions): Promise<ExecutionGitResults[K]> {
    const { executorId, trace, metrics, signal, ...input } = options;
    const target = executorIdFromValue(executorId);
    validateGitRequest(method, input);
    const service = await resolve(target);
    const call = service[method] as (request: ExecutionGitRequests[K], options: ExecutorCallOptions) => Promise<ExecutionGitResults[K]>;
    const { diagnostics, ...result } = await call(input, { signal, timeoutMs });
    if (result.executorId !== target) throw new GitServiceError(isGitMutation(method) ? 'GIT_MUTATION_OUTCOME_UNKNOWN' : 'GIT_INVALID_RESULT', 'Git returned a different executor');
    if (diagnostics) {
      trace?.push(...diagnostics.commands.map(({ command, ...detail }) => ({ args: [command], ...detail })));
      if (metrics) {
        const { commands: _commands, phases, ...counts } = diagnostics;
        metrics.phases.push(...phases);
        Object.assign(metrics, counts);
      }
    }
    return result as ExecutionGitResults[K];
  }
  return {
    toHttpError: gitRouteFailure,
    getStatus: (options) => invoke('getStatus', options),
    initialCommit: (options) => invoke('initialCommit', options),
    commit: (options) => invoke('commit', options),
    getBranches: (options) => invoke('getBranches', options),
    getRefs: (options) => invoke('getRefs', options),
    checkout: (options) => invoke('checkout', options),
    createBranch: (options) => invoke('createBranch', options),
    getHistoryCommits: (options) => invoke('getHistoryCommits', options),
    getCommitSnapshot: (options) => invoke('getCommitSnapshot', options),
    getRemoteStatus: (options) => invoke('getRemoteStatus', options),
    fetch: (options) => invoke('fetch', options),
    pull: (options) => invoke('pull', options),
    push: (options) => invoke('push', options),
    getRemotes: (options) => invoke('getRemotes', options),
    discard: (options) => invoke('discard', options),
    deleteUntracked: (options) => invoke('deleteUntracked', options),
    getWorkbenchSnapshot: (options) => invoke('getWorkbenchSnapshot', options),
    getWorkingTreeFingerprint: (options) => invoke('getWorkingTreeFingerprint', options),
    getQuickSummary: (options) => invoke('getQuickSummary', options),
    getReviewDocumentFileBodies: (options) => invoke('getReviewDocumentFileBodies', options),
    stageSelection: (options) => invoke('stageSelection', options),
    stageHunk: (options) => invoke('stageHunk', options),
    getWorktrees: (options) => invoke('getWorktrees', options),
    getTargetCandidates: (options) => invoke('getTargetCandidates', options),
    createWorktree: (options) => invoke('createWorktree', options),
    removeWorktree: (options) => invoke('removeWorktree', options),
    commitIndex: (options) => invoke('commitIndex', options),
    stagePaths: (options) => invoke('stagePaths', options),
    revertCommit: (options) => invoke('revertCommit', options),
    getConflicts: (options) => invoke('getConflicts', options),
    getConflictDetails: (options) => invoke('getConflictDetails', options),
    acceptConflictSide: (options) => invoke('acceptConflictSide', options),
    markConflictResolved: (options) => invoke('markConflictResolved', options),
    getStashes: (options) => invoke('getStashes', options),
    createStash: (options) => invoke('createStash', options),
    applyStash: (options) => invoke('applyStash', options),
    popStash: (options) => invoke('popStash', options),
    dropStash: (options) => invoke('dropStash', options),
    getFileHistory: (options) => invoke('getFileHistory', options),
    getBlame: (options) => invoke('getBlame', options),
    getGraph: (options) => invoke('getGraph', options),
    getRepoInfo: (options) => invoke('getRepoInfo', options),
    collectCommitMessageContext: (options) => invoke('collectCommitMessageContext', options),
    getComparisonSnapshot: (options) => invoke('getComparisonSnapshot', options),
    getComparisonFreshness: (options) => invoke('getComparisonFreshness', options),
  };
}
