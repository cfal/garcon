import { rpcWireV1 } from '../transport/rpc-wire-v1.js';
import { AgentCallError, type ExecutionGitService, type ExecutionGhService, type ExecutorCallOptions } from '@garcon/server-agent-interface';
import type { GitMethod } from '../../../common/git.js';
import { isGhMutation, type GhRequests } from '../../../common/gh.js';
import { GIT_OPERATION_TIMEOUT_MS, ghOperationTimeoutMs, isGitMutation, type ExecutionGitRequests, type ExecutionGitResults, type ExecutionGhResults } from '../../../common/git-execution.js';
import { validateGitRequest, validateGhRequest } from '../../../common/git-request-validation.js';
import { validateGitResult, validateGhResult } from '../../../common/git-result-validation.js';
import { GitServiceError } from '../../../common/git-error.js';
import type { RemoteSessions } from './executor-client.js';
import { rpcLane } from '../transport/rpc-routing.js';
import { RPC_V1 } from '@garcon/common/executor-contracts';

export class RemoteGitServices {
  readonly git: ExecutionGitService;
  readonly gh: ExecutionGhService;

  constructor(private readonly sessions: RemoteSessions) {
    this.git = {
      getStatus: (request, options) => this.#gitCall('getStatus', request, options),
      initialCommit: (request, options) => this.#gitCall('initialCommit', request, options),
      commit: (request, options) => this.#gitCall('commit', request, options),
      getBranches: (request, options) => this.#gitCall('getBranches', request, options),
      getRefs: (request, options) => this.#gitCall('getRefs', request, options),
      checkout: (request, options) => this.#gitCall('checkout', request, options),
      createBranch: (request, options) => this.#gitCall('createBranch', request, options),
      getRemoteStatus: (request, options) => this.#gitCall('getRemoteStatus', request, options),
      getRemotes: (request, options) => this.#gitCall('getRemotes', request, options),
      fetch: (request, options) => this.#gitCall('fetch', request, options),
      pull: (request, options) => this.#gitCall('pull', request, options),
      push: (request, options) => this.#gitCall('push', request, options),
      discard: (request, options) => this.#gitCall('discard', request, options),
      deleteUntracked: (request, options) => this.#gitCall('deleteUntracked', request, options),
      getWorkbenchSnapshot: (request, options) => this.#gitCall('getWorkbenchSnapshot', request, options),
      getWorkingTreeFingerprint: (request, options) => this.#gitCall('getWorkingTreeFingerprint', request, options),
      getQuickSummary: (request, options) => this.#gitCall('getQuickSummary', request, options),
      getReviewDocumentFileBodies: (request, options) => this.#gitCall('getReviewDocumentFileBodies', request, options),
      getHistoryCommits: (request, options) => this.#gitCall('getHistoryCommits', request, options),
      getCommitSnapshot: (request, options) => this.#gitCall('getCommitSnapshot', request, options),
      getComparisonSnapshot: (request, options) => this.#gitCall('getComparisonSnapshot', request, options),
      getComparisonFreshness: (request, options) => this.#gitCall('getComparisonFreshness', request, options),
      stageSelection: (request, options) => this.#gitCall('stageSelection', request, options),
      stageHunk: (request, options) => this.#gitCall('stageHunk', request, options),
      getConflicts: (request, options) => this.#gitCall('getConflicts', request, options),
      getConflictDetails: (request, options) => this.#gitCall('getConflictDetails', request, options),
      acceptConflictSide: (request, options) => this.#gitCall('acceptConflictSide', request, options),
      markConflictResolved: (request, options) => this.#gitCall('markConflictResolved', request, options),
      getStashes: (request, options) => this.#gitCall('getStashes', request, options),
      createStash: (request, options) => this.#gitCall('createStash', request, options),
      applyStash: (request, options) => this.#gitCall('applyStash', request, options),
      popStash: (request, options) => this.#gitCall('popStash', request, options),
      dropStash: (request, options) => this.#gitCall('dropStash', request, options),
      getFileHistory: (request, options) => this.#gitCall('getFileHistory', request, options),
      getBlame: (request, options) => this.#gitCall('getBlame', request, options),
      getGraph: (request, options) => this.#gitCall('getGraph', request, options),
      getRepoInfo: (request, options) => this.#gitCall('getRepoInfo', request, options),
      getWorktrees: (request, options) => this.#gitCall('getWorktrees', request, options),
      getTargetCandidates: (request, options) => this.#gitCall('getTargetCandidates', request, options),
      createWorktree: (request, options) => this.#gitCall('createWorktree', request, options),
      removeWorktree: (request, options) => this.#gitCall('removeWorktree', request, options),
      commitIndex: (request, options) => this.#gitCall('commitIndex', request, options),
      stagePaths: (request, options) => this.#gitCall('stagePaths', request, options),
      revertCommit: (request, options) => this.#gitCall('revertCommit', request, options),
      collectCommitMessageContext: (request, options) => this.#gitCall('collectCommitMessageContext', request, options),
    };
    this.gh = {
      getStatus: (options) => this.#ghCall('getStatus', {}, options),
      listPullRequests: (request, options) => this.#ghCall('listPullRequests', request, options),
      getPullRequest: (request, options) => this.#ghCall('getPullRequest', request, options),
      getPullRequestReviewTarget: (request, options) => this.#ghCall('getPullRequestReviewTarget', request, options),
      createPullRequestComment: (request, options) => this.#ghCall('createPullRequestComment', request, options),
      minimizePullRequestComment: (request, options) => this.#ghCall('minimizePullRequestComment', request, options),
    };
  }

