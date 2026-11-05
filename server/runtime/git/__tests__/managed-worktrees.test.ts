import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { validateGitRequest } from '../../../../common/git-request-validation.js';
import { validateGitResult } from '../../../../common/git-result-validation.js';
import * as jsonFiles from '../../../common/json-file-store.js';
import { KeyedPromiseLock } from '../../../common/keyed-lock.js';
import { runtimeAdapter, RUNTIME_BACKENDS, type RuntimeBackend } from '../../../remote/__tests__/runtime-adapter.js';
import { rpcContinuity } from '../../../remote/transport/rpc-protocol.js';
import { rpcLane } from '../../../remote/transport/rpc-routing.js';
import { ExecutionRuntime } from '../../execution-runtime.js';
import { runGit } from '../run.js';
import { gitOperationSignal } from '../operation-context.js';
import { createManagedWorktreeOperations } from '../managed-worktrees.js';
import * as gitProcess from '../run.js';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture(backend: RuntimeBackend, refFormat: 'files' | 'reftable' = 'files') {
  const temporary = join(homedir(), 'tmp');
  await mkdir(temporary, { recursive: true });
  const root = await mkdtemp(join(temporary, 'managed-worktree-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const projectPath = join(root, 'repo');
  await mkdir(projectPath);
  await runGit(projectPath, ['init', '-b', 'main', `--ref-format=${refFormat}`]);
  await runGit(projectPath, ['config', 'user.name', 'Synthetic Author']);
  await runGit(projectPath, ['config', 'user.email', 'synthetic@example.invalid']);
  await writeFile(join(projectPath, 'source.txt'), 'Synthetic source\n');
  await runGit(projectPath, ['add', '.']);
  await runGit(projectPath, ['commit', '-m', 'Synthetic base']);
  const baseCommit = (await runGit(projectPath, ['rev-parse', 'HEAD'])).stdout.trim();
  const runtime = new ExecutionRuntime({ id: 'local', instanceId: 'managed-runtime', workspaceDir: root,
    projectBasePath: root, integrations: [], resolveCredential: async () => null });
  cleanups.push(() => runtime.dispose());
  const adapter = await runtimeAdapter(runtime, backend);
  cleanups.push(() => adapter.dispose());
  const git = await adapter.executor.getGitService();
  const input = { projectPath, worktreePath: join(root, 'managed'), operationId: crypto.randomUUID(),
    managedResourceId: crypto.randomUUID(), branch: 'managed/synthetic', baseCommit };
  const inspect = { projectPath, worktreePath: input.worktreePath, operationId: input.operationId, managedResourceId: input.managedResourceId };
  return { root, git, input, inspect, marker: join(projectPath, '.git', 'garcon-managed-worktrees', `${input.managedResourceId}.json`),
    async reopen() {
      await adapter.dispose(); await runtime.dispose();
      const restarted = new ExecutionRuntime({ id: 'local', instanceId: 'managed-restarted', workspaceDir: root,
        projectBasePath: root, integrations: [], resolveCredential: async () => null });
      cleanups.push(() => restarted.dispose());
      const next = await runtimeAdapter(restarted, backend); cleanups.push(() => next.dispose());
      return next.executor.getGitService();
    },
  };
}

for (const backend of RUNTIME_BACKENDS) describe(`managed worktrees (${backend})`, () => {
  test('creates a clean exact-base resource and observes its durable identity', async () => {
    const f = await fixture(backend);
    expect(await f.git.inspectManagedWorktree(f.inspect)).toMatchObject({ managed: null });
    const created = await f.git.createManagedWorktree(f.input);
    expect(created).toMatchObject({ executorId: 'local', instanceId: 'managed-runtime', success: true, managed: {
      operationId: f.input.operationId, managedResourceId: f.input.managedResourceId,
      worktreePath: f.input.worktreePath, baseCommit: f.input.baseCommit, head: f.input.baseCommit, dirty: false,
    } });
    expect((await f.git.inspectManagedWorktree(f.inspect)).managed).toEqual(created.managed);
    expect(JSON.parse(await readFile(f.marker, 'utf8'))).toMatchObject({ worktreeIdentity: created.managed.worktreeIdentity });
    await writeFile(join(f.input.worktreePath, 'untracked.txt'), 'Synthetic untracked output');
    expect((await f.git.inspectManagedWorktree(f.inspect)).managed).toMatchObject({ head: f.input.baseCommit, dirty: true });
    await f.git.commit({ projectPath: f.input.worktreePath, files: ['untracked.txt'], message: 'Synthetic output' });
    const changed = (await f.git.inspectManagedWorktree(f.inspect)).managed!;
    expect(changed.worktreeIdentity).toBe(created.managed.worktreeIdentity);
    expect(changed.head).not.toBe(f.input.baseCommit);
    expect(changed.dirty).toBe(false);
  });

  test('never reuses an existing branch, destination, or creation marker', async () => {
    const f = await fixture(backend);
    await f.git.createBranch({ projectPath: f.input.projectPath, branch: f.input.branch, baseRef: f.input.baseCommit });
    await f.git.checkout({ projectPath: f.input.projectPath, ref: 'main' });
    await runGit(f.input.projectPath, ['commit', '--allow-empty', '-m', 'Synthetic later base']);
    const next = (await runGit(f.input.projectPath, ['rev-parse', 'HEAD'])).stdout.trim();
    await expect(f.git.createManagedWorktree({ ...f.input, baseCommit: next })).rejects.toMatchObject({ code: 'GIT_INVALID_INPUT' });
    expect((await runGit(f.input.projectPath, ['rev-parse', f.input.branch])).stdout.trim()).toBe(f.input.baseCommit);
    await mkdir(f.input.worktreePath);
    await writeFile(join(f.input.worktreePath, 'retained.txt'), 'Synthetic retained file');
    await expect(f.git.createManagedWorktree({ ...f.input, branch: 'managed/other' })).rejects.toMatchObject({ code: 'GIT_INVALID_INPUT' });
    expect(await readFile(join(f.input.worktreePath, 'retained.txt'), 'utf8')).toBe('Synthetic retained file');
    const created = await f.git.createManagedWorktree({ ...f.input, worktreePath: join(f.root, 'other'), branch: 'managed/other' });
    await expect(f.git.createManagedWorktree({ ...f.input, worktreePath: join(f.root, 'third'), branch: 'managed/third' }))
      .rejects.toMatchObject({ code: 'GIT_INVALID_INPUT' });
    expect(created.managed.head).toBe(f.input.baseCommit);
  });

  test.each(['ancestor', 'descendant', 'registered'] as const)('rejects %s collisions before reserving ownership', async collision => {
    const f = await fixture(backend);
    if (collision === 'registered') {
      await f.git.createWorktree({ projectPath: f.input.projectPath, worktreePath: f.input.worktreePath, branch: 'other' });
      await rm(f.input.worktreePath, { recursive: true });
    } else {
      await runGit(f.input.projectPath, ['branch', collision === 'ancestor' ? 'managed' : `${f.input.branch}/child`]);
    }
    await expect(f.git.createManagedWorktree(f.input)).rejects.toMatchObject({ code: 'GIT_INVALID_INPUT' });
    await expect(readFile(f.marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('requires literal branch names and commit objects before reserving ownership', async () => {
    const f = await fixture(backend);
    await runGit(f.input.projectPath, ['checkout', '-b', 'previous']);
    await runGit(f.input.projectPath, ['checkout', 'main']);
    await runGit(f.input.projectPath, ['branch', '-d', 'previous']);
    const tree = (await runGit(f.input.projectPath, ['rev-parse', 'HEAD^{tree}'])).stdout.trim();
    const blob = (await runGit(f.input.projectPath, ['rev-parse', 'HEAD:source.txt'])).stdout.trim();
    for (const patch of [{ branch: '@{-1}' }, { branch: 'managed/a=b' }, { baseCommit: tree }, { baseCommit: blob }]) {
      await expect(f.git.createManagedWorktree({ ...f.input, ...patch })).rejects.toMatchObject({ code: 'GIT_INVALID_INPUT' });
      await expect(readFile(f.marker)).rejects.toMatchObject({ code: 'ENOENT' });
    }
    expect((await runGit(f.input.projectPath, ['for-each-ref', '--format=%(refname)', 'refs/heads/previous'])).stdout).toBe('');
  });

  for (const refFormat of ['files', 'reftable'] as const) test.each(['exact', 'ancestor', 'descendant'] as const)(
    `rejects dangling %s symrefs before reservation (${refFormat})`, async collision => {
    const f = await fixture(backend, refFormat);
    const requested = collision === 'ancestor' ? 'refs/heads/managed'
      : `refs/heads/${f.input.branch}${collision === 'descendant' ? '/child' : ''}`;
    const unapproved = 'refs/heads/unapproved';
    await runGit(f.input.projectPath, ['symbolic-ref', requested, unapproved]);
    expect((await runGit(f.input.projectPath, ['for-each-ref', '--format=%(refname)', requested])).stdout).toBe('');
    await expect(f.git.createManagedWorktree(f.input)).rejects.toMatchObject({ code: 'GIT_INVALID_INPUT' });
    await expect(lstat(join(f.input.projectPath, '.git', 'garcon-managed-worktrees'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(f.input.worktreePath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(runGit(f.input.projectPath, ['rev-parse', '--verify', unapproved])).rejects.toThrow();
    expect((await runGit(f.input.projectPath, ['symbolic-ref', requested])).stdout.trim()).toBe(unapproved);
    expect((await runGit(f.input.projectPath, ['for-each-ref', '--format=%(refname)'])).stdout.trim()).toBe('refs/heads/main');
    expect((await readdir(join(f.input.projectPath, '.git'), { recursive: true })).filter(path => path.endsWith('.lock'))).toEqual([]);
  });

  test('creates a resource after an abort-only branch probe in reftable storage', async () => {
    const f = await fixture(backend, 'reftable');
    const { managed } = await f.git.createManagedWorktree(f.input);
    expect(managed).toMatchObject({ head: f.input.baseCommit, branch: f.input.branch, dirty: false });
    expect((await f.git.inspectManagedWorktree(f.inspect)).managed).toEqual(managed);
    expect((await readdir(join(f.input.projectPath, '.git'), { recursive: true })).filter(path => path.endsWith('.lock'))).toEqual([]);
  });

  test.each(['files', 'reftable'] as const)('rejects branches selected by unborn worktree HEADs (%s)', async refFormat => {
    const f = await fixture(backend, refFormat);
    const other = join(f.root, 'other');
    const ref = `refs/heads/${f.input.branch}`;
    await runGit(f.input.projectPath, ['worktree', 'add', '--detach', other, f.input.baseCommit]);
    await runGit(other, ['symbolic-ref', 'HEAD', ref]);
    expect((await runGit(f.input.projectPath, ['worktree', 'list', '--porcelain', '-z'])).stdout).toContain(`branch ${ref}\0`);
    await expect(runGit(other, ['rev-parse', '--verify', 'HEAD'])).rejects.toThrow();
    await expect(f.git.createManagedWorktree(f.input)).rejects.toMatchObject({ code: 'GIT_INVALID_INPUT' });
    await expect(lstat(join(f.input.projectPath, '.git', 'garcon-managed-worktrees'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(f.input.worktreePath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(runGit(f.input.projectPath, ['rev-parse', '--verify', ref])).rejects.toThrow();
    await expect(runGit(other, ['rev-parse', '--verify', 'HEAD'])).rejects.toThrow();
    expect((await runGit(other, ['symbolic-ref', 'HEAD'])).stdout.trim()).toBe(ref);
  });

  test('a tag with the branch name cannot change managed branch identity', async () => {
    const f = await fixture(backend);
    await runGit(f.input.projectPath, ['tag', f.input.branch]);
    const created = await f.git.createManagedWorktree(f.input);
    expect(created.managed.branch).toBe(f.input.branch);
    expect((await f.git.inspectManagedWorktree(f.inspect)).managed).toEqual(created.managed);
  });

  test('rejects HEAD redirected outside the heads namespace', async () => {
    const f = await fixture(backend);
    const branch = 'refs/tags/synthetic';
    await f.git.createManagedWorktree({ ...f.input, branch });
    await runGit(f.input.projectPath, ['update-ref', branch, f.input.baseCommit]);
    await runGit(f.input.worktreePath, ['symbolic-ref', 'HEAD', branch]);
    await expect(f.git.inspectManagedWorktree(f.inspect)).rejects.toMatchObject({ code: 'GIT_INVALID_INPUT' });
  });

  test('submodule ignore configuration cannot hide dirty or changed submodule checkouts', async () => {
    const f = await fixture(backend);
    const module = join(f.root, 'module'); await mkdir(module);
    await runGit(module, ['init', '-b', 'main']);
    await runGit(module, ['config', 'user.name', 'Synthetic Author']);
    await runGit(module, ['config', 'user.email', 'synthetic@example.invalid']);
    await writeFile(join(module, 'file.txt'), 'Synthetic module\n');
    await runGit(module, ['add', '.']); await runGit(module, ['commit', '-m', 'Synthetic module']);
    await runGit(f.input.projectPath, ['-c', 'protocol.file.allow=always', 'submodule', 'add', module, 'module']);
    await runGit(f.input.projectPath, ['commit', '-am', 'Synthetic gitlink']);
    const baseCommit = (await runGit(f.input.projectPath, ['rev-parse', 'HEAD'])).stdout.trim();
    const { managed } = await f.git.createManagedWorktree({ ...f.input, baseCommit });
    await runGit(f.input.worktreePath, ['-c', 'protocol.file.allow=always', 'submodule', 'update', '--init']);
    await runGit(f.input.projectPath, ['config', 'submodule.module.ignore', 'all']);
    const child = join(f.input.worktreePath, 'module');
    await writeFile(join(child, 'file.txt'), 'Synthetic changed module\n');
    expect((await f.git.inspectManagedWorktree(f.inspect)).managed).toMatchObject({ dirty: true });
    await expect(f.git.integrateCommits({ ...f.inspect, expectedHead: baseCommit, expectedBranch: managed.branch,
      expectedRepositoryIdentity: managed.repositoryIdentity, expectedWorktreeIdentity: managed.worktreeIdentity,
      commits: [baseCommit], strategy: 'ordered-merge' })).rejects.toMatchObject({ code: 'GIT_INVALID_INPUT' });
    await runGit(child, ['-c', 'user.name=Synthetic Author', '-c', 'user.email=synthetic@example.invalid', 'commit', '-am', 'Synthetic new gitlink']);
    expect((await f.git.inspectManagedWorktree(f.inspect)).managed).toMatchObject({ dirty: true });
  });

  test('bounded status overflow is dirty rather than lost ownership', async () => {
    const f = await fixture(backend); await f.git.createManagedWorktree(f.input);
    const run = gitProcess.runGit;
    const runner = spyOn(gitProcess, 'runGit').mockImplementation(async (cwd, args, options) => {
      if (args[0] === 'status') {
        expect(options?.maxStdoutBytes).toBe(64 * 1024);
        throw new gitProcess.GitOutputLimitError('stdout', 64 * 1024);
      }
      return run(cwd, args, options);
    });
    try { expect((await f.git.inspectManagedWorktree(f.inspect)).managed).toMatchObject({ dirty: true }); }
    finally { runner.mockRestore(); }
  });

  test('does not follow a symlinked ownership marker', async () => {
    const f = await fixture(backend); await f.git.createManagedWorktree(f.input);
    const other = join(f.root, 'marker.json'); await writeFile(other, await readFile(f.marker));
    await rm(f.marker); await symlink(other, f.marker);
    await expect(f.git.inspectManagedWorktree(f.inspect)).rejects.toThrow();
    await expect(f.git.createManagedWorktree({ ...f.input, worktreePath: join(f.root, 'other'), branch: 'other' }))
      .rejects.toMatchObject({ code: 'GIT_INVALID_INPUT' });
  });

  test('rejects operation substitution and replacement at the same path, branch, and head', async () => {
    const f = await fixture(backend);
    await f.git.createManagedWorktree(f.input);
    await expect(f.git.inspectManagedWorktree({ ...f.inspect, operationId: crypto.randomUUID() })).rejects.toMatchObject({ code: 'GIT_INVALID_INPUT' });
    await expect(f.git.inspectManagedWorktree({ ...f.inspect, worktreePath: f.input.projectPath })).rejects.toMatchObject({ code: 'GIT_INVALID_INPUT' });
    await f.git.removeWorktree({ projectPath: f.input.projectPath, worktreePath: f.input.worktreePath });
    await f.git.createWorktree({ projectPath: f.input.projectPath, worktreePath: f.input.worktreePath, branch: f.input.branch });
    await expect(f.git.inspectManagedWorktree(f.inspect)).rejects.toMatchObject({ code: 'GIT_INVALID_INPUT' });
    expect((await runGit(f.input.worktreePath, ['rev-parse', 'HEAD'])).stdout.trim()).toBe(f.input.baseCommit);
  });

  test.each(['before', 'after'] as const)('retains uncertainty and ownership after %s confirmation persistence fails', async timing => {
    const f = await fixture(backend);
    const write = jsonFiles.writeJsonFileAtomic;
    const writing = spyOn(jsonFiles, 'writeJsonFileAtomic').mockImplementation(async (path, value, options) => {
      const confirmation = path === f.marker && Boolean((value as { worktreeIdentity?: string }).worktreeIdentity);
      if (confirmation && timing === 'before') throw new Error('Synthetic confirmation failure');
      await write(path, value, options);
      if (confirmation) throw new jsonFiles.AtomicJsonWriteError('Synthetic unconfirmed persistence', true);
    });
    try { await expect(f.git.createManagedWorktree(f.input)).rejects.toMatchObject({ code: 'GIT_MUTATION_OUTCOME_UNKNOWN' }); }
    finally { writing.mockRestore(); }
    expect((await runGit(f.input.worktreePath, ['rev-parse', 'HEAD'])).stdout.trim()).toBe(f.input.baseCommit);
    if (timing === 'after') expect((await f.git.inspectManagedWorktree(f.inspect)).managed).toMatchObject({ head: f.input.baseCommit });
    else await expect(f.git.inspectManagedWorktree(f.inspect)).rejects.toMatchObject({ code: 'GIT_MUTATION_OUTCOME_UNKNOWN' });
    await expect(f.git.createManagedWorktree(f.input)).rejects.toMatchObject({ code: 'GIT_INVALID_INPUT' });
  });

  test('enforces executor boundaries and rejects malformed or oversized markers', async () => {
    const f = await fixture(backend);
    await expect(f.git.createManagedWorktree({ ...f.input, worktreePath: join(f.root, '..', 'outside-managed') }))
      .rejects.toMatchObject({ code: 'GIT_OUTSIDE_BASE' });
    await f.git.createManagedWorktree(f.input);
    const marker = JSON.parse(await readFile(f.marker, 'utf8'));
    for (const patch of [{ head: 'a'.repeat(40) }, { dirty: false }, { unexpected: true }]) {
      await writeFile(f.marker, JSON.stringify({ ...marker, ...patch }));
      await expect(f.git.inspectManagedWorktree(f.inspect)).rejects.toMatchObject({ code: 'GIT_INVALID_INPUT' });
    }
    await writeFile(f.marker, '{');
    await expect(f.git.inspectManagedWorktree(f.inspect)).rejects.toMatchObject({ code: 'GIT_INVALID_INPUT' });
    await writeFile(f.marker, JSON.stringify({ version: 1 }));
    await expect(f.git.inspectManagedWorktree(f.inspect)).rejects.toMatchObject({ code: 'GIT_INVALID_INPUT' });
    await writeFile(f.marker, 'x'.repeat(64 * 1024 + 1));
    await expect(f.git.inspectManagedWorktree(f.inspect)).rejects.toMatchObject({ code: 'GIT_INVALID_INPUT' });
  });

  test('confirmed ownership survives a new runtime instance without replaying creation', async () => {
    const f = await fixture(backend);
    const created = await f.git.createManagedWorktree(f.input);
    const restarted = await f.reopen();
    const inspected = await restarted.inspectManagedWorktree(f.inspect);
    expect(inspected.instanceId).toBe('managed-restarted');
    expect(inspected.managed).toEqual(created.managed);
    await expect(restarted.createManagedWorktree(f.input)).rejects.toMatchObject({ code: 'GIT_INVALID_INPUT' });
  });

  test('cancellation during marker persistence retains the reservation without creating a worktree', async () => {
    const f = await fixture(backend); const abort = new AbortController();
    const entered = Promise.withResolvers<void>(); const finish = Promise.withResolvers<void>();
    const canceled = Promise.withResolvers<void>();
    const sync = jsonFiles.syncDirectory; let held = false;
    const writing = spyOn(jsonFiles, 'syncDirectory').mockImplementation(async path => {
      await sync(path);
      if (path === join(f.input.projectPath, '.git', 'garcon-managed-worktrees') && !held) {
        held = true;
        const signal = gitOperationSignal()!;
        if (signal.aborted) canceled.resolve();
        else signal.addEventListener('abort', () => canceled.resolve(), { once: true });
        entered.resolve(); await finish.promise;
      }
    });
    const result = f.git.createManagedWorktree(f.input, { signal: abort.signal }).then(() => null, error => error);
    try {
      await entered.promise; abort.abort(); await canceled.promise; finish.resolve();
      expect(await result).not.toBeNull();
      await expect(f.git.inspectManagedWorktree(f.inspect)).rejects.toMatchObject({ code: 'GIT_MUTATION_OUTCOME_UNKNOWN' });
      expect((await runGit(f.input.projectPath, ['for-each-ref', '--format=%(refname)', `refs/heads/${f.input.branch}`])).stdout).toBe('');
      expect(JSON.parse(await readFile(f.marker, 'utf8')).worktreeIdentity).toBeNull();
      for (const patch of [{}, { branch: 'managed/other' }, { worktreePath: join(f.root, 'other') }]) {
        const request = { ...f.input, ...patch, operationId: crypto.randomUUID(), managedResourceId: crypto.randomUUID() };
        await expect(f.git.createManagedWorktree(request))
          .rejects.toMatchObject({ code: 'GIT_INVALID_INPUT' });
        expect(await f.git.inspectManagedWorktree({ projectPath: request.projectPath, worktreePath: request.worktreePath,
          operationId: request.operationId, managedResourceId: request.managedResourceId })).toMatchObject({ managed: null });
      }
      expect(await f.git.createManagedWorktree({ ...f.input, branch: 'managed/other', worktreePath: join(f.root, 'other'),
        operationId: crypto.randomUUID(), managedResourceId: crypto.randomUUID() })).toMatchObject({ success: true });
    } finally { finish.resolve(); await result; writing.mockRestore(); }
  }, 15_000);

  test.each(['inspection', 'ordinary-mutation'] as const)('%s waits for managed creation under the shared repository lock', async operation => {
    const f = await fixture(backend);
    const entered = Promise.withResolvers<void>(); const finish = Promise.withResolvers<void>();
    const queued = Promise.withResolvers<void>(); let waiting = false; let completed = false;
    const key = await realpath(join(f.input.projectPath, '.git'));
    const lock = KeyedPromiseLock.prototype.runExclusive;
    const locks = spyOn(KeyedPromiseLock.prototype, 'runExclusive').mockImplementation(function (id, work, signal) {
      const result = lock.call(this, id, work, signal);
      if (id === key && waiting) queued.resolve();
      return result;
    });
    const write = jsonFiles.writeJsonFileAtomic;
    const writing = spyOn(jsonFiles, 'writeJsonFileAtomic').mockImplementation(async (path, value, options) => {
      await write(path, value, options);
      if (path === f.marker && (value as { worktreeIdentity?: string }).worktreeIdentity) { entered.resolve(); await finish.promise; }
    });
    const creating = f.git.createManagedWorktree(f.input);
    try {
      await entered.promise; waiting = true;
      const second = (operation === 'inspection' ? f.git.inspectManagedWorktree(f.inspect)
        : f.git.createBranch({ projectPath: f.input.worktreePath, branch: 'managed/ordinary', baseRef: f.input.baseCommit }))
        .finally(() => { completed = true; });
      await queued.promise; expect(completed).toBe(false);
      finish.resolve(); await creating; await second;
      expect(completed).toBe(true);
    } finally { finish.resolve(); await creating; writing.mockRestore(); locks.mockRestore(); }
  });
});

test('exclusive reservations prevent overlapping creations without the in-process repository lock', async () => {
  const f = await fixture('local');
  const operations = createManagedWorktreeOperations();
  const outcomes = await Promise.allSettled([
    operations.createManagedWorktree(f.input),
    operations.createManagedWorktree({ ...f.input, operationId: crypto.randomUUID(), managedResourceId: crypto.randomUUID() }),
  ]);
  expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1);
  expect(outcomes.filter(outcome => outcome.status === 'rejected')).toHaveLength(1);
  expect(outcomes.find(outcome => outcome.status === 'rejected')).toMatchObject({ reason: { code: 'GIT_INVALID_INPUT' } });
});

test('managed Git contracts require exact identities and use journaled bulk RPCs', () => {
  const request = { projectPath: '/synthetic/repo', worktreePath: '/synthetic/managed', operationId: crypto.randomUUID(),
    managedResourceId: crypto.randomUUID(), branch: 'managed/synthetic', baseCommit: 'a'.repeat(40) };
  expect(() => validateGitRequest('createManagedWorktree', request)).not.toThrow();
  for (const patch of [{ operationId: '../escape' }, { managedResourceId: 'not-a-marker' }, { baseCommit: 'HEAD' },
    { baseCommit: 'a'.repeat(41) }, { force: true }, { detach: true }]) {
    expect(() => validateGitRequest('createManagedWorktree', { ...request, ...patch })).toThrow();
  }
  const scope = { executorId: 'synthetic', instanceId: 'runtime-one' };
  const managed = { operationId: request.operationId, managedResourceId: request.managedResourceId,
    worktreePath: request.worktreePath, repositoryIdentity: 'repo-identity', worktreeIdentity: 'worktree-identity',
    branch: request.branch, baseCommit: request.baseCommit, head: request.baseCommit, dirty: false };
  expect(() => validateGitResult('createManagedWorktree', { ...scope, success: true, managed }, scope)).not.toThrow();
  for (const patch of [{ head: 'HEAD' }, { worktreeIdentity: null }, { dirty: undefined }, { unexpected: true }]) {
    expect(() => validateGitResult('createManagedWorktree', { ...scope, success: true, managed: { ...managed, ...patch } }, scope)).toThrow();
  }
  for (const method of ['git.createManagedWorktree', 'git.inspectManagedWorktree'] as const) {
    expect(rpcContinuity(method)).toBe('journaled');
    expect(rpcLane(method, { input: request, budgetMs: 1000 })).toBe('bulk');
  }
});
