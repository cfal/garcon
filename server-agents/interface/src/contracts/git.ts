import type { GitMethod } from '@garcon/common/git';
import type { ExecutionGitRequests, ExecutionGitResults, ExecutionGhResults } from '@garcon/common/git-execution';
import type { ExecutorCallOptions } from './resources.js';

export type ExecutionGitService = {
  [K in GitMethod]: (request: ExecutionGitRequests[K], options?: ExecutorCallOptions) => Promise<ExecutionGitResults[K]>;
};

export interface ExecutionGhService {
  getStatus(options?: ExecutorCallOptions): Promise<ExecutionGhResults['getStatus']>;
  listPullRequests(request: { projectPath: string }, options?: ExecutorCallOptions): Promise<ExecutionGhResults['listPullRequests']>;
  getPullRequest(request: { projectPath: string; number: number }, options?: ExecutorCallOptions): Promise<ExecutionGhResults['getPullRequest']>;
}
