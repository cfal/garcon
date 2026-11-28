import type { GhRequests, GhResults, PullRequestSummary } from '../../../../common/gh.ts';
import { GIT_OPERATION_TIMEOUT_MS, ghOperationTimeoutMs } from '../../../../common/git-execution.ts';
import { GIT_REVIEW_DOCUMENT_LIMITS, GIT_WORKING_TREE_FINGERPRINT_VERSION, type GitResults } from '../../../../common/git.ts';
import {
  isGhMethod, isGitMethod, validateGhRequest, validateGitRequest,
} from '../../../../common/git-request-validation.ts';
import type { GitRpcRequest } from '../../../../server/remote/transport/git-protocol.ts';

const scope = { executorId: 'local', instanceId: 'fixture-instance' };
const projectPath = '/work/app';
const repository = { host: 'github.example.invalid', nameWithOwner: 'acme/app' };
const viewer = { id: 'fixture-user', login: 'fixture' };
const date = '2026-01-01T00:00:00.000Z';
const hash = 'a'.repeat(40);
const mutation = { success: true, output: 'ok' };
const commit = {
  hash, shortHash: 'aaaaaaa', parents: [], author: 'Fixture', authorEmail: 'fixture@example.invalid',
  authorDate: date, committer: 'Fixture', committerEmail: 'fixture@example.invalid', committerDate: date,
  subject: 'Synthetic commit', body: 'Synthetic body', refs: ['main'],
};
const { body: _body, ...historyCommit } = commit;
const patchBody = {
  path: 'README.md', bodyFingerprint: 'fixture-body', bodyState: 'loaded', category: 'normal',
  isBinary: false, isTooLarge: false, renderedRowCount: 0, patchBytes: 0, patch: null,
} as const;
const revision = { kind: 'revision', requestedRevision: 'main', label: 'main', hash, shortHash: 'aaaaaaa' } as const;
const conflictContent = { content: null, truncated: false, byteLength: 0, lineCount: 0 };
const diffStats = { additions: 2, deletions: 1 };
const fileSummary = {
  path: 'README.md', indexStatus: 'M', workTreeStatus: ' ', category: 'normal', ...diffStats,
  estimatedRows: 3, bodyState: 'unloaded', bodyFingerprint: 'fixture-body', isGenerated: false,
  isBinary: false, isTooLarge: false,
} as const;

