import type { GitMethod } from '@garcon/common/git';
import type { ExecutionGitRequests, ExecutionGitResults, ExecutionGhResults } from '@garcon/common/git-execution';
import type { GhRequests } from '@garcon/common/gh';
import type { ExecutorCallOptions } from './resources.js';

export interface GitCallOptions extends ExecutorCallOptions {
  readonly instanceId?: string;
}

export type ExecutionGitService = {
  [K in GitMethod]: (request: ExecutionGitRequests[K], options?: GitCallOptions) => Promise<ExecutionGitResults[K]>;
};

export interface ExecutionGhService {
  getPublicationTarget(request: GhRequests['getPublicationTarget'], options?: GitCallOptions): Promise<ExecutionGhResults['getPublicationTarget']>;
  createPullRequest(request: GhRequests['createPullRequest'], options?: GitCallOptions): Promise<ExecutionGhResults['createPullRequest']>;
  findPullRequests(request: GhRequests['findPullRequests'], options?: GitCallOptions): Promise<ExecutionGhResults['findPullRequests']>;
  getStatus(options?: ExecutorCallOptions): Promise<ExecutionGhResults['getStatus']>;
  listPullRequests(request: GhRequests['listPullRequests'], options?: ExecutorCallOptions): Promise<ExecutionGhResults['listPullRequests']>;
  getPullRequest(request: GhRequests['getPullRequest'], options?: ExecutorCallOptions): Promise<ExecutionGhResults['getPullRequest']>;
  getPullRequestReviewTarget(request: GhRequests['getPullRequestReviewTarget'], options?: ExecutorCallOptions): Promise<ExecutionGhResults['getPullRequestReviewTarget']>;
  createPullRequestComment(request: GhRequests['createPullRequestComment'], options?: ExecutorCallOptions): Promise<ExecutionGhResults['createPullRequestComment']>;
  minimizePullRequestComment(request: GhRequests['minimizePullRequestComment'], options?: ExecutorCallOptions): Promise<ExecutionGhResults['minimizePullRequestComment']>;
}
