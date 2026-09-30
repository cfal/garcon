import { afterEach, describe, expect, test, spyOn } from 'bun:test';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GitRuntime } from '../runtime.js';
import { runGit } from '../run.js';
import { GitReviewDocumentRegistry } from '../review-document-registry.js';
import { validateGitRequest } from '../../../../common/git-request-validation.js';
import { withRepositoryMutation } from '../repository-coordination.js';
import { withGitOperation, trackGitProcess } from '../operation-context.js';
import { KeyedPromiseLock } from '../../../common/keyed-lock.js';
import { GIT_MAX_CONCURRENT_QUERIES } from '../../../../common/git-execution.js';
import { ExecutionRuntime } from '../../execution-runtime.js';
import { runtimeAdapter, RUNTIME_BACKENDS } from '../../../remote/__tests__/runtime-adapter.js';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const dispose of cleanups.splice(0).reverse()) await dispose(); });

for (const backend of RUNTIME_BACKENDS) describe(`Git runtime contract (${backend})`, () => {
async function fixture(registry?: GitReviewDocumentRegistry) {
  const temporary = path.join(os.homedir(), 'tmp');
  await fs.mkdir(temporary, { recursive: true });
  const root = await fs.mkdtemp(path.join(temporary, 'git-executor-'));
  cleanups.push(() => fs.rm(root, { force: true, recursive: true }));
  const projectPath = path.join(root, 'repo');
  await fs.mkdir(projectPath);
  await runGit(projectPath, ['init', '-b', 'main']);
  await runGit(projectPath, ['config', 'user.email', 'test@example.invalid']);
  await runGit(projectPath, ['config', 'user.name', 'Synthetic Author']);
  const original = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n') + '\n';
  await fs.writeFile(path.join(projectPath, 'example.txt'), original);
  await runGit(projectPath, ['add', '.']);
  await runGit(projectPath, ['commit', '-m', 'initial']);
  const configuration = { executorId: 'local', instanceId: 'serving-one', projectBasePath: root, assertAvailable() {}, reviewRegistry: registry };
  const runtime = new GitRuntime(configuration);
  cleanups.push(async () => runtime.dispose());
  const execution = new ExecutionRuntime({ id: configuration.executorId, instanceId: configuration.instanceId,
    workspaceDir: root, projectBasePath: root, integrations: [], resolveCredential: async () => null });
  spyOn(execution, 'getGitService').mockResolvedValue(runtime.git);
  cleanups.push(() => execution.dispose());
  const adapter = await runtimeAdapter(execution, backend);
  cleanups.push(() => adapter.dispose());
  return { root, projectPath, runtime, git: await adapter.executor.getGitService(), original, configuration };
}

async function selection(git: GitRuntime['git'], projectPath: string, file = 'example.txt') {
  const snapshot = await git.getWorkbenchSnapshot({ projectPath, mode: 'working', context: 2 });
  if (snapshot.status !== 'ready') throw new Error('Expected repository');
  const document = { executorId: snapshot.executorId, instanceId: snapshot.instanceId, documentId: snapshot.reviewSummary.documentId };
  const loaded = await git.getReviewDocumentFileBodies({ projectPath, document, files: [file], purpose: 'visible' });
  if (loaded.status !== 'ready' || !loaded.files[file].patchDigest) throw new Error('Expected patch');
  return { projectPath, document, file, mode: 'stage' as const, contextLines: 2,
    bodyFingerprint: loaded.files[file].bodyFingerprint, patchDigest: loaded.files[file].patchDigest!, hunkIndex: 0 };
}

test('machine service scopes operations and rejects untrusted fields before execution', async () => {
  const { git, projectPath } = await fixture();
  expect(await git.getStatus({ projectPath })).toMatchObject({ executorId: 'local', instanceId: 'serving-one', branch: 'main' });
  expect(() => validateGitRequest('checkout', { projectPath, ref: 'main', env: { GIT_DIR: '/wrong' } })).toThrow('Invalid Git');
  expect(() => validateGitRequest('stageSelection', { projectPath, file: 'x', mode: 'stage', selection: { lineIndices: [0] } })).toThrow('Invalid Git');
  const folder = path.join(projectPath, 'plain');
  await fs.mkdir(folder);
  const other = path.join(path.dirname(projectPath), 'not-repo');
  await fs.mkdir(other);
  expect(await git.getWorkbenchSnapshot({ projectPath: other, mode: 'working', context: 5 })).toMatchObject({ status: 'not-git-repository' });
});

test('admits normal query bursts while bounding active reads across serving instances', async () => {
  const { git, projectPath, configuration } = await fixture();
  const replacement = new GitRuntime({ ...configuration, instanceId: 'other-instance' });
  cleanups.push(async () => replacement.dispose());
  const stats = await fs.stat(projectPath);
  const gate = Promise.withResolvers<typeof stats>();
  const entered = Promise.withResolvers<void>();
  let arrivals = 0;
  const stat = spyOn(fs, 'stat').mockImplementation(() => {
    if (++arrivals === GIT_MAX_CONCURRENT_QUERIES) entered.resolve();
    return gate.promise;
  });
  const pending = Array.from({ length: GIT_MAX_CONCURRENT_QUERIES }, () => git.getRepoInfo({ projectPath }));
  try {
    await entered.promise;
    expect(arrivals).toBe(8);
    await expect(git.getRepoInfo({ projectPath })).rejects.toMatchObject({ code: 'GIT_SERVICE_BUSY' });
    await expect(replacement.git.getRepoInfo({ projectPath })).rejects.toMatchObject({ code: 'GIT_SERVICE_BUSY' });
  } finally {
    stat.mockRestore();
    gate.resolve(stats);
    await Promise.all(pending);
  }
  expect(await replacement.git.getRepoInfo({ projectPath })).toMatchObject({ instanceId: 'other-instance' });
});

test('rejects an ancestor repository outside the executor base and escaping file symlinks', async () => {
  const { git, projectPath, configuration, root } = await fixture();
  const subdir = path.join(projectPath, 'allowed');
  await fs.mkdir(subdir);
  const restricted = new GitRuntime({ ...configuration, projectBasePath: subdir });
  cleanups.push(async () => restricted.dispose());
  await expect(restricted.git.getStatus({ projectPath: subdir })).rejects.toMatchObject({ code: 'GIT_OUTSIDE_BASE' });
  await fs.writeFile(path.join(root, 'outside.txt'), 'outside');
  await fs.symlink(path.join(root, 'outside.txt'), path.join(projectPath, 'link.txt'));
  await expect(git.getConflictDetails({ projectPath, file: 'link.txt' })).rejects.toMatchObject({ code: 'GIT_OUTSIDE_BASE' });
  await expect(git.stagePaths({ projectPath, paths: ['../outside.txt'], mode: 'stage' })).rejects.toMatchObject({ code: 'GIT_OUTSIDE_BASE' });
});

test('filters forbidden sibling worktrees and validates missing creation destinations', async () => {
  const { root, projectPath, git } = await fixture();
  await expect(git.createWorktree({ projectPath, worktreePath: '../../outside/missing', branch: 'other' })).rejects.toMatchObject({ code: 'GIT_OUTSIDE_BASE' });
  const created = await git.createWorktree({ projectPath, worktreePath: path.join(root, 'allowed'), branch: 'other' });
  expect(created.worktreePath).toBe(path.join(root, 'allowed'));
  const restricted = new GitRuntime({ executorId: 'local', instanceId: 'scope', projectBasePath: projectPath, assertAvailable() {} });
  cleanups.push(async () => restricted.dispose());
  const result = await restricted.git.getWorktrees({ projectPath });
  expect(result.worktrees.map(w => w.path)).toEqual([projectPath]);
});

test('partial staging binds to the displayed patch and rejects changed contents and instances', async () => {
  const { git, projectPath, original } = await fixture();
  await fs.writeFile(path.join(projectPath, 'example.txt'), original.replace('line 2\n', 'changed\n'));
  const proof = await selection(git, projectPath);
  await expect(git.stageHunk({ ...proof, document: { ...proof.document, instanceId: 'old' } })).rejects.toMatchObject({ code: 'GIT_STALE_DOCUMENT' });
  await fs.writeFile(path.join(projectPath, 'example.txt'), original.replace('line 2\n', 'different\n'));
  await expect(git.stageHunk(proof)).rejects.toMatchObject({ code: 'GIT_STALE_DOCUMENT' });
  await git.stageHunk(await selection(git, projectPath));
  expect((await runGit(projectPath, ['diff', '--cached'])).stdout).toContain('+different');
});

test('evicted patch digests survive Git configuration changes that merge hunk boundaries', async () => {
  const { git, projectPath, original } = await fixture(new GitReviewDocumentRegistry({ maxBodyBytes: 0 }));
  await fs.writeFile(path.join(projectPath, 'example.txt'), original.replace('line 2\n', 'first\n').replace('line 20\n', 'second\n'));
  const proof = await selection(git, projectPath);
  await runGit(projectPath, ['config', 'diff.interHunkContext', '40']);
  await expect(git.stageHunk(proof)).rejects.toMatchObject({ code: 'GIT_STALE_DOCUMENT' });
  expect((await runGit(projectPath, ['diff', '--cached'])).stdout).toBe('');
  const refreshed = await selection(git, projectPath);
  expect(refreshed.document.documentId).not.toBe(proof.document.documentId);
  expect(refreshed.patchDigest).not.toBe(proof.patchDigest);
  await git.stageHunk(refreshed);
  expect((await runGit(projectPath, ['diff', '--cached'])).stdout).toContain('+second');
});

test('untracked files retain partial staging and failed selection cleanup', async () => {
  const { git, projectPath } = await fixture();
  await fs.writeFile(path.join(projectPath, 'new.txt'), 'new content\n');
  const proof = await selection(git, projectPath, 'new.txt');
  await expect(git.stageHunk({ ...proof, hunkIndex: 10 })).rejects.toThrow();
  expect((await runGit(projectPath, ['ls-files', 'new.txt'])).stdout).toBe('');
  await git.stageHunk(proof);
  expect((await runGit(projectPath, ['show', ':new.txt'])).stdout).toBe('new content\n');
});

test('retired services and cancelled requests never execute mutations', async () => {
  const { runtime, git, projectPath } = await fixture();
  const controller = new AbortController(); controller.abort();
  await expect(git.createBranch({ projectPath, branch: 'cancelled' }, { signal: controller.signal })).rejects.toThrow();
  runtime.dispose();
  await expect(git.createBranch({ projectPath, branch: 'retired' })).rejects.toThrow();
  expect((await runGit(projectPath, ['branch', '--list'])).stdout.trim()).toBe('* main');
});

test('untracked selections preserve an absent final newline', async () => {
  const { git, projectPath } = await fixture();
  for (const method of ['stageHunk', 'stageSelection'] as const) {
    const file = `${method}.txt`;
    await fs.writeFile(path.join(projectPath, file), 'no newline');
    const { hunkIndex, ...proof } = await selection(git, projectPath, file);
    if (method === 'stageHunk') await git.stageHunk({ ...proof, hunkIndex });
    else await git.stageSelection({ ...proof, selection: { lineIndices: [0] } });
    expect((await runGit(projectPath, ['show', `:${file}`])).stdout).toBe('no newline');
  }
});

test('linked worktrees share locks until native work settles, including across serving instances', async () => {
  const { git, projectPath, root } = await fixture();
  const linked = path.join(root, 'linked');
  await git.createWorktree({ projectPath, worktreePath: linked, branch: 'linked' });
  const native = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const secondQueued = Promise.withResolvers<void>();
  const locks = KeyedPromiseLock.prototype.runExclusive;
  let waiting = false;
  let secondRan = false;
  const lockSpy = spyOn(KeyedPromiseLock.prototype, 'runExclusive').mockImplementation(function (key, operation, signal) {
    const result = locks.call(this, key, operation, signal);
    if (waiting) secondQueued.resolve();
    return result;
  });
  const first = withGitOperation(projectPath, undefined, () => withRepositoryMutation(projectPath, async () => {
    void trackGitProcess(() => native.promise);
    entered.resolve();
  }));
  try {
    await entered.promise;
    waiting = true;
    const second = withGitOperation(linked, undefined, () => withRepositoryMutation(linked, async () => { secondRan = true; }));
    await secondQueued.promise;
    expect(secondRan).toBe(false);
    native.resolve();
    await first;
    await second;
    expect(secondRan).toBe(true);
  } finally { native.resolve(); await first; lockSpy.mockRestore(); }
});

test('selected-file commits preserve unrelated staged and unstaged contents', async () => {
  const { git, projectPath } = await fixture();
  await fs.writeFile(path.join(projectPath, 'other.txt'), 'staged\n');
  await git.stagePaths({ projectPath, paths: ['other.txt'], mode: 'stage' });
  await fs.writeFile(path.join(projectPath, 'other.txt'), 'unstaged\n');
  await fs.writeFile(path.join(projectPath, 'example.txt'), 'selected\n');
  const committed = await git.commit({ projectPath, message: 'selected only', files: ['example.txt'] });
  expect(committed).toMatchObject({ commitScope: 'selected-files', indexSynchronized: true });
  expect((await runGit(projectPath, ['show', '--pretty=', '--name-only', 'HEAD'])).stdout.trim()).toBe('example.txt');
  expect((await runGit(projectPath, ['show', ':other.txt'])).stdout).toBe('staged\n');
  expect(await fs.readFile(path.join(projectPath, 'other.txt'), 'utf8')).toBe('unstaged\n');
  await git.commitIndex({ projectPath, message: 'staged remainder' });
  expect((await runGit(projectPath, ['show', 'HEAD:other.txt'])).stdout).toBe('staged\n');
});

test('stash listings expose unique numeric refs that remain valid mutation targets', async () => {
  const { git, projectPath } = await fixture();
  await fs.writeFile(path.join(projectPath, 'example.txt'), 'first stash\n');
  await git.createStash({ projectPath, message: 'first stash' });
  await fs.writeFile(path.join(projectPath, 'example.txt'), 'second stash\n');
  await git.createStash({ projectPath, message: 'second stash' });

  const { stashes } = await git.getStashes({ projectPath });
  expect(stashes.map(stash => stash.ref)).toEqual(['stash@{0}', 'stash@{1}']);
  expect(stashes.map(stash => stash.index)).toEqual([0, 1]);

  await git.dropStash({ projectPath, stashRef: stashes[1].ref });
  await git.dropStash({ projectPath, stashRef: stashes[0].ref });
  expect((await git.getStashes({ projectPath })).stashes).toEqual([]);
});

test('stash conflicts retain the stash until explicit resolution and removal', async () => {
  const { git, projectPath, original } = await fixture();
  await fs.writeFile(path.join(projectPath, 'example.txt'), 'stashed\n');
  await git.createStash({ projectPath, message: 'retained conflict' });
  await fs.writeFile(path.join(projectPath, 'example.txt'), 'committed\n');
  await git.commit({ projectPath, message: 'conflicting change', files: ['example.txt'] });
  for (const method of ['applyStash', 'popStash'] as const) {
    await expect(git[method]({ projectPath, stashRef: 'stash@{0}' })).rejects.toThrow();
    expect((await git.getStashes({ projectPath })).stashes).toHaveLength(1);
    expect((await git.getConflicts({ projectPath })).conflicts).toHaveLength(1);
    const details = await git.getConflictDetails({ projectPath, file: 'example.txt' });
    expect(details.ours.content).toBe('committed\n');
    expect(details.theirs.content).toBe('stashed\n');
    await git.acceptConflictSide({ projectPath, file: 'example.txt', side: 'ours' });
    await git.markConflictResolved({ projectPath, file: 'example.txt' });
    expect((await git.getConflicts({ projectPath })).conflicts).toEqual([]);
    expect(await fs.readFile(path.join(projectPath, 'example.txt'), 'utf8')).toBe('committed\n');
  }
  await git.dropStash({ projectPath, stashRef: 'stash@{0}' });
  expect((await git.getStashes({ projectPath })).stashes).toEqual([]);
  await git.revertCommit({ projectPath, commit: 'HEAD' });
  expect(await fs.readFile(path.join(projectPath, 'example.txt'), 'utf8')).toBe(original);
});

test('lists stashes by index so listed refs drive stash actions', async () => {
  const { git, projectPath } = await fixture();
  for (const message of ['first synthetic stash', 'second synthetic stash']) {
    await fs.writeFile(path.join(projectPath, 'example.txt'), `${message}\n`);
    await git.createStash({ projectPath, message });
  }
  const { stashes } = await git.getStashes({ projectPath });
  expect(stashes.map(({ index, ref, message }) => ({ index, ref, message }))).toEqual([
    { index: 0, ref: 'stash@{0}', message: expect.stringContaining('second synthetic stash') },
    { index: 1, ref: 'stash@{1}', message: expect.stringContaining('first synthetic stash') },
  ]);
  await git.dropStash({ projectPath, stashRef: stashes[1]!.ref });
  expect((await git.getStashes({ projectPath })).stashes.map((stash) => stash.message)).toEqual([
    expect.stringContaining('second synthetic stash'),
  ]);
});

test('fetch, pull and push use a disposable bare remote without external credentials', async () => {
  const { git, projectPath, root } = await fixture();
  const remote = path.join(root, 'origin.git');
  await runGit(root, ['init', '--bare', '-b', 'main', remote]);
  await runGit(projectPath, ['remote', 'add', 'origin', remote]);
  await runGit(projectPath, ['push', '--set-upstream', 'origin', 'main']);
  const peer = path.join(root, 'peer');
  await runGit(root, ['clone', remote, peer]);
  await runGit(peer, ['config', 'user.name', 'Synthetic Peer']);
  await runGit(peer, ['config', 'user.email', 'peer@example.invalid']);
  await fs.writeFile(path.join(peer, 'incoming.txt'), 'incoming\n');
  await runGit(peer, ['add', '.']);
  await runGit(peer, ['commit', '-m', 'incoming']);
  await runGit(peer, ['push']);
  await git.fetch({ projectPath });
  expect((await runGit(projectPath, ['rev-list', '--count', 'HEAD..origin/main'])).stdout.trim()).toBe('1');
  await git.pull({ projectPath });
  expect(await fs.readFile(path.join(projectPath, 'incoming.txt'), 'utf8')).toBe('incoming\n');
  await fs.writeFile(path.join(projectPath, 'outgoing.txt'), 'outgoing\n');
  await git.commit({ projectPath, message: 'outgoing', files: ['outgoing.txt'] });
  await git.push({ projectPath });
  expect((await runGit(remote, ['show', 'main:outgoing.txt'])).stdout).toBe('outgoing\n');
});
});