const gitResults: GitResults = {
  getStatus: { branch: 'main', hasCommits: true, modified: ['README.md'], added: [], deleted: [], untracked: [] },
  initialCommit: mutation,
  commit: { success: true, output: 'ok', commitScope: 'selected-files', indexSynchronized: false },
  getBranches: { branches: ['main'] },
  getRefs: { refs: [{ name: 'main', ref: 'refs/heads/main', kind: 'local-branch', updatedAt: null, isCurrent: true }] },
  checkout: mutation,
  createBranch: mutation,
  getRemoteStatus: { hasRemote: false, hasUpstream: false, branch: 'main', remoteName: null },
  getRemotes: { remotes: [{ name: 'origin', url: 'https://git.example.invalid/acme/app' }] },
  fetch: mutation,
  pull: mutation,
  push: { ...mutation, remoteName: 'origin', remoteBranch: 'main' },
  discard: mutation,
  deleteUntracked: mutation,
  getWorkbenchSnapshot: {
    status: 'ready', project: projectPath,
    target: { projectPath, repoRoot: projectPath, worktreePath: projectPath, label: 'App', branch: 'main', source: 'chat-project' },
    tree: {
      root: [{ path: 'README.md', name: 'README.md', kind: 'file', indexStatus: 'M', workTreeStatus: ' ',
        stagedFacet: { status: 'M', changeKind: 'modified', stats: diffStats }, staged: true, hasUnstaged: false }],
      hasCommits: true, statsState: 'loaded',
    },
    reviewSummary: { documentId: 'doc-1', project: projectPath, mode: 'staged', context: 3,
      files: [fileSummary], limits: GIT_REVIEW_DOCUMENT_LIMITS },
    selectedFile: 'README.md', firstBodyCandidates: ['README.md'], snapshotId: 'snapshot-1', workbenchFingerprint: 'tree-1',
  },
  getWorkingTreeFingerprint: { status: 'ready', project: projectPath,
    fingerprintVersion: GIT_WORKING_TREE_FINGERPRINT_VERSION, fingerprint: 'fingerprint', changedPathCount: 1 },
  getQuickSummary: { status: 'ready', project: projectPath, branch: 'main', hasChanges: true, hasUntracked: false, diffStats: null },
  getReviewDocumentFileBodies: { status: 'ready', documentId: 'doc-1', files: { 'README.md': patchBody }, errors: {}, deferredFiles: [] },
  getHistoryCommits: { project: projectPath, ref: 'main', commits: [historyCommit], nextOffset: null },
  getCommitSnapshot: { status: 'ready', project: projectPath, documentId: 'doc-2', commit, selectedParent: null,
    parentOptions: [], files: [], limits: GIT_REVIEW_DOCUMENT_LIMITS, firstBodyCandidates: [] },
  getComparisonSnapshot: { status: 'ready', project: projectPath, repoRoot: projectPath, documentId: 'doc-3',
    mode: 'direct', from: revision, to: { kind: 'working-tree', label: 'Working tree', branch: 'main', headHash: hash,
      fingerprint: 'working-fingerprint', shortFingerprint: 'working' }, effectiveFromHash: hash, files: [],
    limits: GIT_REVIEW_DOCUMENT_LIMITS, firstBodyCandidates: [] },
  getComparisonFreshness: { status: 'ready', project: projectPath, changedEndpoints: ['to'], fromHash: hash,
    to: { kind: 'working-tree', fingerprint: 'updated-fingerprint' } },
  stageSelection: mutation,
  stageHunk: mutation,
  getConflicts: { conflicts: [{ path: 'README.md', status: 'UU', baseAvailable: true, oursAvailable: true, theirsAvailable: true }] },
  getConflictDetails: { path: 'README.md', base: conflictContent, ours: conflictContent,
    theirs: conflictContent, working: conflictContent, truncated: false },
  acceptConflictSide: mutation,
  markConflictResolved: mutation,
  getStashes: { stashes: [{ index: 0, ref: 'stash@{0}', hash, message: 'Fixture stash', date }] },
  createStash: mutation,
  applyStash: mutation,
  popStash: mutation,
  dropStash: mutation,
  getFileHistory: { commits: [{ hash, author: 'Fixture', email: 'fixture@example.invalid', date, subject: 'Fixture history' }] },
  getBlame: { lines: [{ line: 1, originalLine: 1, finalLine: 1, commit: hash, author: 'Fixture',
    authorMail: 'fixture@example.invalid', authorTime: date, summary: 'Fixture line', content: 'Line one' }], truncated: false },
  getGraph: { commits: [{ graph: '*', hash, parents: [], decorations: ['main'], author: 'Fixture', date, subject: 'Fixture history' }] },
  getRepoInfo: { isGitRepository: true, repoRoot: projectPath, currentWorktreePath: projectPath },
  getWorktrees: { worktrees: [{ path: projectPath, branch: 'main', name: 'App', isCurrent: true, isMain: true,
    isPathMissing: false, lastModifiedAt: null }] },
  getTargetCandidates: { targets: [{ projectPath, repoRoot: projectPath, worktreePath: projectPath, label: 'App', branch: 'main',
    source: 'worktree', isCurrent: true, isMissing: false }] },
  createWorktree: { ...mutation, worktreePath: '/work/app-feature' },
  removeWorktree: mutation,
  commitIndex: mutation,
  stagePaths: mutation,
  revertCommit: mutation,
  collectCommitMessageContext: { diff: 'diff --git a/README.md b/README.md' },
};

const pr = {
  number: 12, title: 'Fixture change', state: 'open', isDraft: false, author: viewer.login,
  headRefName: 'test', baseRefName: 'main', additions: 2, deletions: 1, changedFiles: 1,
  createdAt: date, updatedAt: date, url: 'https://github.example.invalid/acme/app/pull/12',
} as const;
const summary: PullRequestSummary = {
  ...pr, reviewDecision: null, checksState: 'pending', headRefOid: hash, isCrossRepository: false,
  authorAssociation: 'first_time_contributor', authorIsBot: false, authoredByViewer: true,
  labels: ['test'], reviewRequest: null,
};
const ghResults: GhResults = {
  getStatus: { available: false, authenticated: false, reason: 'gh_missing' },
  listPullRequests: { pulls: [summary], repo: { nameWithOwner: repository.nameWithOwner,
    url: 'https://github.example.invalid/acme/app' }, viewerLogin: viewer.login },
  getPullRequest: { ...pr, body: '', headRefOid: hash, mergeable: 'unknown', reviewDecision: 'changes_requested',
    checks: [{ name: 'Status', state: 'pending' }], files: [fileSummary], fileBodies: { 'README.md': patchBody },
    threads: [{ id: 'fixture-thread', path: 'README.md', side: 'after', line: 1, diffHunk: '+line', isOutdated: false,
      comments: [{ id: 1, author: viewer.login, body: 'Fixture comment', createdAt: date }] }] },
  getPullRequestReviewTarget: { repository, viewer, number: 12, state: 'open', headRefOid: hash,
    markedComments: [{ id: 'fixture-comment', url: pr.url, marker: 'fixture', isMinimized: false, author: null }] },
  createPullRequestComment: { id: 'fixture-comment', url: pr.url },
  minimizePullRequestComment: { minimized: true },
};

