import { isRecord } from './json.js';
import { GitServiceError } from './git-error.js';
import { isGitMutation, type ExecutionGitResults, type GitNodeScope } from './git-execution.js';
import type { GitMethod } from './git.js';

type Check = (value: unknown) => boolean;
const str: Check = v => typeof v === 'string';
const bool: Check = v => typeof v === 'boolean';
const num: Check = v => typeof v === 'number' && Number.isFinite(v);
const optional = (check: Check): Check => v => v === undefined || check(v);
const nullable = (check: Check): Check => v => v === null || check(v);
const oneOf = (...values: unknown[]): Check => v => values.includes(v);
const array = (check: Check, max = 100_000): Check => v => Array.isArray(v) && v.length <= max && v.every(value => check(value));
const map = (check: Check, max = 10_000): Check => v => isRecord(v) && Object.keys(v).length <= max && Object.values(v).every(check);
const shape = (v: unknown, fields: Record<string, Check>): boolean => isRecord(v) && Object.entries(fields).every(([k, check]) => check(v[k]));
const category = oneOf('normal', 'generated', 'lockfile', 'binary', 'large');
const bodyState = oneOf('unloaded', 'loading', 'loaded', 'binary', 'too-large', 'error');
const mode = oneOf('working', 'staged');
const ref = (v: unknown) => shape(v, { name: str, ref: str, kind: oneOf('local-branch', 'remote-branch', 'tag', 'other'), updatedAt: nullable(str), isCurrent: optional(bool) });
const limits = (v: unknown) => shape(v, Object.fromEntries(['maxSummaryFiles', 'maxBodyBatchFiles', 'maxLoadedRows', 'maxLoadedPatchBytes', 'maxFileRows', 'maxFilePatchBytes', 'maxLineBytes', 'maxContextLines', 'bodyConcurrency'].map(k => [k, num])));
const file = (v: unknown) => shape(v, { path: str, originalPath: optional(str), category, additions: num, deletions: num, estimatedRows: num,
  bodyState, bodyFingerprint: str, isBinary: bool, isTooLarge: bool });
const target = (v: unknown) => shape(v, { projectPath: str, repoRoot: str, worktreePath: str, label: str, branch: str, source: oneOf('chat-project', 'worktree') });
const worktree = (v: unknown) => shape(v, { path: str, branch: str, name: str, isCurrent: bool, isMain: bool, isPathMissing: bool, lastModifiedAt: nullable(str) });
const commit = (v: unknown) => shape(v, { hash: str, shortHash: str, parents: array(str), author: str, authorEmail: str, authorDate: str, committer: str, committerEmail: str, committerDate: str, subject: str, refs: array(str) });
const digest: Check = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);

export function isGitPatchBody(v: unknown): boolean {
  return shape(v, { path: str, bodyFingerprint: str, bodyState, category, isBinary: bool, isTooLarge: bool,
    renderedRowCount: num, patchBytes: num, patch: nullable(str), patchDigest: optional(digest), error: optional(str) });
}

function tree(v: unknown, depth = 0): boolean {
  return depth < 128 && shape(v, { path: str, name: str, kind: oneOf('file', 'directory'), children: optional(array(x => tree(x, depth + 1))) });
}

function snapshot(v: Record<string, unknown>): boolean {
  return shape(v, { documentId: str, files: array(file, 10_000), limits, firstBodyCandidates: array(str, 24) });
}

function revision(v: unknown): boolean { return shape(v, { kind: oneOf('revision'), requestedRevision: str, label: str, hash: str, shortHash: str }); }
function workingTree(v: unknown): boolean { return shape(v, { kind: oneOf('working-tree'), label: str, branch: str, headHash: nullable(str), fingerprint: str, shortFingerprint: str }); }

function diagnostics(v: unknown): boolean {
  return shape(v, { commands: array(c => shape(c, { command: str, durationMs: num, stdoutBytes: num, stderrBytes: num }), 128),
    phases: array(p => shape(p, { name: oneOf('resolve', 'summary-git', 'document-register', 'freshness-before', 'body-cache', 'body-git', 'body-split', 'patch-scan', 'freshness-after', 'serialize'), durationMs: num }), 128),
    fileCount: optional(num), rowCount: optional(num), cacheHits: optional(num), batchCount: optional(num), bisectionCount: optional(num) });
}

