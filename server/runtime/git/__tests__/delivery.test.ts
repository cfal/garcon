import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { validateGitRequest } from '../../../../common/git-request-validation.js';
import { validateGitResult } from '../../../../common/git-result-validation.js';
import { runtimeAdapter, RUNTIME_BACKENDS, type RuntimeBackend } from '../../../remote/__tests__/runtime-adapter.js';
import { rpcContinuity } from '../../../remote/transport/rpc-protocol.js';
import { rpcLane } from '../../../remote/transport/rpc-routing.js';
import { ExecutionRuntime } from '../../execution-runtime.js';
import * as gitProcess from '../run.js';
import { gitOperationSignal } from '../operation-context.js';
import { createDeliveryOperations } from '../delivery.js';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture(backend: RuntimeBackend, objectFormat: 'sha1' | 'sha256' = 'sha1') {
  const temporary = join(homedir(), 'tmp');
  await mkdir(temporary, { recursive: true });
  const root = await mkdtemp(join(temporary, 'git-delivery-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const run = async (cwd: string, args: string[]) => (await gitProcess.runGit(cwd, args)).stdout.trim();
  const source = join(root, 'source'); const destination = join(root, 'destination'); const remote = join(root, 'remote.git');
  for (const directory of [source, destination, remote]) await mkdir(directory);
  await run(remote, ['init', '--bare', '-b', 'main', `--object-format=${objectFormat}`]);
  for (const directory of [source, destination]) {
    await run(directory, ['init', '-b', 'main', `--object-format=${objectFormat}`]);
    await run(directory, ['config', 'user.name', 'Synthetic Author']);
    await run(directory, ['config', 'user.email', 'synthetic@example.invalid']);
    await writeFile(join(directory, 'source.txt'), 'Synthetic source\n');
    await run(directory, ['add', '.']);
    await run(directory, ['commit', '-m', 'Synthetic base']);
    await run(directory, ['remote', 'add', 'origin', remote]);
  }
  const base = await run(source, ['rev-parse', 'HEAD']);
  await writeFile(join(source, 'source.txt'), 'Synthetic output\n');
  await run(source, ['commit', '-am', 'Synthetic output']);
  const commit = await run(source, ['rev-parse', 'HEAD']);
  const runtime = new ExecutionRuntime({ id: 'local', instanceId: 'delivery-runtime', workspaceDir: root,
    projectBasePath: root, integrations: [], resolveCredential: async () => null });
  cleanups.push(() => runtime.dispose());
  const adapter = await runtimeAdapter(runtime, backend); cleanups.push(() => adapter.dispose());
  const git = await adapter.executor.getGitService();
  const input = { projectPath: source, remote: 'origin', expectedRemoteUrl: remote, ref: 'refs/heads/transfer/synthetic', commit };
  return { root, source, destination, remote, base, commit, git, input, run };
}

async function gitDaemon(root: string): Promise<string> {
  const reservation = Bun.serve({ hostname: '0.0.0.0', port: 0, fetch: () => new Response() });
  const port = reservation.port!; await reservation.stop(true);
  const daemon = Bun.spawn(['git', 'daemon', '--export-all', '--reuseaddr', '--listen=0.0.0.0',
    `--port=${port}`, `--base-path=${root}`, '--verbose'], { stdin: 'ignore', stdout: 'ignore', stderr: 'pipe' });
  const ready = Promise.withResolvers<void>();
  const drain = (async () => {
    let suffix = '';
    for await (const bytes of daemon.stderr) {
      suffix = (suffix + Buffer.from(bytes).toString()).slice(-1024);
      if (suffix.includes('Ready to rumble')) ready.resolve();
    }
  })();
  void daemon.exited.then(() => ready.reject(new Error('Synthetic Git daemon exited.')));
  cleanups.push(async () => { daemon.kill(); await daemon.exited; await drain; });
  const timeout = setTimeout(() => ready.reject(new Error('Synthetic Git daemon did not become ready.')), 5000);
  try { await ready.promise; } finally { clearTimeout(timeout); }
  return `git://127.0.0.1:${port}/remote.git`;
}

for (const backend of RUNTIME_BACKENDS) describe(`exact Git delivery (${backend})`, () => {
  test('observes exact commit identity and ancestry without trusting branch names', async () => {
    const f = await fixture(backend);
    const observed = await f.git.inspectCommit({ projectPath: f.source, commit: f.commit, ancestor: f.base });
    expect(observed).toMatchObject({ executorId: 'local', instanceId: 'delivery-runtime', commit: f.commit,
      parents: [f.base], containsAncestor: true });
    expect(await f.git.inspectCommit({ projectPath: f.source, commit: f.base, ancestor: f.commit })).toMatchObject({ containsAncestor: false });
    const unrelated = await f.run(f.source, ['commit-tree', observed.tree, '-m', 'Synthetic unrelated root']);
    expect(await f.git.inspectCommit({ projectPath: f.source, commit: f.commit, ancestor: unrelated })).toMatchObject({ containsAncestor: false });
    expect(await f.git.inspectCommit({ projectPath: f.source, commit: f.commit, ancestor: null })).toMatchObject({ containsAncestor: null });
  });

  test('ignores replacement refs and grafts for evidence, checkout, merge and transfer', async () => {
    const f = await fixture(backend);
    const original = await f.git.inspectCommit({ projectPath: f.source, commit: f.base, ancestor: null });
    await f.run(f.source, ['replace', f.base, f.commit]);
    await writeFile(join(f.source, '.git', 'info', 'grafts'), `${f.commit}\n`);
    expect(await f.git.inspectCommit({ projectPath: f.source, commit: f.base, ancestor: f.commit }))
      .toMatchObject({ tree: original.tree, parents: [], containsAncestor: false });
    expect(await f.git.inspectCommit({ projectPath: f.source, commit: f.commit, ancestor: f.base }))
      .toMatchObject({ parents: [f.base], containsAncestor: true });
    const request = { projectPath: f.source, worktreePath: join(f.root, 'managed'), operationId: crypto.randomUUID(),
      managedResourceId: crypto.randomUUID(), branch: 'managed/replacements', baseCommit: f.base };
    const { managed } = await f.git.createManagedWorktree(request);
    const { branch: _branch, baseCommit: _base, ...identity } = request;
    expect(await readFile(join(request.worktreePath, 'source.txt'), 'utf8')).toBe('Synthetic source\n');
    expect((await f.git.inspectManagedWorktree(identity)).managed).toMatchObject({ dirty: false });
    expect(await f.git.integrateCommits({ ...identity, expectedHead: f.base, expectedBranch: managed.branch,
      expectedRepositoryIdentity: managed.repositoryIdentity, expectedWorktreeIdentity: managed.worktreeIdentity,
      commits: [f.commit], strategy: 'ordered-merge' })).toMatchObject({ kind: 'integrated', managed: { head: f.commit } });
    await f.git.pushExactRef({ ...f.input, commit: f.base, expectedRemoteCommit: null });
    expect(await f.run(f.remote, ['show', '-s', '--format=%T', f.base])).toBe(original.tree);
    expect(await f.run(f.remote, ['for-each-ref', '--format=%(refname)', 'refs/replace/'])).toBe('');
  }, 15_000);

  test('rejects shallow evidence and transfers before dispatch', async () => {
    const f = await fixture(backend);
    await writeFile(join(f.source, '.git', 'shallow'), `${f.commit}\n`);
    await expect(f.git.inspectCommit({ projectPath: f.source, commit: f.commit, ancestor: f.base }))
      .rejects.toMatchObject({ code: 'GIT_INVALID_INPUT' });
    await expect(f.git.pushExactRef({ ...f.input, expectedRemoteCommit: null })).rejects.toMatchObject({ code: 'GIT_INVALID_INPUT' });
    await expect(f.git.fetchExactRef(f.input)).rejects.toMatchObject({ code: 'GIT_INVALID_INPUT' });
    expect(await f.run(f.remote, ['for-each-ref'])).toBe('');
  });

  test('rejects a partial clone before lazy fetching missing commit evidence', async () => {
    const f = await fixture(backend);
    await f.run(f.remote, ['config', 'uploadpack.allowFilter', 'true']);
    await f.run(f.source, ['push', 'origin', `${f.base}:refs/heads/main`]);
    const partial = join(f.root, 'partial');
    await f.run(f.root, ['clone', '--filter=blob:none', '--no-checkout', `file://${f.remote}`, partial]);
    await f.run(f.source, ['push', 'origin', `${f.commit}:refs/heads/main`]);
    const missing = () => gitProcess.runGit(partial, ['cat-file', '-e', f.commit], { env: { GIT_NO_LAZY_FETCH: '1' } });
    await expect(missing()).rejects.toThrow();
    await expect(f.git.inspectCommit({ projectPath: partial, commit: f.commit, ancestor: null }))
      .rejects.toMatchObject({ code: 'GIT_INVALID_INPUT' });
    await expect(f.git.fetchExactRef({ ...f.input, projectPath: partial, expectedRemoteUrl: `file://${f.remote}`, ref: 'refs/heads/main' }))
      .rejects.toMatchObject({ code: 'GIT_INVALID_INPUT' });
    await expect(f.git.pushExactRef({ ...f.input, projectPath: partial, expectedRemoteCommit: null }))
      .rejects.toMatchObject({ code: 'GIT_INVALID_INPUT' });
    await expect(f.git.createManagedWorktree({ projectPath: partial, worktreePath: join(f.root, 'managed'),
      operationId: crypto.randomUUID(), managedResourceId: crypto.randomUUID(), branch: 'managed/partial', baseCommit: f.commit }))
      .rejects.toMatchObject({ code: 'GIT_INVALID_INPUT' });
    await expect(missing()).rejects.toThrow();
    expect(await f.run(f.remote, ['for-each-ref', '--format=%(refname)'])).toBe('refs/heads/main');
  });

  test.each(['extensions.partialClone', 'remote.synthetic.promisor'])('rejects %s even when objects are already local', async key => {
    const f = await fixture(backend);
    await f.run(f.source, ['config', key, key === 'extensions.partialClone' ? 'origin' : 'true']);
    await expect(f.git.inspectCommit({ projectPath: f.source, commit: f.commit, ancestor: null }))
      .rejects.toMatchObject({ code: 'GIT_INVALID_INPUT' });
  });

  test.each(['misplaced-parent', 'large-message'] as const)('rejects %s commit metadata instead of reporting misleading evidence', async kind => {
    const f = await fixture(backend);
    const original = await f.run(f.source, ['cat-file', 'commit', f.commit]);
    const boundary = original.indexOf('\n\n');
    const content = kind === 'misplaced-parent' ? `${original.slice(0, boundary)}\nparent ${f.commit}${original.slice(boundary)}`
      : `${original.slice(0, boundary)}\n\n${'Synthetic message. '.repeat(4096)}`;
    const commit = (await gitProcess.runGitWithStdin(f.source, ['hash-object', '-t', 'commit', '-w', '--stdin'], content)).stdout.trim();
    if (kind === 'misplaced-parent') expect(await f.run(f.source, ['rev-list', '--parents', '--no-walk', commit])).toBe(`${commit} ${f.base}`);
    await expect(f.git.inspectCommit({ projectPath: f.source, commit, ancestor: null })).rejects.toMatchObject({
      code: kind === 'misplaced-parent' ? 'GIT_INVALID_INPUT' : 'GIT_RESULT_TOO_LARGE' });
  });

  test('transfers only the exact commit/ref without moving either checkout or FETCH_HEAD', async () => {
    const f = await fixture(backend);
    const destinationHead = await f.run(f.destination, ['rev-parse', 'HEAD']);
    await f.run(f.source, ['tag', '-a', 'synthetic-tag', '-m', 'Synthetic tag', f.commit]);
    await f.run(f.source, ['config', 'push.followTags', 'true']);
    await f.git.pushExactRef({ ...f.input, expectedRemoteCommit: null });
    expect(await f.run(f.remote, ['for-each-ref', '--format=%(refname)'])).toBe(f.input.ref);
    await writeFile(join(f.destination, '.git', 'FETCH_HEAD'), 'Synthetic retained fetch observation\n');
    expect(await f.git.fetchExactRef({ ...f.input, projectPath: f.destination })).toMatchObject({ success: true, commit: f.commit, ref: f.input.ref });
    expect(await f.run(f.destination, ['rev-parse', 'HEAD'])).toBe(destinationHead);
    expect(await f.run(f.source, ['rev-parse', 'HEAD'])).toBe(f.commit);
    expect(await f.run(f.destination, ['for-each-ref', '--format=%(refname)'])).toBe('refs/heads/main');
    expect(await readFile(join(f.destination, '.git', 'FETCH_HEAD'), 'utf8')).toBe('Synthetic retained fetch observation\n');
    expect(await f.git.inspectCommit({ projectPath: f.destination, commit: f.commit, ancestor: f.base })).toMatchObject({ containsAncestor: true });
  });

  test('exact fetch ignores configured bundle sources without importing objects or refs', async () => {
    const f = await fixture(backend);
    await f.git.pushExactRef({ ...f.input, expectedRemoteCommit: null });
    const tree = await f.run(f.source, ['rev-parse', `${f.base}^{tree}`]);
    const foreign = await f.run(f.source, ['commit-tree', tree, '-m', 'Synthetic unapproved bundle']);
    await f.run(f.source, ['update-ref', 'refs/heads/unapproved', foreign]);
    const bundle = join(f.root, 'unapproved.bundle');
    await f.run(f.source, ['bundle', 'create', bundle, 'refs/heads/unapproved']);
    await f.run(f.destination, ['config', 'fetch.bundleURI', bundle]);
    expect(await f.git.fetchExactRef({ ...f.input, projectPath: f.destination })).toMatchObject({ success: true });
    expect(await f.run(f.destination, ['for-each-ref', '--format=%(refname)'])).toBe('refs/heads/main');
    await expect(f.run(f.destination, ['cat-file', '-e', foreign])).rejects.toThrow();
    expect(await f.run(f.destination, ['cat-file', '-t', f.commit])).toBe('commit');
  });

  test('fetches an advertised source ref over the native Git protocol', async () => {
    const f = await fixture(backend);
    await f.git.pushExactRef({ ...f.input, expectedRemoteCommit: null });
    const url = await gitDaemon(f.root);
    await f.run(f.destination, ['remote', 'set-url', 'origin', url]);
    await f.run(f.destination, ['config', 'protocol.version', '0']);
    await f.run(f.remote, ['config', 'uploadpack.allowAnySHA1InWant', 'false']);
    await f.run(f.remote, ['config', 'uploadpack.allowTipSHA1InWant', 'false']);
    const run = gitProcess.runGit; let fetches = 0;
    const runner = spyOn(gitProcess, 'runGit').mockImplementation(async (cwd, args, options) => {
      if (args.includes('fetch')) { fetches++; expect(args.at(-1)).toBe(f.input.ref); }
      return run(cwd, args, options);
    });
    try {
      expect(await f.git.fetchExactRef({ ...f.input, projectPath: f.destination, expectedRemoteUrl: url })).toMatchObject({ success: true });
      expect(fetches).toBe(1);
      expect(await f.run(f.destination, ['for-each-ref', '--format=%(refname)'])).toBe('refs/heads/main');
      expect(await f.git.inspectCommit({ projectPath: f.destination, commit: f.commit, ancestor: f.base })).toMatchObject({ containsAncestor: true });
    } finally { runner.mockRestore(); }
  });

  test('inspects and transfers SHA-256 objects', async () => {
    const f = await fixture(backend, 'sha256');
    expect(f.commit).toHaveLength(64);
    await f.git.pushExactRef({ ...f.input, expectedRemoteCommit: null });
    await f.git.fetchExactRef({ ...f.input, projectPath: f.destination });
    expect(await f.git.inspectCommit({ projectPath: f.destination, commit: f.commit, ancestor: f.base }))
      .toMatchObject({ commit: f.commit, parents: [f.base], containsAncestor: true });
  });

  test('rejects stale destination expectations and never overwrites an unapproved ref', async () => {
    const f = await fixture(backend);
    await f.git.pushExactRef({ ...f.input, commit: f.base, expectedRemoteCommit: null });
    await expect(f.git.pushExactRef({ ...f.input, expectedRemoteCommit: null })).rejects.toMatchObject({ code: 'GIT_INVALID_INPUT' });
    await expect(f.git.fetchExactRef({ ...f.input, projectPath: f.destination })).rejects.toMatchObject({ code: 'GIT_INVALID_INPUT' });
    expect(await f.run(f.remote, ['rev-parse', f.input.ref])).toBe(f.base);
    await f.git.pushExactRef({ ...f.input, expectedRemoteCommit: f.base });
    expect(await f.run(f.remote, ['rev-parse', f.input.ref])).toBe(f.commit);
  });

  test.each(['file', 'git'] as const)('rejects advertised symbolic ref destinations over %s transport', async transport => {
    const f = await fixture(backend);
    await f.run(f.source, ['push', 'origin', `${f.base}:refs/heads/main`]);
    await f.run(f.remote, ['symbolic-ref', f.input.ref, 'refs/heads/main']);
    const url = transport === 'file' ? f.remote : await gitDaemon(f.root);
    await f.run(f.source, ['remote', 'set-url', 'origin', url]);
    await f.run(f.source, ['config', 'protocol.version', '0']);
    const v0 = await f.run(f.source, ['-c', 'protocol.version=0', 'ls-remote', '--symref', '--refs', url, f.input.ref]);
    expect(v0).toBe(`${f.base}\t${f.input.ref}`);
    const v2 = await f.run(f.source, ['-c', 'protocol.version=2', 'ls-remote', '--symref', '--refs', url, f.input.ref]);
    expect(v2).toContain(`ref: refs/heads/main\t${f.input.ref}`);
    await expect(f.git.pushExactRef({ ...f.input, expectedRemoteUrl: url, expectedRemoteCommit: f.base }))
      .rejects.toMatchObject({ code: 'GIT_INVALID_INPUT' });
    await expect(f.git.fetchExactRef({ ...f.input, expectedRemoteUrl: url, commit: f.base }))
      .rejects.toMatchObject({ code: 'GIT_INVALID_INPUT' });
    expect(await f.run(f.remote, ['rev-parse', 'refs/heads/main'])).toBe(f.base);
    expect(await f.run(f.remote, ['symbolic-ref', f.input.ref])).toBe('refs/heads/main');
  });

  test('requires the approved directional URL and rejects multiple push destinations', async () => {
    const f = await fixture(backend);
    await expect(f.git.pushExactRef({ ...f.input, expectedRemoteUrl: f.source, expectedRemoteCommit: null }))
      .rejects.toMatchObject({ code: 'GIT_INVALID_INPUT' });
    await f.run(f.source, ['config', '--add', 'remote.origin.pushurl', f.remote]);
    await f.run(f.source, ['config', '--add', 'remote.origin.pushurl', f.destination]);
    await expect(f.git.pushExactRef({ ...f.input, expectedRemoteCommit: null })).rejects.toMatchObject({ code: 'GIT_INVALID_INPUT' });
    expect(await f.run(f.remote, ['for-each-ref'])).toBe('');
  });

  test('explicit pushurl suppresses pushInsteadOf without redirecting the approved write', async () => {
    const f = await fixture(backend);
    const unapproved = join(f.root, 'unapproved.git'); await mkdir(unapproved);
    await f.run(unapproved, ['init', '--bare']);
    await f.run(f.source, ['config', 'remote.origin.pushurl', f.remote]);
    await f.run(f.source, ['config', `url.${unapproved}.pushInsteadOf`, f.remote]);
    await f.git.pushExactRef({ ...f.input, expectedRemoteCommit: null });
    expect(await f.run(f.remote, ['rev-parse', f.input.ref])).toBe(f.commit);
    expect(await f.run(unapproved, ['for-each-ref'])).toBe('');
  });

  test('rejects a resolved URL subject to a second insteadOf rewrite', async () => {
    const f = await fixture(backend);
    await f.run(f.source, ['remote', 'set-url', 'origin', 'synthetic-destination:']);
    await f.run(f.source, ['config', `url.${f.remote}.insteadOf`, 'synthetic-destination:']);
    await f.run(f.source, ['config', `url.${f.destination}.insteadOf`, f.remote]);
    for (const call of [() => f.git.pushExactRef({ ...f.input, expectedRemoteCommit: null }), () => f.git.fetchExactRef(f.input)]) {
      await expect(call()).rejects.toMatchObject({ code: 'GIT_INVALID_INPUT' });
    }
    expect(await f.run(f.remote, ['for-each-ref'])).toBe('');
  });

  test('rejects configured embedded credentials without returning them', async () => {
    const f = await fixture(backend);
    await f.run(f.source, ['config', 'remote.origin.pushurl', 'https://synthetic:private-token@example.invalid/repo.git']);
    const error = await f.git.pushExactRef({ ...f.input, expectedRemoteCommit: null }).then(() => null, error => error);
    expect(error).toMatchObject({ code: 'GIT_INVALID_INPUT' });
    expect(String(error)).not.toContain('private-token');
  });

  test('rejects raw HTTP backslashes before URL normalization can hide credentials', async () => {
    const f = await fixture(backend);
    const requests: (string | null)[] = [];
    const server = Bun.serve({ hostname: '0.0.0.0', port: 0, fetch(request) {
      const authorization = request.headers.get('authorization');
      requests.push(authorization);
      return new Response(null, authorization ? { status: 404 }
        : { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="synthetic"' } });
    } });
    cleanups.push(() => server.stop(true));
    const url = `http://synthetic\\:private-token@127.0.0.1:${server.port}/repo.git`;
    expect(new URL(url).username).toBe('');
    expect(new URL(url).password).toBe('');
    await expect(gitProcess.runGit(f.source, ['-c', 'credential.helper=', 'ls-remote', url],
      { env: { GIT_TERMINAL_PROMPT: '0' } })).rejects.toThrow();
    expect(requests).toContain(`Basic ${Buffer.from('synthetic\\:private-token').toString('base64')}`);
    requests.length = 0;
    await f.run(f.source, ['remote', 'set-url', 'origin', url]);
    const input = { ...f.input, expectedRemoteUrl: url };
    for (const call of [() => f.git.fetchExactRef(input), () => f.git.pushExactRef({ ...input, expectedRemoteCommit: null }),
      () => createDeliveryOperations().fetchExactRef(input), () => f.git.fetchExactRef(f.input)]) {
      const error = await call().then(() => null, error => error);
      expect(error).toMatchObject({ code: 'GIT_INVALID_INPUT' });
      expect(String(error)).not.toContain('private-token');
    }
    expect(requests).toEqual([]);
  });

  test.each(['synthetic', ''])('rejects named-remote helper override %j before exact push dispatch', async helper => {
    const f = await fixture(backend);
    await f.run(f.source, ['config', 'remote.origin.vcs', helper]);
    await expect(f.git.pushExactRef({ ...f.input, expectedRemoteCommit: null }))
      .rejects.toMatchObject({ code: 'GIT_INVALID_INPUT' });
    expect(await f.run(f.remote, ['for-each-ref'])).toBe('');
  });

  test.each(['name', 'url', 'legacy-remotes', 'legacy-branches'] as const)('rejects a destination reinterpreted through a %s alias', async kind => {
    const f = await fixture(backend);
    await f.git.pushExactRef({ ...f.input, expectedRemoteCommit: null });
    const expectedRemoteUrl = kind === 'url' ? `file://${f.destination}` : 'alias';
    await f.run(f.destination, ['remote', 'set-url', 'origin', expectedRemoteUrl]);
    if (kind.startsWith('legacy-')) {
      const directory = join(f.destination, '.git', kind === 'legacy-remotes' ? 'remotes' : 'branches');
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, 'alias'), kind === 'legacy-remotes' ? `URL: ${f.remote}\n` : `${f.remote}#main\n`);
    } else await f.run(f.destination, ['config', `remote.${expectedRemoteUrl}.url`, f.remote]);
    await expect(f.git.fetchExactRef({ ...f.input, projectPath: f.destination, expectedRemoteUrl }))
      .rejects.toMatchObject({ code: 'GIT_INVALID_INPUT' });
    await expect(f.run(f.destination, ['cat-file', '-t', f.commit])).rejects.toThrow();
  });

  test('suppresses inherited push options and rejects mirror configuration before dispatch', async () => {
    const f = await fixture(backend);
    await f.run(f.remote, ['config', 'receive.advertisePushOptions', 'true']);
    await writeFile(join(f.remote, 'hooks', 'pre-receive'), '#!/bin/sh\nprintf "%s" "$GIT_PUSH_OPTION_COUNT" > push-options-count\n', { mode: 0o755 });
    await f.run(f.source, ['config', 'push.pushOption', 'merge_request.create']);
    await f.run(f.source, ['config', 'remote.origin.mirror', 'true']);
    await expect(f.git.pushExactRef({ ...f.input, expectedRemoteCommit: null })).rejects.toMatchObject({ code: 'GIT_INVALID_INPUT' });
    expect(await f.run(f.remote, ['for-each-ref'])).toBe('');
    await f.run(f.source, ['config', 'remote.origin.mirror', 'false']);
    await f.git.pushExactRef({ ...f.input, expectedRemoteCommit: null });
    expect(await readFile(join(f.remote, 'push-options-count'), 'utf8')).toBe('0');
  });

  test.each(['absent', 'commit'] as const)('the lease rejects a racing remote update after the %s preflight', async expectation => {
    const f = await fixture(backend);
    const tree = await f.run(f.source, ['rev-parse', `${f.base}^{tree}`]);
    const competing = await f.run(f.source, ['commit-tree', tree, '-m', 'Synthetic competing update']);
    await f.run(f.source, ['push', 'origin', `${competing}:refs/heads/seed`]);
    if (expectation === 'commit') await f.git.pushExactRef({ ...f.input, commit: f.base, expectedRemoteCommit: null });
    const run = gitProcess.runGit; let pushes = 0;
    const runner = spyOn(gitProcess, 'runGit').mockImplementation(async (cwd, args, options) => {
      if (args.includes('push')) { pushes++; await run(f.remote, ['update-ref', f.input.ref, competing]); }
      return run(cwd, args, options);
    });
    try {
      await expect(f.git.pushExactRef({ ...f.input, expectedRemoteCommit: expectation === 'commit' ? f.base : null }))
        .rejects.toMatchObject({ code: 'GIT_MUTATION_OUTCOME_UNKNOWN' });
      expect(await f.run(f.remote, ['rev-parse', f.input.ref])).toBe(competing);
      expect(pushes).toBe(1);
    } finally { runner.mockRestore(); }
  });

  test('allows a non-fast-forward update only with the matching lease', async () => {
    const f = await fixture(backend);
    await f.git.pushExactRef({ ...f.input, expectedRemoteCommit: null });
    await f.git.pushExactRef({ ...f.input, commit: f.base, expectedRemoteCommit: f.commit });
    expect(await f.run(f.remote, ['rev-parse', f.input.ref])).toBe(f.base);
  });

  test('retains unknown push after the remote write when native confirmation is lost', async () => {
    const f = await fixture(backend); let pushes = 0;
    const run = gitProcess.runGit;
    const runner = spyOn(gitProcess, 'runGit').mockImplementation(async (cwd, args, options) => {
      const result = await run(cwd, args, options);
      if (args.includes('push')) { pushes++; throw new Error('Synthetic lost push confirmation'); }
      return result;
    });
    try {
      await expect(f.git.pushExactRef({ ...f.input, expectedRemoteCommit: null })).rejects.toMatchObject({ code: 'GIT_MUTATION_OUTCOME_UNKNOWN' });
      expect(await f.run(f.remote, ['rev-parse', f.input.ref])).toBe(f.commit);
      await expect(f.git.pushExactRef({ ...f.input, expectedRemoteCommit: null })).rejects.toMatchObject({ code: 'GIT_INVALID_INPUT' });
      expect(pushes).toBe(1);
    } finally { runner.mockRestore(); }
  });

  test.each(['before', 'after'] as const)('a ref moving %s fetch does not confirm the transfer', async timing => {
    const f = await fixture(backend);
    await f.git.pushExactRef({ ...f.input, expectedRemoteCommit: null });
    const run = gitProcess.runGit;
    const runner = spyOn(gitProcess, 'runGit').mockImplementation(async (cwd, args, options) => {
      if (args.includes('fetch') && timing === 'before') await run(f.remote, ['update-ref', f.input.ref, f.base]);
      const result = await run(cwd, args, options);
      if (args.includes('fetch') && timing === 'after') await run(f.remote, ['update-ref', f.input.ref, f.base]);
      return result;
    });
    try {
      await expect(f.git.fetchExactRef({ ...f.input, projectPath: f.destination })).rejects.toMatchObject({ code: 'GIT_MUTATION_OUTCOME_UNKNOWN' });
      if (timing === 'after') expect(await f.run(f.destination, ['cat-file', '-t', f.commit])).toBe('commit');
      else await expect(f.run(f.destination, ['cat-file', '-t', f.commit])).rejects.toThrow();
      expect(await f.run(f.destination, ['for-each-ref', '--format=%(refname)'])).toBe('refs/heads/main');
    } finally { runner.mockRestore(); }
  });

  async function integrationFixture() {
    const f = await fixture(backend);
    const request = { projectPath: f.source, worktreePath: join(f.root, 'managed'), operationId: crypto.randomUUID(),
      managedResourceId: crypto.randomUUID(), branch: 'managed/integration', baseCommit: f.base };
    const { managed } = await f.git.createManagedWorktree(request);
    return { ...f, integrate: { projectPath: f.source, worktreePath: request.worktreePath, operationId: request.operationId,
      managedResourceId: request.managedResourceId, expectedRepositoryIdentity: managed.repositoryIdentity,
      expectedWorktreeIdentity: managed.worktreeIdentity, expectedHead: f.base, expectedBranch: managed.branch,
      strategy: 'ordered-merge' as const, commits: [f.commit] } };
  }

  test.each(['branch-options', 'default-strategy'] as const)('integrates ordered immutable commits despite %s configuration', async configuration => {
    const f = await integrationFixture();
    await f.run(f.source, ['checkout', '--detach', f.base]);
    await writeFile(join(f.source, 'second.txt'), 'Synthetic independent output\n');
    await f.run(f.source, ['add', 'second.txt']);
    await f.run(f.source, ['commit', '-m', 'Synthetic second output']);
    const second = await f.run(f.source, ['rev-parse', 'HEAD']);
    await f.run(f.source, ['config', 'merge.ff', 'only']);
    await f.run(f.source, ['config', 'merge.verifySignatures', 'true']);
    await f.run(f.source, ['config', ...(configuration === 'branch-options'
      ? [`branch.${f.integrate.expectedBranch}.mergeOptions`, '-s ours'] : ['pull.twohead', 'ours'])]);
    const result = await f.git.integrateCommits({ ...f.integrate, commits: [f.commit, second] });
    expect(result.kind).toBe('integrated');
    if (result.kind !== 'integrated') throw new Error('Expected integrated fixture');
    expect(result.managed.dirty).toBe(false);
    expect(await f.git.inspectCommit({ projectPath: f.source, commit: result.managed.head, ancestor: f.commit }))
      .toMatchObject({ parents: [f.commit, second], containsAncestor: true });
    expect(await f.run(f.source, ['rev-parse', 'HEAD'])).toBe(second);
    expect(await readFile(join(f.integrate.worktreePath, 'second.txt'), 'utf8')).toBe('Synthetic independent output\n');
  });

  test.each(['branch-options', 'default-driver'] as const)('retains integration conflicts despite %s configuration', async configuration => {
    const f = await integrationFixture();
    await f.run(f.source, ['checkout', '--detach', f.base]);
    await writeFile(join(f.source, 'source.txt'), 'Synthetic conflicting output\n');
    await f.run(f.source, ['commit', '-am', 'Synthetic conflict']);
    const second = await f.run(f.source, ['rev-parse', 'HEAD']);
    if (configuration === 'branch-options') await f.run(f.source, ['config', `branch.${f.integrate.expectedBranch}.mergeOptions`, '-Xtheirs']);
    await f.run(f.source, ['config', 'rerere.enabled', 'true']);
    await f.run(f.source, ['config', 'rerere.autoupdate', 'true']);
    await f.run(f.source, ['merge', '--no-edit', f.commit]).catch(() => undefined);
    await writeFile(join(f.source, 'source.txt'), 'Synthetic recorded resolution\n');
    await f.run(f.source, ['add', 'source.txt']);
    await f.run(f.source, ['rerere']);
    await f.run(f.source, ['merge', '--abort']);
    if (configuration === 'default-driver') await f.run(f.source, ['config', 'merge.default', 'union']);
    expect(await f.git.integrateCommits({ ...f.integrate, commits: [f.commit, second] })).toMatchObject({
      kind: 'conflicts', paths: ['source.txt'], managed: { head: f.commit, dirty: true } });
    expect(await f.run(f.source, ['rev-parse', 'HEAD'])).toBe(second);
    expect(await f.run(f.source, ['status', '--porcelain'])).toBe('');
    expect(await readFile(join(f.integrate.worktreePath, 'source.txt'), 'utf8')).toContain('<<<<<<<');
  });

  test('rejects stale identity, head, dirty worktree and unmanaged checkout integration', async () => {
    const f = await integrationFixture();
    for (const patch of [{ expectedHead: f.commit }, { expectedWorktreeIdentity: 'wrong' }, { expectedRepositoryIdentity: 'wrong' },
      { expectedBranch: 'main' }, { worktreePath: f.source }]) {
      await expect(f.git.integrateCommits({ ...f.integrate, ...patch })).rejects.toMatchObject({ code: 'GIT_INVALID_INPUT' });
    }
    await writeFile(join(f.integrate.worktreePath, 'untracked.txt'), 'Synthetic retained edit\n');
    await expect(f.git.integrateCommits(f.integrate)).rejects.toMatchObject({ code: 'GIT_INVALID_INPUT' });
    expect(await f.run(f.integrate.worktreePath, ['rev-parse', 'HEAD'])).toBe(f.base);
  });

  test('does not replay or undo a merge whose native confirmation was lost', async () => {
    const f = await integrationFixture();
    const run = gitProcess.runGit;
    const runner = spyOn(gitProcess, 'runGit').mockImplementation(async (cwd, args, options) => {
      const result = await run(cwd, args, options);
      if (args.includes('merge')) throw new Error('Synthetic lost merge confirmation');
      return result;
    });
    try {
      expect(await f.git.integrateCommits(f.integrate)).toMatchObject({ kind: 'unknown' });
      expect(await f.run(f.integrate.worktreePath, ['rev-parse', 'HEAD'])).toBe(f.commit);
      await expect(f.git.integrateCommits(f.integrate)).rejects.toMatchObject({ code: 'GIT_INVALID_INPUT' });
    } finally { runner.mockRestore(); }
  });

  test('rejects an unconfirmed creation before integration dispatch', async () => {
    const f = await integrationFixture();
    const path = join(f.source, '.git', 'garcon-managed-worktrees', `${f.integrate.managedResourceId}.json`);
    const marker = JSON.parse(await readFile(path, 'utf8'));
    await writeFile(path, JSON.stringify({ ...marker, worktreeIdentity: null }));
    await expect(f.git.integrateCommits(f.integrate)).rejects.toMatchObject({ code: 'GIT_INVALID_INPUT' });
    expect(await f.run(f.integrate.worktreePath, ['rev-parse', 'HEAD'])).toBe(f.base);
  });

  test('cancellation after a native merge retains the changed worktree without another merge', async () => {
    const f = await integrationFixture(); const abort = new AbortController();
    const entered = Promise.withResolvers<void>(); const canceled = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>(); let merges = 0;
    const run = gitProcess.runGit;
    const runner = spyOn(gitProcess, 'runGit').mockImplementation(async (cwd, args, options) => {
      const result = await run(cwd, args, options);
      if (args.includes('merge')) {
        merges++; gitOperationSignal()!.addEventListener('abort', () => canceled.resolve(), { once: true });
        entered.resolve(); await finish.promise;
      }
      return result;
    });
    const result = f.git.integrateCommits({ ...f.integrate, commits: [f.commit, f.base] }, { signal: abort.signal }).then(value => value, error => error);
    try {
      await entered.promise; abort.abort(); await canceled.promise; finish.resolve();
      expect(await result).toMatchObject(backend === 'local' ? { kind: 'unknown' } : { code: 'GIT_MUTATION_OUTCOME_UNKNOWN' });
      expect(await f.run(f.integrate.worktreePath, ['rev-parse', 'HEAD'])).toBe(f.commit);
      expect(merges).toBe(1);
    } finally { finish.resolve(); await result; runner.mockRestore(); }
  });
});

test('exact delivery contracts reject symbolic commits and remain journaled bulk operations', () => {
  const input = { projectPath: '/synthetic/repo', remote: 'origin', expectedRemoteUrl: 'https://example.invalid/synthetic/repo.git',
    ref: 'refs/heads/transfer/synthetic', commit: 'a'.repeat(40), expectedRemoteCommit: null };
  expect(() => validateGitRequest('pushExactRef', input)).not.toThrow();
  for (const patch of [{ commit: 'HEAD' }, { expectedRemoteCommit: 'main' }, { ref: 'main' }, { expectedRemoteCommit: undefined }, { force: true },
    { expectedRemoteUrl: 'https://synthetic:secret@example.invalid/repo' }, { expectedRemoteUrl: 'https://secret@example.invalid/repo' },
    { expectedRemoteUrl: 'ssh://git:secret@example.invalid/repo' }, { expectedRemoteUrl: 'ftps::https://synthetic:secret@example.invalid/repo' },
    { expectedRemoteUrl: 'ext::synthetic command' }, { expectedRemoteUrl: '9synthetic::x' }, { expectedRemoteUrl: 'ftps://example.invalid/repo' }]) {
    expect(() => validateGitRequest('pushExactRef', { ...input, ...patch })).toThrow();
  }
  const scope = { executorId: 'synthetic', instanceId: 'runtime' };
  expect(() => validateGitResult('inspectCommit', { ...scope, commit: 'HEAD', tree: input.commit, parents: [], containsAncestor: true }, scope)).toThrow();
  for (const method of ['git.inspectCommit', 'git.fetchExactRef', 'git.pushExactRef', 'git.integrateCommits'] as const) {
    expect(rpcContinuity(method)).toBe('journaled');
    expect(rpcLane(method, { input, budgetMs: 1000 })).toBe('bulk');
  }
});
