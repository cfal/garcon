import { expect, test } from 'bun:test';
import {
  isUnresolvedRevision, needsRevisionFailureDiagnostics,
} from '../../../../server/runtime/git/comparison-errors.js';
import {
  parseNameStatusZ, parseNumstatZ, parseUnmergedPaths,
} from '../../../../server/runtime/git/diff-file-list.js';
import { notRepositorySnapshot } from '../../../../server/runtime/git/diff-engine.js';
import { classifyGitError } from '../../../../server/runtime/git/git-error-classifier.js';
import { nulRecords } from '../../../../server/runtime/git/log-records.js';
import {
  changeKindForStatus, hasIndexChange, hasWorkTreeChange, parsePorcelainV1Z,
} from '../../../../server/runtime/git/porcelain-status.js';
import { notRepositoryQuickSummary } from '../../../../server/runtime/git/quick-summary.js';
import { assertSafeRef, assertSafeRemoteName } from '../../../../server/runtime/git/ref-validation.js';
import {
  isGitReviewCollectionLimitBody, limitGitReviewResponseBodies, loadedGitReviewBodyTotals, planReviewDiffBatches,
} from '../../../../server/runtime/git/review-diff-batch.js';
import {
  registeredTreeDiffFile, registeredWorkbenchFile,
} from '../../../../server/runtime/git/review-document-registry.js';
import {
  categoryForPath, createReviewPatchBody, errorPatchFileBody, limitedPatchFileBody,
} from '../../../../server/runtime/git/review-patch.js';
import type { GitCommitFileSummary, GitReviewFilePatchBody, GitReviewFileSummary, GitReviewLimitReason } from '../../../../common/git.js';
import { changedWorkingPathTokens, type GitWorkingPathToken } from '../../../../server/runtime/git/working-path-token.js';
import { notRepositoryFingerprint, parseLsFilesStageZ } from '../../../../server/runtime/git/working-tree-observation.js';
import { compareWorktreePaths, type WorktreeRecord } from '../../../../server/runtime/git/worktree-record.js';
import { serializeWorktreeMtime } from '../../../../server/runtime/git/worktrees.js';

test('reads numstat, rename, copy, and stage records with literal tab and newline names', () => {
  const stats = parseNumstatZ('1\t2\ta\tb\0-\t-\tbin\0+3abc\t-2\t\0before\0after\nname\0bad\0');
  expect(stats).toEqual({ 'a\tb': { additions: 1, deletions: 2 }, bin: { additions: 0, deletions: 0, isBinary: true },
    'after\nname': { additions: 3, deletions: -2 } });
  expect(parseNameStatusZ('M\0a\tb\0R099\0before\0after\nname\0M\0bin\0C100\0src\0copy\0M\0', stats)).toEqual([
    { path: 'a\tb', status: 'M', additions: 1, deletions: 2 },
    { path: 'after\nname', originalPath: 'before', status: 'R099', additions: 3, deletions: -2 },
    { path: 'bin', status: 'M', additions: 0, deletions: 0, isBinary: true },
    { path: 'copy', originalPath: 'src', status: 'C100', additions: 0, deletions: 0 },
  ]);
  const stages = ['100644 abc 1\tpath', 'broken', '100644 xyz 2\tpath', '100644 xyz 3\tother\tpath', ''].join('\0');
  expect([...parseUnmergedPaths(stages)]).toEqual(['path', 'other\tpath']);
  expect([...parseLsFilesStageZ(stages)]).toEqual([
    ['path', '100644 xyz 2\tpath'], ['other\tpath', '100644 xyz 3\tother\tpath'],
  ]);
  expect(parseNumstatZ('1\t2\t\0from\0')).toEqual({});
  expect(parseNameStatusZ('M\0unlisted', {})).toEqual([{ path: 'unlisted', status: 'M', additions: 0, deletions: 0 }]);
});

test('observes the original plain-object behavior for legal file names', () => {
  const stats = parseNumstatZ('2\t3\t__proto__\0');
  expect(Object.keys(stats)).toEqual([]);
  expect(Object.getPrototypeOf(stats)).toEqual({ additions: 2, deletions: 3 });
  expect<unknown>(parseNameStatusZ('M\0__proto__\0M\0constructor\0', {})).toEqual([
    { path: '__proto__', status: 'M', additions: undefined, deletions: undefined },
    { path: 'constructor', status: 'M', additions: undefined, deletions: undefined },
  ]);
});

