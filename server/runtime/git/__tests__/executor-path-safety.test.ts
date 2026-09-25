import { afterEach, expect, test, spyOn } from 'bun:test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { runGit } from '../run.js';
import { withGitOperation } from '../operation-context.js';
import { captureWorkingPathTokens } from '../working-path-token.js';
import { summarizeUntrackedFile, createUntrackedSummaryBudget } from '../working-tree-comparison.js';
import { loadReviewDiffBatches } from '../review-diff-batch.js';
import { GitReviewDocumentRegistry } from '../review-document-registry.js';
import { cleanupExecutorRuntimeFixtures, executorRuntimeFixture } from './executor-runtime-fixture.js';

afterEach(cleanupExecutorRuntimeFixtures);

for (const targetKind of ['outside', 'dangling'] as const) {
  test(`whole-file staging and selected commit preserve ${targetKind} leaf symlinks`, async () => {
    const { root, projectPath, git } = await executorRuntimeFixture();
    const target = path.join(root, targetKind);
    if (targetKind === 'outside') await fs.writeFile(target, 'not link contents\n');
    await fs.symlink(target, path.join(projectPath, 'staged-link'));
    await fs.symlink(target, path.join(projectPath, 'committed-link'));
    await git.stagePaths({ projectPath, paths: ['staged-link'], mode: 'stage' });
    expect((await runGit(projectPath, ['ls-files', '-s', 'staged-link'])).stdout).toStartWith('120000 ');
    expect((await runGit(projectPath, ['show', ':staged-link'])).stdout).toBe(target);
    await git.commit({ projectPath, files: ['committed-link'], message: 'Commit a symlink' });
    expect((await runGit(projectPath, ['ls-tree', 'HEAD', 'committed-link'])).stdout).toStartWith('120000 ');
    expect((await runGit(projectPath, ['show', 'HEAD:committed-link'])).stdout).toBe(target);
    expect((await runGit(projectPath, ['diff', '--cached', '--name-only'])).stdout).toBe('staged-link\n');
  });
}

for (const replacement of ['leaf', 'parent', 'missing-parent'] as const) {
  test(`immutable history ignores a current ${replacement} symlink`, async () => {
    const { root, projectPath, git } = await executorRuntimeFixture();
    await fs.mkdir(path.join(projectPath, 'dir'));
    await fs.writeFile(path.join(projectPath, 'dir/file.txt'), 'historical content\n');
    await runGit(projectPath, ['add', '.']);
    await runGit(projectPath, ['commit', '-m', 'Historical file']);
    const target = path.join(root, 'outside');
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, 'file.txt'), 'outside content\n');
    const replaced = path.join(projectPath, replacement === 'leaf' ? 'dir/file.txt' : 'dir');
    await fs.rm(replaced, { recursive: true });
    await fs.symlink(replacement === 'leaf' ? path.join(target, 'file.txt') : replacement === 'parent' ? target : path.join(root, 'missing'), replaced);
    const snapshot = await git.getCommitSnapshot({ projectPath, commit: 'HEAD', context: 2 });
    if (snapshot.status !== 'ready') throw new Error('Expected commit');
    const document = { executorId: snapshot.executorId, instanceId: snapshot.instanceId, documentId: snapshot.documentId };
    const loaded = await git.getReviewDocumentFileBodies({ projectPath, document, files: ['dir/file.txt'], purpose: 'visible' });
    if (loaded.status !== 'ready') throw new Error('Expected historical patch');
    expect(loaded.files['dir/file.txt'].patch).toContain('+historical content');
    expect(loaded.files['dir/file.txt'].patch).not.toContain('outside content');
    const history = await git.getFileHistory({ projectPath, file: 'dir/file.txt' });
    expect(history.commits[0].subject).toBe('Historical file');
    const blame = await git.getBlame({ projectPath, file: 'dir/file.txt', ref: 'HEAD', limit: 1 });
    expect(blame.lines[0].content).toBe('historical content');
  });
}

for (const replacement of ['outside', 'dangling'] as const) {
  test(`working review treats descendants of a ${replacement} directory symlink as deleted`, async () => {
    const { root, projectPath, git } = await executorRuntimeFixture();
    await fs.mkdir(path.join(projectPath, 'dir'));
    await fs.writeFile(path.join(projectPath, 'dir/file.txt'), 'tracked descendant\n');
    await runGit(projectPath, ['add', '.']);
    await runGit(projectPath, ['commit', '-m', 'Track directory']);
    const outside = path.join(root, replacement);
    if (replacement === 'outside') {
      await fs.mkdir(outside);
      await fs.writeFile(path.join(outside, 'file.txt'), 'outside secret\n');
    }
    await fs.rm(path.join(projectPath, 'dir'), { recursive: true });
    await fs.symlink(outside, path.join(projectPath, 'dir'));
    await fs.writeFile(path.join(projectPath, 'tracked.txt'), 'unrelated change\n');
    const lstat = spyOn(fs, 'lstat');
    try {
      const snapshot = await git.getWorkbenchSnapshot({ projectPath, mode: 'working', context: 2 });
      if (snapshot.status !== 'ready') throw new Error('Expected working snapshot');
      const document = { executorId: snapshot.executorId, instanceId: snapshot.instanceId, documentId: snapshot.reviewSummary.documentId };
      const loaded = await git.getReviewDocumentFileBodies({ projectPath, document, files: ['dir/file.txt', 'tracked.txt'], purpose: 'visible' });
      if (loaded.status !== 'ready') throw new Error('Expected working bodies');
      expect(loaded.files['dir/file.txt'].patch).toContain('-tracked descendant');
      expect(loaded.files['dir/file.txt'].patch).not.toContain('outside secret');
      expect(loaded.files['tracked.txt'].patch).toContain('+unrelated change');
      expect(lstat.mock.calls.some(([entry]) => entry === path.join(projectPath, 'dir/file.txt'))).toBe(false);
    } finally { lstat.mockRestore(); }
  });
}

