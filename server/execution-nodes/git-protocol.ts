import type { ExecutionGitRequests, ExecutionGitResults, GitNodeScope } from '../../common/git-execution.js';
import type { GitMethod } from '../../common/git.js';
import type { GhStatusResponse, PullRequestDetail, PullRequestListResult } from '../../common/gh.js';
import { GitServiceError } from '../../common/git-error.js';
import { isRecord } from '../../common/json.js';
import { isGitMethod } from '../../common/git-request-validation.js';
import { GIT_RESULT_CHUNK_BYTES } from '../../common/git-execution.js';

export interface GitResultScope extends GitNodeScope { readonly sessionId: string }
export interface GitResultRef extends GitResultScope { readonly kind: 'git-result'; readonly id: string }
export type GitReply<T> = GitResultScope & (
  { readonly kind: 'inline'; readonly value: T } | { readonly kind: 'transfer'; readonly transfer: GitResultRef; readonly size: number }
);

type Call<Q, R> = { readonly request: Q; readonly result: R };
export interface GitCall<Q> { readonly input: Q; readonly budgetMs: number }
export type GitRpcMethods = {
  [K in GitMethod as `git.${K}`]: Call<GitCall<ExecutionGitRequests[K]>, GitReply<ExecutionGitResults[K]>>;
} & {
  'gh.getStatus': Call<GitCall<Record<string, never>>, GitReply<GhStatusResponse>>;
  'gh.listPullRequests': Call<GitCall<{ projectPath: string }>, GitReply<PullRequestListResult>>;
  'gh.getPullRequest': Call<GitCall<{ projectPath: string; number: number }>, GitReply<PullRequestDetail>>;
  'gitResults.readChunk': Call<{ transfer: GitResultRef; offset: number }, { offset: number; data: string; eof: boolean }>;
  'gitResults.close': Call<GitResultRef, void>;
};

export type GitRpcRequest = { [K in keyof GitRpcMethods]: { method: K; request: GitRpcMethods[K]['request'] } }[keyof GitRpcMethods];

export function isGitRpcMethod(method: string): method is keyof GitRpcMethods {
  return method.startsWith('git.') && isGitMethod(method.slice(4))
    || ['gh.getStatus', 'gh.listPullRequests', 'gh.getPullRequest', 'gitResults.readChunk', 'gitResults.close'].includes(method);
}

export function invalidGitResult(): GitServiceError { return new GitServiceError('GIT_INVALID_RESULT', 'Invalid Git result transfer'); }

export function validateGitResultRef(value: unknown, scope: GitResultScope): asserts value is GitResultRef {
  if (!isRecord(value) || value.nodeId !== scope.nodeId || value.instanceId !== scope.instanceId || value.sessionId !== scope.sessionId
    || value.kind !== 'git-result' || typeof value.id !== 'string' || !/^[a-f0-9-]{36}$/.test(value.id)) throw invalidGitResult();
}

export function decodeGitChunk(value: unknown): Buffer {
  if (typeof value !== 'string' || value.length > 4 * Math.ceil(GIT_RESULT_CHUNK_BYTES / 3)) throw invalidGitResult();
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > GIT_RESULT_CHUNK_BYTES || bytes.toString('base64') !== value) throw invalidGitResult();
  return bytes;
}