export function validateGitResult<K extends GitMethod>(method: K, value: unknown, scope: GitNodeScope): asserts value is ExecutionGitResults[K] {
  if (!isRecord(value) || value.nodeId !== scope.nodeId || value.instanceId !== scope.instanceId || !optional(diagnostics)(value.diagnostics) || !gitResult(method, value)) {
    throw new GitServiceError('GIT_INVALID_RESULT', `Invalid Git ${method} response`);
  }
}

function gitResult(method: GitMethod, v: Record<string, unknown>): boolean {
  if (isGitMutation(method)) {
    if (!shape(v, { success: oneOf(true), output: optional(str), message: optional(str), outputTruncated: optional(bool), worktreePath: optional(str) })) return false;
    return method !== 'commit' || shape(v, { commitScope: oneOf('selected-files', 'whole-index'), indexSynchronized: bool });
  }
  switch (method) {
    case 'getStatus': return shape(v, { branch: str, hasCommits: bool, modified: array(str), added: array(str), deleted: array(str), untracked: array(str) });
    case 'getBranches': return array(str)(v.branches);
    case 'getRefs': return array(ref, 500)(v.refs);
    case 'getRemoteStatus': return shape(v, { branch: str, hasRemote: bool, hasUpstream: bool, remoteName: nullable(str), remoteBranch: optional(str), ahead: optional(num), behind: optional(num), isUpToDate: optional(bool) });
    case 'getRemotes': return array(x => shape(x, { name: str, url: str }))(v.remotes);
    case 'getRepoInfo': return shape(v, { isGitRepository: bool, repoRoot: optional(str), currentWorktreePath: optional(str) });
    case 'getWorktrees': return array(worktree)(v.worktrees);
    case 'getTargetCandidates': return array(x => target(x) && shape(x, { isCurrent: bool, isMissing: bool }))(v.targets);
    case 'collectCommitMessageContext': return str(v.diff);
    case 'getConflicts': return array(x => shape(x, { path: str, status: oneOf('UU', 'AA', 'DD', 'AU', 'UA', 'DU', 'UD'), baseAvailable: bool, oursAvailable: bool, theirsAvailable: bool }))(v.conflicts);
    case 'getConflictDetails': {
      const content = (x: unknown) => shape(x, { content: nullable(str), truncated: bool, byteLength: num, lineCount: num });
      return shape(v, { path: str, base: content, ours: content, theirs: content, working: content, truncated: bool });
    }
    case 'getStashes': return array(x => shape(x, { index: num, ref: str, hash: str, message: str, date: str }))(v.stashes);
    case 'getFileHistory': return array(x => shape(x, { hash: str, author: str, email: str, date: str, subject: str }))(v.commits);
    case 'getGraph': return array(x => shape(x, { graph: str, hash: str, parents: array(str), decorations: array(str), author: str, date: str, subject: str }))(v.commits);
    case 'getBlame': return bool(v.truncated) && array(x => shape(x, { line: num, originalLine: num, finalLine: num, commit: str, author: str, authorMail: str, authorTime: str, summary: str, content: str }))(v.lines);
    case 'getHistoryCommits': return shape(v, { project: str, ref: str, nextOffset: nullable(num), commits: array(commit, 200) });
    case 'getWorkingTreeFingerprint': return str(v.project) && v.fingerprintVersion === 1 && (v.status === 'ready'
      ? str(v.fingerprint) && num(v.changedPathCount) : oneOf('not-git-repository', 'unknown')(v.status) && v.fingerprint === null && str(v.message));
    case 'getQuickSummary': return str(v.project) && v.fingerprintVersion === 1 && (v.status === 'ready'
      ? shape(v, { repoRoot: str, branch: str, hasCommits: bool, changedFiles: num, trackedChangedFiles: num, untrackedFiles: num, stagedFiles: num, unstagedFiles: num, additions: num, deletions: num, fingerprint: str })
      : oneOf('not-git-repository', 'unknown')(v.status) && v.fingerprint === null && str(v.message));
    case 'getWorkbenchSnapshot': return str(v.project) && (v.status === 'not-git-repository' ? v.target === null && v.tree === null && v.reviewSummary === null && str(v.message)
      : v.status === 'ready' && target(v.target) && shape(v.tree, { root: array(tree), hasCommits: bool, statsState: oneOf('loaded') })
        && shape(v.reviewSummary, { documentId: str, project: str, mode, context: num, files: array(file, 10_000), limits })
        && shape(v, { selectedFile: nullable(str), firstBodyCandidates: array(str, 24), snapshotId: str, workbenchFingerprint: str }));
    case 'getReviewDocumentFileBodies': return str(v.documentId) && (v.status === 'ready' ? map(isGitPatchBody, 24)(v.files) && map(str, 24)(v.errors)
      : v.status === 'document-expired' ? str(v.message) : v.status === 'stale' && array(str)(v.changedPaths) && str(v.message));
    case 'getCommitSnapshot': return str(v.project) && (v.status === 'not-found' ? str(v.commit) && str(v.message)
      : v.status === 'ready' && snapshot(v) && commit(v.commit) && shape(v.commit, { body: str }) && nullable(str)(v.selectedParent)
        && array(x => shape(x, { hash: str, shortHash: str, label: str }))(v.parentOptions));
    case 'getComparisonSnapshot': return str(v.project) && (v.status === 'ready'
      ? snapshot(v) && str(v.repoRoot) && oneOf('direct', 'merge-base')(v.mode) && revision(v.from) && (revision(v.to) || workingTree(v.to)) && str(v.effectiveFromHash)
      : v.status === 'not-found' ? oneOf('from', 'to')(v.endpoint) && str(v.revision) && str(v.message)
        : v.status === 'no-merge-base' ? revision(v.from) && revision(v.to) && str(v.message)
          : v.status === 'working-tree-changing' && str(v.message));
    case 'getComparisonFreshness': return str(v.project) && (v.status === 'not-found' ? oneOf('from', 'to')(v.endpoint) && str(v.revision) && str(v.message)
      : v.status === 'ready' && array(oneOf('from', 'to'), 2)(v.changedEndpoints) && str(v.fromHash)
        && (shape(v.to, { kind: oneOf('revision'), hash: str }) || shape(v.to, { kind: oneOf('working-tree'), fingerprint: str })));
    default: return false;
  }
}