  async #gitCall<K extends GitMethod>(method: K, request: ExecutionGitRequests[K], options?: ExecutorCallOptions): Promise<ExecutionGitResults[K]> {
    validateGitRequest(method, request);
    if (!this.sessions.latest().info.services.git) throw new AgentCallError('not-dispatched', 'Git is unavailable on this executor', 'OPERATION_UNSUPPORTED');
    const mutation = isGitMutation(method);
    try {
      return await withDeadline(options, GIT_OPERATION_TIMEOUT_MS, async (callOptions) => {
        const contract: (typeof RPC_V1)[`git.${GitMethod}`] = RPC_V1[`git.${method}`];
        const { backing, timeoutMs } = await this.sessions.acquire(rpcLane(contract, request), callOptions);
        const budgetMs = timeoutMs ?? callOptions.timeoutMs;
        const result = await backing.rpc.call('', contract, { input: request, budgetMs }, { ...callOptions, timeoutMs: budgetMs })
          .catch(error => { throw mutation ? error : readFailure(error, callOptions.signal); });
        validateGitResult(method, result, backing.info);
        return result;
      });
    } catch (error) {
      if (mutation && (error instanceof AgentCallError && error.outcome === 'unknown'
        || error instanceof GitServiceError && error.code === 'GIT_INVALID_RESULT')) {
        throw new GitServiceError('GIT_MUTATION_OUTCOME_UNKNOWN', 'Git mutation could not be confirmed. Inspect the repository before trying again.');
      }
      throw error;
    }
  }

  async #ghCall<K extends keyof GhRequests>(method: K, request: GhRequests[K], options?: ExecutorCallOptions): Promise<ExecutionGhResults[K]> {
    validateGhRequest(method, request);
    if (!this.sessions.latest().info.services.gh) throw new AgentCallError('not-dispatched', 'GitHub CLI is unavailable on this executor', 'OPERATION_UNSUPPORTED');
    const mutation = isGhMutation(method);
    try {
      return await withDeadline(options, ghOperationTimeoutMs(method), async (callOptions) => {
        const { backing, timeoutMs } = await this.sessions.acquire('bulk', callOptions);
        const budgetMs = timeoutMs ?? callOptions.timeoutMs;
        const wire = rpcWireV1(`gh.${method}`);
        const result = await backing.rpc.call('', wire.definition, wire.request({ input: request, budgetMs }), { ...callOptions, timeoutMs: budgetMs })
          .catch(error => { throw mutation ? error : readFailure(error, callOptions.signal); });
        validateGhResult(method, result, backing.info);
        return result;
      });
    } catch (error) {
      if (mutation && (error instanceof AgentCallError && error.outcome === 'unknown'
        || error instanceof GitServiceError && error.code === 'GIT_INVALID_RESULT')) {
        throw new GitServiceError('GIT_MUTATION_OUTCOME_UNKNOWN', 'GitHub change could not be confirmed. Check the pull request before trying again.');
      }
      throw error;
    }
  }
}

