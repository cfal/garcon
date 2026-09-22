import type { GitMethod, GitRequests, GitResults } from '@garcon/common/git';
import type { GhStatusResponse, PullRequestListResult, PullRequestDetail } from '@garcon/common/gh';
import type { NodeCallOptions } from './resources.js';

export type ExecutionGitService = {
  [K in GitMethod]: (request: GitRequests[K], options?: NodeCallOptions) => Promise<GitResults[K]>;
};

export interface ExecutionGhService {
  getStatus(options?: NodeCallOptions): Promise<GhStatusResponse>;
  listPullRequests(request: { projectPath: string }, options?: NodeCallOptions): Promise<PullRequestListResult>;
  getPullRequest(request: { projectPath: string; number: number }, options?: NodeCallOptions): Promise<PullRequestDetail>;
}