const ghRequests: GhRequests = {
  getStatus: {},
  listPullRequests: { projectPath },
  getPullRequest: { projectPath, repository, number: 12 },
  getPullRequestReviewTarget: { projectPath, repository, number: 12, marker: 'fixture' },
  createPullRequestComment: { projectPath, repository, actor: viewer, number: 12, body: 'Fixture comment',
    expected: { state: 'open', headRefOid: hash } },
  minimizePullRequestComment: { projectPath, repository, actor: viewer, commentId: 'fixture-comment' },
};

const requests: GitRpcRequest[] = [];
const keys = new Set<string>();
const inputs = await Bun.file(new URL('../inputs/common/git-request-validation.jsonl', import.meta.url)).text();
for (const line of inputs.trimEnd().split('\n')) {
  const { fn, args: [method, input] } = JSON.parse(line);
  if (fn !== 'validateGitRequest' || !isGitMethod(method) || keys.has(method)) continue;
  try { validateGitRequest(method, input); } catch { continue; }
  // All methods use the same envelope, and the original validator binds this input to its method.
  requests.push({ method: `git.${method}`, request: { input, budgetMs: GIT_OPERATION_TIMEOUT_MS } } as GitRpcRequest);
  keys.add(method);
}
for (const [method, input] of Object.entries(ghRequests)) {
  if (!isGhMethod(method)) throw new Error(`Unknown GitHub method ${method}`);
  validateGhRequest(method, input);
  requests.push({ method: `gh.${method}`, request: { input, budgetMs: ghOperationTimeoutMs(method) } } as GitRpcRequest);
}
for (const request of [
  { method: 'git.getCommitSnapshot', request: { input: { projectPath, commit: hash }, budgetMs: 30000 } },
  { method: 'git.getCommitSnapshot', request: { input: { projectPath, commit: hash, parent: null }, budgetMs: 30000 } },
  { method: 'git.getCommitSnapshot', request: { input: { projectPath, commit: hash, parent: hash }, budgetMs: 30000 } },
] satisfies GitRpcRequest[]) requests.push(request);

const results = [
  ...Object.entries(gitResults).map(([method, result]) => [`git.${method}`, { ...result, ...scope }]),
  ...Object.entries(ghResults).map(([method, result]) => [`gh.${method}`, { ...result, ...scope }]),
  ['git.getWorkbenchSnapshot', {
    status: 'not-git-repository', project: projectPath, target: null, tree: null, reviewSummary: null,
    selectedFile: null, firstBodyCandidates: [], message: 'Not a repository', ...scope,
  }],
  ['git.getWorkingTreeFingerprint', {
    status: 'unknown', project: projectPath, fingerprintVersion: 1, fingerprint: null, message: 'Unavailable', ...scope,
  }],
  ['git.getReviewDocumentFileBodies', { status: 'document-expired', documentId: 'doc-1', message: 'Expired', ...scope }],
  ['git.getReviewDocumentFileBodies', { status: 'stale', documentId: 'doc-1', changedPaths: ['README.md'], message: 'Stale', ...scope }],
  ['git.getComparisonSnapshot', { status: 'no-merge-base', project: projectPath, from: revision,
    to: revision, message: 'No merge base', ...scope }],
  ['git.getQuickSummary', { ...gitResults.getQuickSummary, ...scope,
    diagnostics: { phases: [{ name: 'summary-git', durationMs: 1.125 }], commands: [] } }],
];

console.log(JSON.stringify({ requests: requests.map((request) => JSON.stringify(request)),
  results: results.map(([method, result]) => [method, JSON.stringify(result)]) }));
