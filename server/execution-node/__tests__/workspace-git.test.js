import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createLocalWorkspaceGitService } from '../local-workspace-git.js';
import { KeyedPromiseLock } from '../../lib/keyed-lock.js';
import { resolveRealWithinBase } from '../../lib/path-boundary.js';

const directories = [];

async function git(projectPath, args) {
  const child = Bun.spawn(['git', ...args], { cwd: projectPath, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  if (code !== 0) throw new Error(`git ${args[0]} failed: ${stderr}`);
  return stdout.trim();
}

async function repository() {
  const directory = await fs.mkdtemp(path.join(os.homedir(), 'garcon-workspace-git-'));
  directories.push(directory);
  const projectPath = path.join(directory, 'repo');
  const aliasPath = path.join(directory, 'alias');
  await fs.mkdir(projectPath);
  await git(projectPath, ['init', '-b', 'main']);
  await git(projectPath, ['config', 'user.email', 'synthetic@example.test']);
  await git(projectPath, ['config', 'user.name', 'Synthetic User']);
  await fs.writeFile(path.join(projectPath, 'a.txt'), 'original a\n');
  await fs.writeFile(path.join(projectPath, 'b.txt'), 'original b\n');
  await git(projectPath, ['add', '.']);
  await git(projectPath, ['commit', '-m', 'initial']);
  await fs.symlink(projectPath, aliasPath);
  const authorize = (target) => resolveRealWithinBase(directory, target);
  const service = createLocalWorkspaceGitService({ assertProjectPathAllowed: authorize, networkTimeoutMs: 30_000 });
  return { directory, projectPath, aliasPath, authorize, service };
}

function heldAuthorization(authorize) {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const service = createLocalWorkspaceGitService({
    networkTimeoutMs: 30_000,
    assertProjectPathAllowed: async (target) => {
      entered.resolve();
      await release.promise;
      return authorize(target);
    },
  });
  return { entered, release, service };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe('local workspace Git owner', () => {
  test.each(['stagePaths', 'commit'])('captures the %s file selection before owner authorization', async (operation) => {
    const { projectPath, authorize } = await repository();
    await fs.writeFile(path.join(projectPath, 'a.txt'), 'selected change\n');
    await fs.writeFile(path.join(projectPath, 'b.txt'), 'unselected change\n');
    const held = heldAuthorization(authorize);
    const selection = ['a.txt'];
    const result = operation === 'stagePaths'
      ? held.service.stagePaths({ projectPath, paths: selection, mode: 'stage' })
      : held.service.commit({ projectPath, files: selection, message: 'selected change' });
    try {
      await held.entered.promise;
      selection[0] = 'b.txt';
      held.release.resolve();
      expect(await result).toMatchObject({ success: true });
      expect(await git(projectPath, operation === 'stagePaths'
        ? ['diff', '--cached', '--name-only']
        : ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'])).toBe('a.txt');
      expect(await git(projectPath, ['diff', '--name-only'])).toBe('b.txt');
    } finally {
      held.release.resolve();
      await result.catch(() => {});
    }
  });

  test('captures selected line indices before owner authorization', async () => {
    const { projectPath, authorize } = await repository();
    await fs.writeFile(path.join(projectPath, 'a.txt'), 'one\ntwo\nthree\n');
    await git(projectPath, ['add', 'a.txt']);
    await git(projectPath, ['commit', '-m', 'synthetic lines']);
    await fs.writeFile(path.join(projectPath, 'a.txt'), 'ONE\ntwo\nTHREE\n');
    const held = heldAuthorization(authorize);
    const selection = { lineIndices: [0, 1] };
    const result = held.service.stageSelection({ projectPath, file: 'a.txt', mode: 'stage', selection, contextLines: 3 });
    try {
      await held.entered.promise;
      selection.lineIndices.splice(0, 2, 3, 4);
      held.release.resolve();
      expect(await result).toEqual({ success: true });
      expect(await git(projectPath, ['show', ':a.txt'])).toBe('ONE\ntwo\nthree');
      expect(await fs.readFile(path.join(projectPath, 'a.txt'), 'utf8')).toBe('ONE\ntwo\nTHREE\n');
    } finally {
      held.release.resolve();
      await result.catch(() => {});
    }
  });

  test.each(['getComparisonSnapshot', 'getComparisonFreshness'])('captures %s revision selectors before owner authorization', async (operation) => {
    const { projectPath, authorize } = await repository();
    const hash = await git(projectPath, ['rev-parse', 'HEAD']);
    const held = heldAuthorization(authorize);
    const from = { kind: 'revision', revision: 'HEAD', hash };
    const to = { kind: 'revision', revision: 'HEAD', hash };
    const result = operation === 'getComparisonSnapshot'
      ? held.service.getComparisonSnapshot({ projectPath, from, to, mode: 'direct' })
      : held.service.getComparisonFreshness({ projectPath, from, to });
    try {
      await held.entered.promise;
      from.revision = 'missing-source';
      to.revision = 'missing-target';
      held.release.resolve();
      const response = await result;
      expect(response.status).toBe('ready');
      if (operation === 'getComparisonSnapshot') {
        expect(response.from.hash).toBe(hash);
        expect(response.to.hash).toBe(hash);
      } else {
        expect(response.fromHash).toBe(hash);
        expect(response.changedEndpoints).toEqual([]);
      }
    } finally {
      held.release.resolve();
      await result.catch(() => {});
    }
  });

  test('shares review document identity between an alias snapshot and canonical body request', async () => {
    const { projectPath, aliasPath, service } = await repository();
    await fs.writeFile(path.join(projectPath, 'a.txt'), 'captured change\n');
    await git(projectPath, ['add', 'a.txt']);
    const snapshot = await service.getWorkbenchSnapshot({ projectPath: aliasPath, mode: 'staged', context: 3 });
    expect(snapshot.status).toBe('ready');
    const bodies = await service.getReviewDocumentFileBodies({
      projectPath, documentId: snapshot.reviewSummary.documentId, files: ['a.txt'], purpose: 'visible',
    });
    expect(bodies.status).toBe('ready');
    expect(bodies.files['a.txt'].patch).toContain('+captured change');
  });
  test('preserves process-local trace and metrics accumulators without returning them', async () => {
    const { projectPath, aliasPath, service } = await repository();
    await fs.writeFile(path.join(projectPath, 'a.txt'), 'changed a\n');
    const trace = [];
    const metrics = { phases: [] };
    const snapshot = await service.getWorkbenchSnapshot({
      projectPath: aliasPath, mode: 'working', context: 3, trace, metrics,
    });
    expect(snapshot.status).toBe('ready');
    expect(trace.length).toBeGreaterThan(0);
    expect(metrics.phases.length).toBeGreaterThan(0);
    expect(snapshot).not.toHaveProperty('trace');
    expect(snapshot).not.toHaveProperty('metrics');
  });

  test('serializes commits across service instances and aliases of the same repository', async () => {
    const { projectPath, aliasPath, authorize, service } = await repository();
    const other = createLocalWorkspaceGitService({ assertProjectPathAllowed: authorize, networkTimeoutMs: 30_000 });
    await fs.writeFile(path.join(projectPath, 'a.txt'), 'changed a\n');
    await fs.writeFile(path.join(projectPath, 'b.txt'), 'changed b\n');
    const entered = Promise.withResolvers();
    const queued = Promise.withResolvers();
    const release = Promise.withResolvers();
    const original = KeyedPromiseLock.prototype.runExclusive;
    const calls = [];
    const entries = [];
    const lock = spyOn(KeyedPromiseLock.prototype, 'runExclusive').mockImplementation(function(key, operation, signal) {
      const index = calls.push({ lock: this, key });
      if (index === 2) queued.resolve();
      return original.call(this, key, async () => {
        entries.push(index);
        if (index === 1) {
          entered.resolve();
          await release.promise;
        }
        return operation();
      }, signal);
    });
    const pending = [];
    try {
      const first = service.commit({ projectPath, message: 'change a', files: ['a.txt'] });
      pending.push(first);
      await Promise.race([entered.promise, first.then(() => { throw new Error('First commit skipped its lock'); })]);
      const second = other.commit({ projectPath: aliasPath, message: 'change b', files: ['b.txt'] });
      pending.push(second);
      await Promise.race([queued.promise, second.then(() => { throw new Error('Second commit skipped its lock'); })]);
      expect(calls).toHaveLength(2);
      expect(calls[0].lock).toBe(calls[1].lock);
      expect(calls.map(({ key }) => key)).toEqual([path.join(projectPath, '.git'), path.join(projectPath, '.git')]);
      expect(entries).toEqual([1]);
      release.resolve();
      expect(await Promise.all(pending)).toEqual([
        expect.objectContaining({ success: true, commitScope: 'selected-files', indexSynchronized: true }),
        expect.objectContaining({ success: true, commitScope: 'selected-files', indexSynchronized: true }),
      ]);
      expect(entries).toEqual([1, 2]);
      expect(await git(projectPath, ['log', '-2', '--format=%s'])).toBe('change b\nchange a');
    } finally {
      release.resolve();
      await Promise.allSettled(pending);
      lock.mockRestore();
    }
  });

  test('authorizes project then worktree and supports an absent contained destination', async () => {
    const { projectPath, aliasPath, directory, authorize } = await repository();
    const checked = [];
    const service = createLocalWorkspaceGitService({
      assertProjectPathAllowed: async (target) => { checked.push(target); return authorize(target); },
      networkTimeoutMs: 30_000,
    });
    const parentAlias = path.join(directory, 'workspace-alias');
    await fs.symlink(directory, parentAlias);
    const worktreePath = path.join(parentAlias, 'new-worktree');
    const canonicalWorktreePath = path.join(directory, 'new-worktree');
    const created = await service.createWorktree({ projectPath: aliasPath, worktreePath, detach: true });
    expect(checked).toEqual([aliasPath, worktreePath]);
    expect(created).toMatchObject({ success: true, worktreePath: canonicalWorktreePath });
    expect((await fs.stat(canonicalWorktreePath)).isDirectory()).toBe(true);
    checked.length = 0;
    await service.removeWorktree({ projectPath: aliasPath, worktreePath });
    expect(checked).toEqual([aliasPath, worktreePath]);
    await expect(fs.stat(canonicalWorktreePath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await git(projectPath, ['status', '--porcelain'])).toBe('');
  });

  test.each(['createWorktree', 'removeWorktree'])('refuses an outside destination before %s mutates Git', async (method) => {
    const { projectPath, directory, authorize } = await repository();
    const checked = [];
    const service = createLocalWorkspaceGitService({
      assertProjectPathAllowed: async (target) => { checked.push(target); return authorize(target); },
      networkTimeoutMs: 30_000,
    });
    const worktreePath = path.join(directory, '..', 'unprovisioned-destination');
    const before = await git(projectPath, ['worktree', 'list', '--porcelain']);
    await expect(service[method]({ projectPath, worktreePath, detach: true })).rejects.toMatchObject({
      errorCode: 'outside_project_base',
    });
    expect(checked).toEqual([projectPath, worktreePath]);
    expect(await git(projectPath, ['worktree', 'list', '--porcelain'])).toBe(before);
  });

  test('cancellation during project authorization prevents the mutation', async () => {
    const { projectPath, authorize } = await repository();
    await fs.writeFile(path.join(projectPath, 'a.txt'), 'not staged\n');
    const authorizing = Promise.withResolvers();
    const release = Promise.withResolvers();
    const controller = new AbortController();
    const service = createLocalWorkspaceGitService({
      networkTimeoutMs: 30_000,
      assertProjectPathAllowed: async (target) => {
        authorizing.resolve();
        await release.promise;
        return authorize(target);
      },
    });
    const mutation = service.stagePaths({ projectPath, paths: ['a.txt'], mode: 'stage', signal: controller.signal });
    try {
      await authorizing.promise;
      controller.abort();
      release.resolve();
      await expect(mutation).rejects.toBe(controller.signal.reason);
      expect(await git(projectPath, ['diff', '--cached', '--name-only'])).toBe('');
    } finally {
      release.resolve();
      await mutation.catch(() => {});
    }
  });

  test('captures the selected files before asynchronous authorization and returns immutable source', async () => {
    const { projectPath, aliasPath, authorize } = await repository();
    await fs.writeFile(path.join(projectPath, 'a.txt'), 'selected source\n');
    await fs.writeFile(path.join(projectPath, 'b.txt'), 'unselected source\n');
    await git(projectPath, ['add', '.']);
    const authorizing = Promise.withResolvers();
    const release = Promise.withResolvers();
    const service = createLocalWorkspaceGitService({
      networkTimeoutMs: 30_000,
      assertProjectPathAllowed: async (target) => {
        authorizing.resolve();
        await release.promise;
        return authorize(target);
      },
    });
    const options = { projectPath: aliasPath, files: ['a.txt'] };
    const result = service.captureCommitMessageSource(options);
    try {
      await authorizing.promise;
      options.projectPath = 'changed-after-admission';
      options.files[0] = 'b.txt';
      release.resolve();
      const source = await result;
      expect(source.projectPath).toBe(projectPath);
      expect(source.files).toEqual(['a.txt']);
      expect(source.diffContext).toContain('+selected source');
      expect(source.diffContext).not.toContain('unselected source');
      expect(Object.isFrozen(source)).toBe(true);
      expect(Object.isFrozen(source.files)).toBe(true);
    } finally {
      release.resolve();
      await result.catch(() => {});
    }
  });

  test('refuses both an empty selection and selected files with no staged changes', async () => {
    const { projectPath, service } = await repository();
    for (const files of [[], ['a.txt']]) {
      await expect(service.captureCommitMessageSource({ projectPath, files })).rejects.toMatchObject({
        code: 'COMMIT_MESSAGE_NO_STAGED_FILES',
      });
    }
  });

});

const project = { projectPath: '/not-authorized/repository' };
const file = { ...project, file: 'a.txt' };
/** @satisfies {Record<keyof import('../../execution-nodes/workspace-git.js').WorkspaceGitService, (service: import('../../execution-nodes/workspace-git.js').WorkspaceGitService) => Promise<unknown>>} */
const boundaryOperations = {
  getStatus: (service) => service.getStatus(project),
  initialCommit: (service) => service.initialCommit(project),
  commit: (service) => service.commit({ ...project, files: ['a.txt'], message: 'synthetic' }),
  getBranches: (service) => service.getBranches(project),
  getRefs: (service) => service.getRefs(project),
  checkout: (service) => service.checkout({ ...project, ref: 'HEAD' }),
  createBranch: (service) => service.createBranch({ ...project, branch: 'synthetic' }),
  captureCommitMessageSource: (service) => service.captureCommitMessageSource({ ...project, files: ['a.txt'] }),
  getRemoteStatus: (service) => service.getRemoteStatus(project),
  getRemotes: (service) => service.getRemotes(project),
  fetch: (service) => service.fetch(project),
  pull: (service) => service.pull(project),
  push: (service) => service.push(project),
  discard: (service) => service.discard(file),
  deleteUntracked: (service) => service.deleteUntracked(file),
  getWorkbenchSnapshot: (service) => service.getWorkbenchSnapshot({ ...project, mode: 'working', context: 3 }),
  getWorkingTreeFingerprint: (service) => service.getWorkingTreeFingerprint(project),
  getQuickSummary: (service) => service.getQuickSummary(project),
  getReviewDocumentFileBodies: (service) => service.getReviewDocumentFileBodies({ ...project, documentId: 'synthetic', files: ['a.txt'], purpose: 'visible' }),
  getHistoryCommits: (service) => service.getHistoryCommits(project),
  getCommitSnapshot: (service) => service.getCommitSnapshot({ ...project, commit: 'HEAD' }),
  getComparisonSnapshot: (service) => service.getComparisonSnapshot({ ...project, from: { kind: 'revision', revision: 'HEAD' }, to: { kind: 'working-tree' }, mode: 'direct' }),
  getComparisonFreshness: (service) => service.getComparisonFreshness({ ...project, from: { kind: 'revision', revision: 'HEAD', hash: 'a'.repeat(40) }, to: { kind: 'working-tree', fingerprint: 'synthetic' } }),
  stageSelection: (service) => service.stageSelection({ ...file, mode: 'stage', selection: { lineIndices: [1] } }),
  stageHunk: (service) => service.stageHunk({ ...file, mode: 'stage', hunkIndex: 0 }),
  getConflicts: (service) => service.getConflicts(project),
  getConflictDetails: (service) => service.getConflictDetails(file),
  acceptConflictSide: (service) => service.acceptConflictSide({ ...file, side: 'ours' }),
  markConflictResolved: (service) => service.markConflictResolved(file),
  getStashes: (service) => service.getStashes(project),
  createStash: (service) => service.createStash(project),
  applyStash: (service) => service.applyStash({ ...project, stashRef: 'stash@{0}' }),
  popStash: (service) => service.popStash({ ...project, stashRef: 'stash@{0}' }),
  dropStash: (service) => service.dropStash({ ...project, stashRef: 'stash@{0}' }),
  getFileHistory: (service) => service.getFileHistory(file),
  getBlame: (service) => service.getBlame(file),
  getGraph: (service) => service.getGraph(project),
  getRepoInfo: (service) => service.getRepoInfo(project),
  getWorktrees: (service) => service.getWorktrees(project),
  getTargetCandidates: (service) => service.getTargetCandidates(project),
  createWorktree: (service) => service.createWorktree({ ...project, worktreePath: '/not-authorized/worktree', detach: true }),
  removeWorktree: (service) => service.removeWorktree({ ...project, worktreePath: '/not-authorized/worktree' }),
  commitIndex: (service) => service.commitIndex({ ...project, message: 'synthetic' }),
  stagePaths: (service) => service.stagePaths({ ...project, paths: ['a.txt'], mode: 'stage' }),
  revertCommit: (service) => service.revertCommit({ ...project, commit: 'HEAD' }),
};

test('covers every owner operation in the authorization inventory', () => {
  const service = createLocalWorkspaceGitService({
    assertProjectPathAllowed: async () => { throw new Error('Unexpected filesystem operation'); },
    networkTimeoutMs: 30_000,
  });
  expect(Object.keys(boundaryOperations).sort()).toEqual(Object.keys(service).sort());
});

test.each(Object.entries(boundaryOperations))('authorizes %s before any repository access', async (_name, operation) => {
  const refusal = new Error('synthetic authorization refusal');
  const authorize = mock(async () => { throw refusal; });
  const service = createLocalWorkspaceGitService({ assertProjectPathAllowed: authorize, networkTimeoutMs: 30_000 });
  await expect(operation(service)).rejects.toBe(refusal);
  expect(authorize).toHaveBeenCalledTimes(1);
  expect(authorize).toHaveBeenCalledWith(project.projectPath);
});
