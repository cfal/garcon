import { AgentCallError, type ExecutionGitService, type ExecutionGhService, type NodeCallOptions } from '@garcon/server-agent-interface';
import type { GitMethod } from '../../common/git.js';
import { GIT_OPERATION_TIMEOUT_MS, GH_DETAIL_TIMEOUT_MS, isGitMutation, type ExecutionGitRequests, type ExecutionGitResults, type ExecutionGhResults } from '../../common/git-execution.js';
import { validateGitRequest, validateGhRequest } from '../../common/git-request-validation.js';
import { validateGitResult, validateGhResult } from '../../common/git-result-validation.js';
import { GitServiceError } from '../../common/git-error.js';
import type { RemoteSessionBacking } from './remote.js';

export class RemoteGitServices {
  readonly git: ExecutionGitService;
  readonly gh: ExecutionGhService;

  constructor(private readonly backing: () => RemoteSessionBacking) {
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
    };
  }

  async #gitCall<K extends GitMethod>(method: K, request: ExecutionGitRequests[K], options?: NodeCallOptions): Promise<ExecutionGitResults[K]> {
    validateGitRequest(method, request);
    const backing = this.backing();
    if (!backing.info.services.git) throw new AgentCallError('not-dispatched', 'Git is unavailable on this node', 'OPERATION_UNSUPPORTED');
    const mutation = isGitMutation(method);
    try {
      return await withDeadline(options, GIT_OPERATION_TIMEOUT_MS, async (callOptions) => {
        const result = await backing.rpc.call('', `git.${method}`, { input: request, budgetMs: callOptions.timeoutMs }, callOptions);
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

  async #ghCall<K extends keyof ExecutionGhResults>(method: K, request: { projectPath?: string; number?: number }, options?: NodeCallOptions): Promise<ExecutionGhResults[K]> {
    validateGhRequest(method, request);
    const backing = this.backing();
    if (!backing.info.services.gh) throw new AgentCallError('not-dispatched', 'GitHub CLI is unavailable on this node', 'OPERATION_UNSUPPORTED');
    return withDeadline(options, method === 'getPullRequest' ? GH_DETAIL_TIMEOUT_MS : GIT_OPERATION_TIMEOUT_MS, async (callOptions) => {
      const budgetMs = callOptions.timeoutMs;
      let result: unknown;
      if (method === 'getStatus') result = await backing.rpc.call('', 'gh.getStatus', { input: {}, budgetMs }, callOptions);
      else if (method === 'listPullRequests') result = await backing.rpc.call('', 'gh.listPullRequests', { input: { projectPath: request.projectPath! }, budgetMs }, callOptions);
      else result = await backing.rpc.call('', 'gh.getPullRequest', { input: { projectPath: request.projectPath!, number: request.number! }, budgetMs }, callOptions);
      validateGhResult(method, result, backing.info);
      return result;
    });
  }
}

async function withDeadline<T>(options: NodeCallOptions | undefined, maximum: number, operation: (options: NodeCallOptions & { timeoutMs: number }) => Promise<T>): Promise<T> {
  const timeoutMs = Math.max(1, Math.min(options?.timeoutMs ?? maximum, maximum));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref();
  const signal = options?.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  try { return await operation({ timeoutMs, signal }); }
  finally { clearTimeout(timer); }
}
