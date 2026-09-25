import type { ExecutionGitRequests, ExecutionGitResults, ExecutionGhResults } from '../../../common/git-execution.js';
import type { GitMethod } from '../../../common/git.js';
import { isGitMethod } from '../../../common/git-request-validation.js';

type Call<Q, R> = { readonly request: Q; readonly result: R };
export interface GitCall<Q> { readonly input: Q; readonly budgetMs: number }
export type GitRpcMethods = {
  [K in GitMethod as `git.${K}`]: Call<GitCall<ExecutionGitRequests[K]>, ExecutionGitResults[K]>;
} & {
  'gh.getStatus': Call<GitCall<Record<string, never>>, ExecutionGhResults['getStatus']>;
  'gh.listPullRequests': Call<GitCall<{ projectPath: string }>, ExecutionGhResults['listPullRequests']>;
  'gh.getPullRequest': Call<GitCall<{ projectPath: string; number: number }>, ExecutionGhResults['getPullRequest']>;
};

export type GitRpcRequest = { [K in keyof GitRpcMethods]: { method: K; request: GitRpcMethods[K]['request'] } }[keyof GitRpcMethods];

export function isGitRpcMethod(method: string): method is keyof GitRpcMethods {
  return method.startsWith('git.') && isGitMethod(method.slice(4))
    || ['gh.getStatus', 'gh.listPullRequests', 'gh.getPullRequest'].includes(method);
}