export function validateGhResult(method: 'getStatus' | 'listPullRequests' | 'getPullRequest', value: unknown): void {
  const identity = { number: num, title: str, state: oneOf('open', 'closed', 'merged'), isDraft: bool, author: str, headRefName: str, baseRefName: str,
    additions: num, deletions: num, changedFiles: num, updatedAt: str, url: str, reviewDecision: oneOf('approved', 'changes_requested', 'review_required', null) };
  const valid = method === 'getStatus' ? shape(value, { available: bool, authenticated: bool, reason: oneOf('authenticated', 'unauthenticated', 'gh_missing', 'auth_error', 'unknown'), login: optional(str), host: optional(str) })
    : method === 'listPullRequests' ? shape(value, { pulls: array(x => shape(x, { ...identity, checksState: oneOf('passing', 'failing', 'pending', 'none') }), 100), repo: nullable(x => shape(x, { nameWithOwner: str })) })
      : shape(value, { ...identity, body: str, createdAt: str, mergeable: oneOf('mergeable', 'conflicting', 'unknown'), files: array(file, 10_000), fileBodies: map(isGitPatchBody),
        checks: array(x => shape(x, { name: str, state: oneOf('success', 'failure', 'pending', 'neutral', 'skipped'), url: optional(str) })),
        threads: array(x => shape(x, { id: str, path: str, side: oneOf('before', 'after'), line: num, diffHunk: str, isOutdated: bool,
          comments: array(c => shape(c, { id: num, author: str, body: str, createdAt: str })) })) });
  if (!valid) throw new GitServiceError('GIT_INVALID_RESULT', `Invalid GitHub ${method} response`);
}
