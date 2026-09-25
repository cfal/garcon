import type { GitRequests, GitResults, GitMethod } from './git.js';
import type { GitOperationDiagnostics } from './git-diagnostics.js';
import type { GhResults } from './gh.js';

export interface GitExecutorScope {
  readonly executorId: string;
  readonly instanceId: string;
}

export interface GitProjectTarget {
  readonly executorId: string;
  readonly projectPath: string;
}

export interface GitReviewDocumentRef extends GitExecutorScope {
  readonly documentId: string;
}

export interface GitSelectionProof {
  readonly document: GitReviewDocumentRef;
  readonly bodyFingerprint: string;
  readonly patchDigest: string;
}

export interface ExecutionGitRequests extends Omit<GitRequests, 'getReviewDocumentFileBodies' | 'stageSelection' | 'stageHunk'> {
  getReviewDocumentFileBodies: Omit<GitRequests['getReviewDocumentFileBodies'], 'documentId'> & { document: GitReviewDocumentRef };
  stageSelection: GitRequests['stageSelection'] & GitSelectionProof;
  stageHunk: GitRequests['stageHunk'] & GitSelectionProof;
}

export type ExecutionGitResults = { [K in GitMethod]: GitResults[K] & GitExecutorScope & { diagnostics?: GitOperationDiagnostics } };
export type ExecutionGhResults = { [K in keyof GhResults]: GhResults[K] & GitExecutorScope };

export const GIT_MUTATIONS = [
  'initialCommit', 'commit', 'checkout', 'createBranch', 'fetch', 'pull', 'push', 'discard', 'deleteUntracked',
  'stageSelection', 'stageHunk', 'acceptConflictSide', 'markConflictResolved', 'createStash', 'applyStash',
  'popStash', 'dropStash', 'createWorktree', 'removeWorktree', 'commitIndex', 'stagePaths', 'revertCommit',
] as const satisfies readonly GitMethod[];

export function isGitMutation(method: GitMethod): boolean {
  return (GIT_MUTATIONS as readonly GitMethod[]).includes(method);
}

export const GIT_OPERATION_TIMEOUT_MS = 30_000;
export const GH_DETAIL_TIMEOUT_MS = 60_000;
export const GIT_MAX_RESULT_BYTES = 4 * 1024 * 1024;
export const GIT_MAX_CONCURRENT_QUERIES = 8;
export const GIT_MAX_REQUEST_BYTES = 4 * 1024 * 1024;
export const GIT_MAX_REQUEST_PATHS = 100_000;
