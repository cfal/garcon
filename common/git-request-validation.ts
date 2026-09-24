import { isRecord } from './json.js';
import type { GitMethod } from './git.js';
import type { ExecutionGitRequests, GitReviewDocumentRef } from './git-execution.js';
import { GIT_MAX_REQUEST_BYTES, GIT_MAX_REQUEST_PATHS } from './git-execution.js';
import { GitServiceError } from './git-error.js';
import type { GhRequests } from './gh.js';

const path = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 4096 && !v.includes('\0');
const text = (v: unknown): v is string => typeof v === 'string' && v.length <= 64 * 1024 && !v.includes('\0');
const integer = (v: unknown, max = 100_000): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= max;
const paths = (v: unknown): boolean => {
  if (Array.isArray(v) && v.length > GIT_MAX_REQUEST_PATHS) {
    throw new GitServiceError('GIT_REQUEST_TOO_LARGE', `Git selection exceeds the ${GIT_MAX_REQUEST_PATHS} path limit.`);
  }
  return Array.isArray(v) && v.length > 0 && v.every(path);
};
const oneOf = (v: unknown, values: readonly unknown[]) => values.includes(v);
const fields = (v: Record<string, unknown>, keys: readonly string[]) => Object.keys(v).every(k => keys.includes(k) || v[k] === undefined);
const optional = (v: unknown, check: (v: unknown) => boolean): boolean => v === undefined || check(v);
const revision = (v: unknown) => isRecord(v) && v.kind === 'revision' && path(v.revision) && fields(v, ['kind', 'revision']);
const hash = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{40,64}$/.test(v);
const revisionExpectation = (v: unknown) => isRecord(v) && v.kind === 'revision' && path(v.revision) && hash(v.hash) && fields(v, ['kind', 'revision', 'hash']);
const proofKeys = ['document', 'bodyFingerprint', 'patchDigest'];

export function isGitDocumentRef(v: unknown): v is GitReviewDocumentRef {
  return isRecord(v) && path(v.nodeId) && path(v.instanceId) && path(v.documentId)
    && fields(v, ['nodeId', 'instanceId', 'documentId']);
}

function proof(v: Record<string, unknown>): boolean {
  return isGitDocumentRef(v.document) && path(v.bodyFingerprint)
    && typeof v.patchDigest === 'string' && /^[a-f0-9]{64}$/.test(v.patchDigest);
}

export const GIT_REQUEST_FIELDS = {
  getStatus: [], initialCommit: [], getBranches: [], getRemoteStatus: [], getRemotes: [],
  fetch: [], pull: [], getConflicts: [], getStashes: [], getRepoInfo: [], getWorktrees: [], getTargetCandidates: [],
  getWorkingTreeFingerprint: [], getQuickSummary: [],
  commit: ['message', 'files'], getRefs: ['query', 'limit', 'sort'], checkout: ['ref', 'refKind'],
  createBranch: ['branch', 'baseRef'], push: ['remote', 'remoteBranch'], discard: ['file'], deleteUntracked: ['file'],
  getWorkbenchSnapshot: ['mode', 'context', 'selectedFile', 'bodyCandidateCount'],
  getReviewDocumentFileBodies: ['document', 'files', 'purpose'],
  getHistoryCommits: ['ref', 'limit', 'offset'], getCommitSnapshot: ['commit', 'parent', 'context', 'bodyCandidateCount'],
  getComparisonSnapshot: ['from', 'to', 'mode', 'context', 'bodyCandidateCount'], getComparisonFreshness: ['from', 'to'],
  stageSelection: ['file', 'mode', 'selection', 'contextLines', ...proofKeys],
  stageHunk: ['file', 'mode', 'hunkIndex', 'contextLines', ...proofKeys],
  getConflictDetails: ['file'], acceptConflictSide: ['file', 'side'], markConflictResolved: ['file'],
  createStash: ['message', 'includeUntracked'], applyStash: ['stashRef'], popStash: ['stashRef'], dropStash: ['stashRef'],
  getFileHistory: ['file', 'limit'], getBlame: ['file', 'ref', 'limit'], getGraph: ['limit'],
  createWorktree: ['worktreePath', 'branch', 'baseRef', 'detach'], removeWorktree: ['worktreePath', 'force'],
  commitIndex: ['message'], stagePaths: ['paths', 'mode'], revertCommit: ['commit'], collectCommitMessageContext: ['files'],
} as const satisfies Record<GitMethod, readonly string[]>;

export function isGitMethod(value: unknown): value is GitMethod {
  return typeof value === 'string' && Object.hasOwn(GIT_REQUEST_FIELDS, value);
}

export function validateGhRequest(method: keyof GhRequests, request: unknown): void {
  const keys = method === 'getStatus' ? [] : method === 'listPullRequests' ? ['projectPath'] : ['projectPath', 'number'];
  if (!isRecord(request) || !fields(request, keys) || method !== 'getStatus' && !path(request.projectPath)
    || method === 'getPullRequest' && (!integer(request.number, Number.MAX_SAFE_INTEGER) || request.number === 0)) {
    throw new GitServiceError('GIT_INVALID_INPUT', `Invalid GitHub ${method} request`);
  }
}

