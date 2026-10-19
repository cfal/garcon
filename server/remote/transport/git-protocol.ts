import type { ExecutionGitRequests, ExecutionGitResults, ExecutionGhResults } from '../../../common/git-execution.js';
import type { GitMethod } from '../../../common/git.js';
import type { GhRequests } from '../../../common/gh.js';
import { isGhMethod, isGitMethod } from '../../../common/git-request-validation.js';

type Call<Q, R> = { readonly request: Q; readonly result: R };
export interface GitCall<Q> { readonly input: Q; readonly budgetMs: number }
export type GitRpcMethods = {
  [K in GitMethod as `git.${K}`]: Call<GitCall<ExecutionGitRequests[K]>, ExecutionGitResults[K]>;
} & {
  [K in keyof GhRequests as `gh.${K}`]: Call<GitCall<GhRequests[K]>, ExecutionGhResults[K]>;
};

export type GitRpcRequest = { [K in keyof GitRpcMethods]: { method: K; request: GitRpcMethods[K]['request'] } }[keyof GitRpcMethods];

export function isGitRpcMethod(method: string): method is keyof GitRpcMethods {
  return method.startsWith('git.') && isGitMethod(method.slice(4))
    || method.startsWith('gh.') && isGhMethod(method.slice(3));
}