test('maps porcelain status per column and preserves literal names', () => {
  expect(['M', 'A', 'D', 'R', 'C', 'U', '?', '!', '', 'T'].map((status) => changeKindForStatus(status)))
    .toEqual(['modified', 'added', 'deleted', 'renamed', 'renamed', 'modified', 'untracked', 'modified', 'modified', 'modified']);
  expect(['?', '!', ' ', '', 'M', 'T'].map((status) => hasIndexChange(status))).toEqual([false, false, false, false, true, true]);
  expect(['?', '!', ' ', '', 'M', 'T'].map((status) => hasWorkTreeChange(status))).toEqual([true, false, false, false, true, true]);
  expect(parsePorcelainV1Z(' T a\tb\n\0\0!! ignored\0M')).toEqual([
    { path: 'a\tb\n', indexStatus: ' ', workTreeStatus: 'T' },
    { path: 'ignored', indexStatus: '!', workTreeStatus: '!' },
    { path: '', indexStatus: 'M', workTreeStatus: ' ' },
  ]);
});

test('rejects unsafe refs and remotes without invoking Git', () => {
  for (const name of ['HEAD', 'origin/main', 'stash@{1}', 'main~2^', 'topic+1']) expect(() => assertSafeRef(name, 'base')).not.toThrow();
  for (const name of ['', '.', '--help', 'x..y', 'a:b', 'a b', 'a\0b', 'a\u007fb', '\u00e9', 'a\n']) {
    expect(() => assertSafeRef(name, 'base')).toThrow('Invalid base ref.');
  }
  expect(() => assertSafeRemoteName('my-origin')).not.toThrow();
  for (const name of ['', '.', '-o', 'team/origin', 'a..b', 'a:b', 'origin\t', 'origin\u00a0']) {
    expect(() => assertSafeRemoteName(name)).toThrow('Invalid remote.');
  }
  expect(() => assertSafeRemoteName('@', 'push remote')).toThrow('Invalid push remote.');
});

test('frames log records on NUL, not on printable separators', () => {
  expect(nulRecords('a\0b\u001ec\0d\0\0', 2, 'commit log')).toEqual([['a', 'b\u001ec'], ['d', '']]);
  expect(nulRecords('', 2, 'commit log')).toEqual([]);
  expect(() => nulRecords('abc\0', 2, 'commit log')).toThrow('Git returned an unreadable commit log.');
  expect(() => nulRecords('abc', 2, 'history')).toThrow('Git returned an unreadable history.');
});

test('distinguishes operational errors from expected revision misses', () => {
  expect(isUnresolvedRevision({ code: 1, stderr: 'unexpected' })).toBe(true);
  expect(isUnresolvedRevision({ code: 128, aborted: true })).toBe(false);
  expect(isUnresolvedRevision({ code: 128, stderr: "fatal: log for 'HEAD' only has 1 entries\n" })).toBe(true);
  expect(isUnresolvedRevision({ code: 128, stderr: 'fatal: unexpected' })).toBe(false);
  expect(needsRevisionFailureDiagnostics({ code: 128, stdout: ' \t', stderr: '\n' })).toBe(true);
  expect(needsRevisionFailureDiagnostics({ code: 128, stdout: 'bad output' })).toBe(false);
  expect(needsRevisionFailureDiagnostics({ code: 128, timedOut: true })).toBe(false);
  expect(classifyGitError(new Error('Host key verification failed.')).code).toBe('HOST_KEY');
  expect(classifyGitError(new Error('permission denied after a conflict')).code).toBe('AUTH_FAILED');
  expect(classifyGitError({ message: 'CONFLICT: blocked' }).code).toBe('CONFLICT');
  expect(classifyGitError('permission denied').message).toBe('Git operation failed.');
});

test('returns the non-repository result of each read without spawning Git', () => {
  expect(notRepositorySnapshot('/workspace').status).toBe('not-git-repository');
  expect(notRepositoryQuickSummary('/workspace').status).toBe('not-git-repository');
  expect(notRepositoryFingerprint('/workspace').status).toBe('not-git-repository');
});

