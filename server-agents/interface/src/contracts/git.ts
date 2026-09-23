import type { GitMethod } from '@garcon/common/git';
import type { ExecutionGitRequests, ExecutionGitResults, ExecutionGhResults } from '@garcon/common/git-execution';
import type { NodeCallOptions } from './resources.js';

export type ExecutionGitService = {
  [K in GitMethod]: (request: ExecutionGitRequests[K], options?: NodeCallOptions) => Promise<ExecutionGitResults[K]>;
};

export interface ExecutionGhService {
  getStatus(options?: NodeCallOptions): Promise<ExecutionGhResults['getStatus']>;
  listPullRequests(request: { projectPath: string }, options?: NodeCallOptions): Promise<ExecutionGhResults['listPullRequests']>;
  getPullRequest(request: { projectPath: string; number: number }, options?: NodeCallOptions): Promise<ExecutionGhResults['getPullRequest']>;
}
