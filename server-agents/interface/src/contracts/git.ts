import type { GitMethod } from '@garcon/common/git';
import type { ExecutionGitRequests, ExecutionGitResults, ExecutionGhResults } from '@garcon/common/git-execution';
import type { GhRequests } from '@garcon/common/gh';
import type { ExecutorCallOptions } from './resources.js';

export type ExecutionGitService = {
  [K in GitMethod]: (request: ExecutionGitRequests[K], options?: ExecutorCallOptions) => Promise<ExecutionGitResults[K]>;
};

export interface ExecutionGhService {
  getStatus(options?: ExecutorCallOptions): Promise<ExecutionGhResults['getStatus']>;
  listPullRequests(request: GhRequests['listPullRequests'], options?: ExecutorCallOptions): Promise<ExecutionGhResults['listPullRequests']>;
  getPullRequest(request: GhRequests['getPullRequest'], options?: ExecutorCallOptions): Promise<ExecutionGhResults['getPullRequest']>;
  getPullRequestReviewTarget(request: GhRequests['getPullRequestReviewTarget'], options?: ExecutorCallOptions): Promise<ExecutionGhResults['getPullRequestReviewTarget']>;
  createPullRequestComment(request: GhRequests['createPullRequestComment'], options?: ExecutorCallOptions): Promise<ExecutionGhResults['createPullRequestComment']>;
  minimizePullRequestComment(request: GhRequests['minimizePullRequestComment'], options?: ExecutorCallOptions): Promise<ExecutionGhResults['minimizePullRequestComment']>;
}