test('sorts administrative worktree paths by Git bytes and serializes mtimes', () => {
  const entry = (path: string): WorktreeRecord => ({ path, name: '', branch: 'main', isMain: false });
  expect(compareWorktreePaths(entry('/\ue000'), entry('/\u{10000}'))).toBe(-1);
  expect(compareWorktreePaths(entry('/\u00e9'), entry('/e'))).toBe(1);
  expect(compareWorktreePaths(entry('/same'), entry('/same'))).toBe(0);
  expect(serializeWorktreeMtime(new Date('2026-01-02T03:04:05.006Z'))).toBe('2026-01-02T03:04:05.006Z');
  expect(serializeWorktreeMtime(new Date(NaN))).toBeNull();
});

test('compares working-path snapshots by key and serialized token', () => {
  const token = (path: string): GitWorkingPathToken => ({ path, indexEntry: null, status: ' M',
    worktreeKind: 'file', worktreeSize: '1', worktreeMtimeNs: '2', worktreeCtimeNs: '3' });
  const base = new Map(['same', 'edited', 'deleted'].map((path) => [path, token(path)]));
  const current = new Map([['edited', { ...token('edited'), worktreeMtimeNs: '4' }], ['extra', token('extra')], ['same', token('same')]]);
  expect(changedWorkingPathTokens(base, current)).toEqual(['edited', 'deleted']);
  expect(changedWorkingPathTokens(new Map(), current)).toEqual([]);
  expect(changedWorkingPathTokens(base, new Map())).toEqual(['same', 'edited', 'deleted']);
});

test('classifies review bodies, registers both file shapes, and preserves budgets', () => {
  for (const [path, category] of [
    ['pkg/Cargo.lock', 'lockfile'], ['folder\\generated\\out.ts', 'generated'], ['script.min.js', 'generated'],
    ['src/file.ts', 'normal'], ['other/src/lib/paraglide/lang.ts', 'generated'], ['generated/top.ts', 'normal'],
  ] as const) expect(categoryForPath(path)).toBe(category);
  const reasons: GitReviewLimitReason[] = [
    'collection-too-many-files', 'collection-too-many-rows', 'collection-too-many-bytes', 'file-too-many-rows',
    'file-too-many-bytes', 'line-too-long', 'binary', 'unsupported-file-kind', 'git-timeout',
  ];
  for (const reason of reasons) expect(limitedPatchFileBody('a', 'fp', reason, 'fixture').limitReason).toBe(reason);
  expect(errorPatchFileBody('x/a.min.js', 'fp', 'fixture').category).toBe('generated');
  expect(createReviewPatchBody('bin', 'fp', 'GIT binary patch\n').bodyState).toBe('binary');
  const file = { path: 'a', category: 'normal', additions: 1, deletions: 0, estimatedRows: 10_001,
    bodyState: 'unloaded', bodyFingerprint: 'fp', isGenerated: false, isBinary: false, isTooLarge: false } as const;
  const review: GitReviewFileSummary = { ...file, indexStatus: ' ', workTreeStatus: 'A' };
  const commit: GitCommitFileSummary = { ...file, status: 'renamed', rawStatus: 'R099', originalPath: 'old' };
  const working = registeredWorkbenchFile(review);
  const historical = registeredTreeDiffFile(commit);
  expect(working.change.kind).toBe('workbench');
  expect(historical.originalPath).toBe('old');
  expect(planReviewDiffBatches([working, historical])).toEqual([[working], [historical]]);
  const body = (path: string, renderedRowCount: number): GitReviewFilePatchBody => ({
    path, bodyFingerprint: 'fp', bodyState: 'loaded', category: 'normal', isBinary: false,
    isTooLarge: false, renderedRowCount, patchBytes: 42, patch: 'sample',
  });
  const limit = limitedPatchFileBody('b', 'fp', 'collection-too-many-bytes', 'fixture');
  expect(isGitReviewCollectionLimitBody(limit)).toBe(true);
  expect(isGitReviewCollectionLimitBody(body('a', 1))).toBe(false);
  expect(loadedGitReviewBodyTotals([body('a', 1), limit, body('c', 3)])).toEqual({ loadedRows: 4, loadedBytes: 84 });
  expect(limitGitReviewResponseBodies([body('a', 1), limit, body('c', 3)])).toEqual([body('a', 1), limit]);
  expect(limitGitReviewResponseBodies([body('a', 50_000), body('b', 50_001)]).at(-1)?.limitReason).toBe('collection-too-many-rows');
});
