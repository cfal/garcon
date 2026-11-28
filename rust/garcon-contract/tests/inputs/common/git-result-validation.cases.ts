import { expect, test } from 'bun:test';
import { GIT_MUTATIONS } from '../../../../../common/git-execution.js';
import { isGitPatchBody, validateGhResult, validateGitResult } from '../../../../../common/git-result-validation.js';
import type { GitMethod } from '../../../../../common/git.js';

const scope = { executorId: 'local', instanceId: 'fixture' };
const combined = { ...scope, project: '/repo' };
const sha = 'a'.repeat(40);
const patch = {
  path: 'a.txt', bodyFingerprint: 'body', bodyState: 'loaded', category: 'normal',
  isBinary: false, isTooLarge: false, renderedRowCount: 1, patchBytes: 1,
  patch: '+a', patchDigest: 'a'.repeat(64),
};
const target = { projectPath: '/repo', repoRoot: '/repo', worktreePath: '/repo', label: 'repo', branch: 'main', source: 'worktree' };
const commit = {
  hash: sha, shortHash: 'aaaaaaa', parents: [], refs: ['main'],
  author: 'Author', authorEmail: '', authorDate: '',
  committer: 'Committer', committerEmail: '', committerDate: '', subject: 'Commit',
};
const conflict = { content: null, truncated: false, byteLength: 0, lineCount: 0 };
const reads: Partial<Record<GitMethod, Record<string, unknown>[]>> = {
  getStatus: [{ branch: 'main', hasCommits: true, modified: ['modified'], added: [], deleted: [], untracked: [] }],
  getBranches: [{ branches: ['main'] }],
  getRefs: [{ refs: [{ name: 'main', ref: 'refs/heads/main', kind: 'local-branch', updatedAt: null, isCurrent: true }] }],
  getRemoteStatus: [{ branch: 'main', hasRemote: true, hasUpstream: true, remoteName: 'origin', remoteBranch: 'main', ahead: 1, behind: 2, isUpToDate: false }],
  getRemotes: [{ remotes: [{ name: 'origin', url: 'https://example.invalid/repo' }] }],
  getRepoInfo: [{ isGitRepository: true, repoRoot: '/repo', currentWorktreePath: '/repo' }],
  getWorktrees: [{ worktrees: [{ path: '/repo', branch: 'main', name: 'repo', isCurrent: true, isMain: true, isPathMissing: false, lastModifiedAt: null }] }],
  getTargetCandidates: [{ targets: [{ ...target, isCurrent: true, isMissing: false }] }],
  collectCommitMessageContext: [{ diff: 'text' }],
  getConflicts: [{ conflicts: [{ path: 'example.txt', status: 'UU', baseAvailable: true, oursAvailable: true, theirsAvailable: true }] }],
  getConflictDetails: [{ path: 'a.txt', base: conflict, ours: conflict, theirs: conflict, working: conflict, truncated: false }],
  getStashes: [{ stashes: [{ index: -0, ref: 'stash@{0}', hash: sha, message: 'stash', date: 'now' }] }],
  getFileHistory: [{ commits: [{ hash: sha, author: 'Author', email: '', date: '', subject: '' }] }],
  getGraph: [{ commits: [{ graph: '*', hash: sha, parents: [], decorations: [], author: '', date: '', subject: '' }] }],
  getBlame: [{ truncated: false, lines: [{ line: 1, originalLine: 1, finalLine: 1, commit: sha, author: '', authorMail: '', authorTime: '', summary: '', content: '' }] }],
  getHistoryCommits: [{ project: '/repo', ref: 'main', nextOffset: null, commits: [commit] }],
  getWorkingTreeFingerprint: [
    { project: '/repo', fingerprintVersion: 1, fingerprint: 'f', status: 'ready', changedPathCount: 0 },
    { project: '/repo', fingerprintVersion: 1, fingerprint: null, status: 'unknown', message: 'unavailable' },
  ],
  getQuickSummary: [{ project: '/repo', status: 'ready', branch: 'main', hasChanges: false, hasUntracked: false, diffStats: null }],
  getWorkbenchSnapshot: [{ project: '/repo', status: 'not-git-repository', target: null, tree: null, reviewSummary: null, message: 'no repo' }],
  getReviewDocumentFileBodies: [
    { status: 'ready', documentId: 'doc', files: { 'a.txt': patch }, errors: {}, deferredFiles: [] },
    { status: 'stale', documentId: 'doc', changedPaths: ['a.txt'], message: 'stale' },
    { status: 'document-expired', documentId: 'doc', message: 'expired' },
  ],
  getCommitSnapshot: [{ project: '/repo', status: 'not-found', commit: 'gone', message: 'not found' }],
  getComparisonSnapshot: [{ project: '/repo', status: 'working-tree-changing', message: 'try again' }],
  getComparisonFreshness: [
    { project: '/repo', status: 'ready', changedEndpoints: ['from', 'to'], fromHash: sha, to: { kind: 'working-tree', fingerprint: 'f' } },
    { project: '/repo', status: 'ready', changedEndpoints: [], fromHash: sha, to: { kind: 'revision', hash: sha } },
    { project: '/repo', status: 'not-found', endpoint: 'to', revision: 'gone', message: 'not found' },
  ],
};