export function validateGitRequest<K extends GitMethod>(method: K, request: unknown): asserts request is ExecutionGitRequests[K] {
  const fail = (): never => { throw new GitServiceError('GIT_INVALID_INPUT', `Invalid Git ${method} request`); };
  if (!isRecord(request) || !path(request.projectPath) || !fields(request, ['projectPath', ...GIT_REQUEST_FIELDS[method]])) fail();
  const v = request as Record<string, unknown>;
  if (new TextEncoder().encode(JSON.stringify(v)).length > GIT_MAX_REQUEST_BYTES) {
    throw new GitServiceError('GIT_REQUEST_TOO_LARGE', 'Git request is too large. Select fewer paths.');
  }
  for (const key of ['file', 'worktreePath', 'branch', 'ref', 'baseRef', 'remote', 'remoteBranch', 'commit', 'stashRef']) {
    if (!optional(v[key], path)) fail();
  }
  if (!optional(v.message, text) || !optional(v.query, path) && v.query !== '') fail();
  if (!optional(v.limit, n => integer(n, 100_000) && n !== 0) || !optional(v.offset, integer)) fail();
  if (!optional(v.context, n => integer(n, 50)) || !optional(v.contextLines, n => integer(n, 50))) fail();
  if (!optional(v.bodyCandidateCount, n => integer(n, 24))) fail();
  if (!optional(v.selectedFile, x => x === null || path(x)) || !optional(v.parent, x => x === null || path(x))) fail();
  for (const key of ['force', 'detach', 'includeUntracked']) if (!optional(v[key], x => typeof x === 'boolean')) fail();
  if ('file' in v && !path(v.file)) fail();
  switch (method) {
    case 'commit': if (!text(v.message) || !v.message || !paths(v.files)) fail(); break;
    case 'commitIndex': if (!text(v.message) || !v.message) fail(); break;
    case 'collectCommitMessageContext': if (!paths(v.files)) fail(); break;
    case 'getRefs':
      if (!optional(v.sort, s => isRecord(s) && oneOf(s.key, ['name', 'updated']) && oneOf(s.direction, ['asc', 'desc']) && fields(s, ['key', 'direction']))) fail();
      break;
    case 'checkout': if (!path(v.ref) || !optional(v.refKind, x => oneOf(x, ['local-branch', 'remote-branch', 'tag', 'other']))) fail(); break;
    case 'createBranch': if (!path(v.branch)) fail(); break;
    case 'revertCommit': case 'getCommitSnapshot': if (!path(v.commit)) fail(); break;
    case 'createWorktree': case 'removeWorktree': if (!path(v.worktreePath)) fail(); break;
    case 'applyStash': case 'popStash': case 'dropStash': if (!path(v.stashRef)) fail(); break;
    case 'getWorkbenchSnapshot': if (!oneOf(v.mode, ['working', 'staged']) || !integer(v.context, 50)) fail(); break;
    case 'getReviewDocumentFileBodies':
      if (!isGitDocumentRef(v.document) || !paths(v.files) || (v.files as unknown[]).length > 24 || !oneOf(v.purpose, ['visible', 'prefetch'])) fail();
      break;
    case 'stagePaths': if (!paths(v.paths) || !oneOf(v.mode, ['stage', 'unstage'])) fail(); break;
    case 'stageSelection': case 'stageHunk':
      if (!path(v.file) || !proof(v) || !oneOf(v.mode, ['stage', 'unstage']) || !integer(v.contextLines, 50)) fail();
      if (method === 'stageHunk' ? !integer(v.hunkIndex) : !isRecord(v.selection) || !fields(v.selection, ['lineIndices'])
        || !Array.isArray(v.selection.lineIndices) || !v.selection.lineIndices.length || v.selection.lineIndices.length > 50_000 || !v.selection.lineIndices.every(i => integer(i, 100_000))) fail();
      break;
    case 'acceptConflictSide': if (!path(v.file) || !oneOf(v.side, ['ours', 'theirs'])) fail(); break;
    case 'discard': case 'deleteUntracked': case 'getConflictDetails': case 'markConflictResolved': case 'getFileHistory': case 'getBlame':
      if (!path(v.file)) fail(); break;
    case 'getComparisonSnapshot':
      if (!revision(v.from) || !isRecord(v.to) || !(revision(v.to) || v.to.kind === 'working-tree' && fields(v.to, ['kind']))
        || !oneOf(v.mode, ['direct', 'merge-base']) || v.to.kind === 'working-tree' && v.mode !== 'direct') fail();
      break;
    case 'getComparisonFreshness':
      if (!revisionExpectation(v.from) || !isRecord(v.to) || !(revisionExpectation(v.to)
        || v.to.kind === 'working-tree' && path(v.to.fingerprint) && fields(v.to, ['kind', 'fingerprint']))) fail();
      break;
  }
}