test('index-only review and unstaging ignore current parent symlinks', async () => {
  const { root, projectPath, git } = await executorRuntimeFixture();
  await fs.mkdir(path.join(projectPath, 'dir'));
  await fs.writeFile(path.join(projectPath, 'dir/file.txt'), 'staged content\n');
  await runGit(projectPath, ['add', '.']);
  await fs.rm(path.join(projectPath, 'dir'), { recursive: true });
  await fs.symlink(root, path.join(projectPath, 'dir'));
  const snapshot = await git.getWorkbenchSnapshot({ projectPath, mode: 'staged', context: 2 });
  if (snapshot.status !== 'ready') throw new Error('Expected staged snapshot');
  const document = { executorId: snapshot.executorId, instanceId: snapshot.instanceId, documentId: snapshot.reviewSummary.documentId };
  const loaded = await git.getReviewDocumentFileBodies({ projectPath, document, files: ['dir/file.txt'], purpose: 'visible' });
  if (loaded.status !== 'ready') throw new Error('Expected staged body');
  expect(loaded.files['dir/file.txt'].patch).toContain('+staged content');
  await git.stagePaths({ projectPath, paths: ['dir/file.txt'], mode: 'unstage' });
  expect((await runGit(projectPath, ['ls-files', 'dir/file.txt'])).stdout).toBe('');
});

test('lexical escapes and working operations through outside parents remain forbidden', async () => {
  const { root, projectPath, git } = await executorRuntimeFixture();
  await fs.writeFile(path.join(root, 'outside.txt'), 'outside\n');
  await fs.symlink(root, path.join(projectPath, 'link'));
  for (const file of ['../outside.txt', path.join(root, 'outside.txt')]) {
    await expect(git.getFileHistory({ projectPath, file })).rejects.toMatchObject({ code: 'GIT_OUTSIDE_BASE' });
    await expect(git.getBlame({ projectPath, file, ref: 'HEAD' })).rejects.toMatchObject({ code: 'GIT_OUTSIDE_BASE' });
  }
  for (const file of ['../outside.txt', 'link/outside.txt']) {
    await expect(git.stagePaths({ projectPath, paths: [file], mode: 'stage' })).rejects.toMatchObject({ code: 'GIT_OUTSIDE_BASE' });
    await expect(git.commit({ projectPath, files: [file], message: 'No escape' })).rejects.toMatchObject({ code: 'GIT_OUTSIDE_BASE' });
    await expect(git.getConflictDetails({ projectPath, file })).rejects.toMatchObject({ code: 'GIT_OUTSIDE_BASE' });
  }
  await fs.symlink(path.join(root, 'outside.txt'), path.join(projectPath, 'leaf'));
  await expect(git.getConflictDetails({ projectPath, file: 'leaf' })).rejects.toMatchObject({ code: 'GIT_OUTSIDE_BASE' });
  await expect(git.deleteUntracked({ projectPath, file: 'leaf' })).rejects.toMatchObject({ code: 'GIT_OUTSIDE_BASE' });
  expect(await fs.readFile(path.join(root, 'outside.txt'), 'utf8')).toBe('outside\n');
});

test('content and metadata sinks reject outside parents before accessing the entry', async () => {
  const { root, projectPath } = await executorRuntimeFixture();
  await fs.writeFile(path.join(root, 'secret.txt'), 'outside secret\n');
  await fs.symlink(root, path.join(projectPath, 'link'));
  const file = 'link/secret.txt';
  const lstat = spyOn(fs, 'lstat');
  try {
    await withGitOperation(projectPath, undefined, async () => {
      await expect(captureWorkingPathTokens(projectPath, [file], { statusEntries: [], indexEntriesByPath: new Map() })).rejects.toMatchObject({ name: 'ProjectBoundaryError' });
      expect(await summarizeUntrackedFile(projectPath, file, createUntrackedSummaryBudget())).toMatchObject({ unsupported: true });
      const registry = new GitReviewDocumentRegistry();
      const document = registry.register({
        sourceCacheKey: 'untracked-boundary', projectPath, repoRoot: projectPath, context: 2,
        source: { kind: 'workbench', mode: 'working', stagedBaseHash: 'HEAD', fingerprint: 'test' },
        files: [{ path: file, change: { kind: 'workbench', indexStatus: '?', workTreeStatus: '?' }, category: 'normal', additions: 1, deletions: 0, estimatedRows: 2, bodyState: 'unloaded', bodyFingerprint: 'test', isBinary: false, isTooLarge: false }],
      });
      const loaded = await loadReviewDiffBatches(document, [document.filesByPath.get(file)!]);
      expect(loaded.bodies[0]).toMatchObject({ bodyState: 'error', patch: null });
    });
    expect(lstat.mock.calls.some(([entry]) => entry === path.join(projectPath, file))).toBe(false);
  } finally { lstat.mockRestore(); }
});

test('whole-file staging treats pathspec metacharacters as literal file names', async () => {
  const { projectPath, git } = await executorRuntimeFixture();
  for (const file of ['*.txt', 'other.txt', ':(glob)*']) await fs.writeFile(path.join(projectPath, file), 'untracked\n');
  await git.stagePaths({ projectPath, paths: ['*.txt', ':(glob)*'], mode: 'stage' });
  expect((await runGit(projectPath, ['diff', '--cached', '--name-only'])).stdout.trim().split('\n')).toEqual(['*.txt', ':(glob)*']);
});
