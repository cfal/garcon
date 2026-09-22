import type { GitMethod } from '@garcon/common/git';
import type { ExecutionGitRequests, ExecutionGitResults } from '@garcon/common/git-execution';
import type { GhStatusResponse, PullRequestListResult, PullRequestDetail } from '@garcon/common/gh';
import type { NodeCallOptions } from './resources.js';

export type ExecutionGitService = {
  [K in GitMethod]: (request: ExecutionGitRequests[K], options?: NodeCallOptions) => Promise<ExecutionGitResults[K]>;
};

export interface ExecutionGhService {
  getStatus(options?: NodeCallOptions): Promise<GhStatusResponse>;
  listPullRequests(request: { projectPath: string }, options?: NodeCallOptions): Promise<PullRequestListResult>;
  getPullRequest(request: { projectPath: string; number: number }, options?: NodeCallOptions): Promise<PullRequestDetail>;
}