function readFailure(error: unknown, signal?: AbortSignal): unknown {
  return signal?.aborted && error instanceof AgentCallError && error.outcome === 'unknown'
    ? new GitServiceError('GIT_TIMEOUT', 'Git operation expired or was cancelled')
    : error;
}

async function withDeadline<T>(options: ExecutorCallOptions | undefined, maximum: number, operation: (options: ExecutorCallOptions & { timeoutMs: number }) => Promise<T>): Promise<T> {
  const timeoutMs = Math.max(1, Math.min(options?.timeoutMs ?? maximum, maximum));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref();
  const signal = options?.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  try { return await operation({ ...options, timeoutMs, signal }); }
  finally { clearTimeout(timer); }
}

export const GIT_RPC_CLIENTS = Object.freeze([
  rpcWireV1('gh.createPullRequestComment'),
  rpcWireV1('gh.getPullRequest'),
  rpcWireV1('gh.getPullRequestReviewTarget'),
  rpcWireV1('gh.getStatus'),
  rpcWireV1('gh.listPullRequests'),
  rpcWireV1('gh.minimizePullRequestComment'),
  rpcWireV1('git.acceptConflictSide'),
  rpcWireV1('git.applyStash'),
  rpcWireV1('git.checkout'),
  rpcWireV1('git.collectCommitMessageContext'),
  rpcWireV1('git.commit'),
  rpcWireV1('git.commitIndex'),
  rpcWireV1('git.createBranch'),
  rpcWireV1('git.createStash'),
  rpcWireV1('git.createWorktree'),
  rpcWireV1('git.deleteUntracked'),
  rpcWireV1('git.discard'),
  rpcWireV1('git.dropStash'),
  rpcWireV1('git.fetch'),
  rpcWireV1('git.getBlame'),
  rpcWireV1('git.getBranches'),
  rpcWireV1('git.getCommitSnapshot'),
  rpcWireV1('git.getComparisonFreshness'),
  rpcWireV1('git.getComparisonSnapshot'),
  rpcWireV1('git.getConflictDetails'),
  rpcWireV1('git.getConflicts'),
  rpcWireV1('git.getFileHistory'),
  rpcWireV1('git.getGraph'),
  rpcWireV1('git.getHistoryCommits'),
  rpcWireV1('git.getQuickSummary'),
  rpcWireV1('git.getRefs'),
  rpcWireV1('git.getRemoteStatus'),
  rpcWireV1('git.getRemotes'),
  rpcWireV1('git.getRepoInfo'),
  rpcWireV1('git.getReviewDocumentFileBodies'),
  rpcWireV1('git.getStashes'),
  rpcWireV1('git.getStatus'),
  rpcWireV1('git.getTargetCandidates'),
  rpcWireV1('git.getWorkbenchSnapshot'),
  rpcWireV1('git.getWorkingTreeFingerprint'),
  rpcWireV1('git.getWorktrees'),
  rpcWireV1('git.initialCommit'),
  rpcWireV1('git.markConflictResolved'),
  rpcWireV1('git.popStash'),
  rpcWireV1('git.pull'),
  rpcWireV1('git.push'),
  rpcWireV1('git.removeWorktree'),
  rpcWireV1('git.revertCommit'),
  rpcWireV1('git.stageHunk'),
  rpcWireV1('git.stagePaths'),
  rpcWireV1('git.stageSelection'),
] as const);