test('accepts the scope and rejects a sibling executor for every Git result method', () => {
  const entries = Object.entries(reads) as [GitMethod, Record<string, unknown>[]][];
  for (const method of GIT_MUTATIONS) {
    entries.push([method, [{ success: true, ...(method === 'commit' ? { commitScope: 'selected-files', indexSynchronized: true } : {}) }]]);
  }
  for (const [method, rows] of entries) {
    for (const row of rows) {
      const value = { ...scope, ...row };
      expect(() => validateGitResult(method, value, scope)).not.toThrow();
      expect(() => validateGitResult(method, { ...value, executorId: 'other' }, scope)).toThrow('Invalid Git');
    }
  }
});

test('validates diagnostics, worktree children, bounds, identifiers and deferred paths', () => {
  const check = (method: GitMethod, row: Record<string, unknown>) =>
    () => validateGitResult(method, { ...combined, ...row }, scope);
  expect(check('getBranches', {
    branches: [], diagnostics: { commands: [{ command: 'git status', durationMs: 1, stdoutBytes: 1, stderrBytes: 0 }],
      phases: [{ name: 'resolve', durationMs: 1 }], rowCount: 0 },
  })).not.toThrow();
  expect(check('getBranches', { branches: [], diagnostics: null })).toThrow('Invalid Git');
  expect(check('getBranches', { branches: [], diagnostics: { commands: [], phases: [{ name: 'other', durationMs: 1 }] } })).toThrow('Invalid Git');
  expect(check('getRefs', { refs: Array(501).fill({ name: 'x', ref: 'x', updatedAt: null, kind: 'other' }) })).toThrow('Invalid Git');
  const stash = { index: 0, ref: 'stash@{0}', hash: sha, message: '', date: '' };
  for (const stashes of [[stash, stash], [{ ...stash, index: 0.5 }], [{ ...stash, hash: 'A'.repeat(40) }],
    [{ ...stash, hash: sha + '\n' }], [{ ...stash, ref: 'stash@{1}' }]]) {
    expect(check('getStashes', { stashes })).toThrow('Invalid Git');
  }
  const file = { ...commit, email: '', date: '' };
  expect(check('getFileHistory', { commits: [file, file] })).toThrow('Invalid Git');
  expect(check('getReviewDocumentFileBodies', {
    status: 'ready', documentId: 'doc', files: Object.fromEntries([['__proto__', patch]]), errors: {}, deferredFiles: ['__proto__'],
  })).toThrow('Invalid Git');
  expect(isGitPatchBody(patch)).toBe(true);
  expect(isGitPatchBody({ ...patch, patchDigest: undefined, patch: null })).toBe(true);
  for (const patchDigest of [null, 'a', 'A'.repeat(64), 'a'.repeat(64) + '\n']) {
    expect(isGitPatchBody({ ...patch, patchDigest })).toBe(false);
  }
});

test('validates a populated GitHub list and the result scope before its body', () => {
  const pull = {
    number: 1, title: 'Pull request', state: 'open', isDraft: false, author: 'viewer',
    headRefName: 'topic', baseRefName: 'main', additions: 0, deletions: 0, changedFiles: 0,
    createdAt: '', updatedAt: '', url: 'https://example.invalid/pull/1', headRefOid: sha, reviewDecision: null,
    checksState: 'passing', isCrossRepository: false, authorAssociation: 'first_time_contributor',
    authorIsBot: false, authoredByViewer: true, labels: ['label'], reviewRequest: 'team',
  };
  const result = { ...scope, pulls: [pull], repo: { nameWithOwner: 'acme/repo', url: 'https://example.invalid/acme/repo' }, viewerLogin: 'viewer' };
  expect(() => validateGhResult('listPullRequests', result, scope)).not.toThrow();
  expect(() => validateGhResult('listPullRequests', { ...result, pulls: [{ ...pull, reviewRequest: 'unknown' }] }, scope))
    .toThrow('Invalid GitHub listPullRequests response');
  expect(() => validateGhResult('listPullRequests', { ...result, instanceId: 'other', pulls: null }, scope))
    .toThrow('Invalid GitHub listPullRequests response scope');
});
