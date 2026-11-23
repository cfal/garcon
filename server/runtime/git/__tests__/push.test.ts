import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { withGitOperation } from '../operation-context.js';
import { pushBranchRef } from '../push-branch.js';
import { gitServiceError } from '../service-errors.js';
import { cleanupExecutorRuntimeFixtures, executorRuntimeFixture, runFixtureGit as runGit } from './executor-runtime-fixture.js';

const temporary = path.join(homedir(), 'tmp');
const originalEnv = new Map<string, string | undefined>();
let home: string;
beforeEach(async () => {
  await mkdir(temporary, { recursive: true });
  home = await mkdtemp(path.join(temporary, 'git-push-home-'));
  for (const [key, value] of Object.entries({
    HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1', GIT_TEMPLATE_DIR: '', GIT_ALLOW_PROTOCOL: 'file:http',
  })) {
    originalEnv.set(key, process.env[key]);
    process.env[key] = value;
  }
});
afterEach(async () => {
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await cleanupExecutorRuntimeFixtures();
  await rm(home, { recursive: true, force: true });
});

const listRefs = async (remote: string) =>
  (await runGit(remote, ['for-each-ref', '--sort=refname', '--format=%(refname) %(objectname)'])).stdout;

const oid = async (repo: string, ref = 'HEAD') =>
  (await runGit(repo, ['show-ref', '--verify', '--hash', ref])).stdout.trim();

async function installHook(repo: string, name: 'pre-push' | 'update', body: string) {
  const hooks = path.join(path.dirname(repo), `${path.basename(repo)}-hooks`);
  await mkdir(hooks, { recursive: true });
  await runGit(repo, ['config', 'core.hooksPath', hooks]);
  await writeFile(path.join(hooks, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

async function createBareRemote(root: string, directory: string) {
  const remote = path.join(root, directory);
  await runGit(root, ['init', '--bare', remote]);
  return remote;
}

async function addOriginPushUrls(projectPath: string, ...urls: string[]) {
  for (const url of urls) await runGit(projectPath, ['config', '--add', 'remote.origin.pushurl', url]);
}

async function pushFixture(remoteDirectory = 'remote.git') {
  const { git, root, projectPath } = await executorRuntimeFixture();
  const remote = await createBareRemote(root, remoteDirectory);
  await runGit(projectPath, ['remote', 'add', 'origin', remote]);
  return { git, root, projectPath, remote };
}

test('preserves errors that prevent the push process from starting', async () => {
  const { root, projectPath } = await executorRuntimeFixture();
  const failure = (signal?: AbortSignal) => withGitOperation(root, { mutation: true }, () =>
    pushBranchRef(projectPath, 'origin', 'refs/heads/main', { env: { PATH: projectPath }, signal }),
  ).then(() => null, gitServiceError);
  expect(await failure()).toMatchObject({ code: 'GIT_MISSING' });
  expect(await failure(AbortSignal.abort())).toMatchObject({ code: 'GIT_TIMEOUT' });
});

test('keeps a non-fast-forward diagnostic without claiming the whole push was rejected', async () => {
  const { git, root, projectPath, remote } = await pushFixture();
  const branch = process.platform === 'win32' ? 'release' : Array(10).fill('release-'.repeat(11)).join('/');
  await runGit(projectPath, ['branch', branch]);
  await runGit(projectPath, ['commit', '--allow-empty', '-m', 'Remote tip']);
  await runGit(projectPath, ['push', 'origin', `HEAD:refs/heads/${branch}`]);
  const before = await listRefs(remote);
  await runGit(projectPath, ['switch', branch]);
  await runGit(projectPath, ['config', 'advice.pushUpdateRejected', 'false']);
  await expect(git.push({ projectPath, remoteBranch: branch })).rejects.toMatchObject({
    code: 'GIT_MUTATION_OUTCOME_UNKNOWN', message: expect.stringContaining('non-fast-forward'),
  });
  expect(await listRefs(remote)).toBe(before);

  // One rejection is not a report from an unreachable second push URL.
  await addOriginPushUrls(projectPath, remote, path.join(root, 'missing.git'));
  await expect(git.push({ projectPath, remoteBranch: branch })).rejects.toMatchObject({
    code: 'GIT_MUTATION_OUTCOME_UNKNOWN', message: expect.stringMatching(/non-fast-forward[\s\S]*missing\.git/),
  });
  expect(await listRefs(remote)).toBe(before);
});

test('creates a branch beside an existing tag using the exact local branch tip', async () => {
  const { git, projectPath, remote } = await pushFixture();
  await runGit(projectPath, ['branch', '-m', 'release']);
  await runGit(projectPath, ['tag', 'release']);
  await runGit(projectPath, ['push', 'origin', 'refs/tags/release']);
  const tag = await oid(projectPath);
  await runGit(projectPath, ['commit', '--allow-empty', '-m', 'Advance branch only']);
  const tip = await oid(projectPath);
  const options = { projectPath, remoteBranch: 'release' };
  await git.push(options);
  const published = `refs/heads/release ${tip}\nrefs/tags/release ${tag}\n`;
  expect(await listRefs(remote)).toBe(published);
  expect(await git.push(options)).toMatchObject({ success: true, remoteBranch: 'release' });

  await runGit(projectPath, ['branch', '-m', 'conflict-resolution']);
  await runGit(projectPath, ['tag', 'refs/heads/conflict-resolution', tag]);
  await expect(git.push({ projectPath })).rejects.toMatchObject({
    code: 'GIT_MUTATION_OUTCOME_UNKNOWN', message: expect.stringContaining('src refspec refs/heads/conflict-resolution matches more than one'),
  });
  expect(await listRefs(remote)).toBe(published);

  await runGit(projectPath, ['tag', 'detached-label', tag]);
  await runGit(projectPath, ['checkout', '--detach', tag]);
  expect((await git.getStatus({ projectPath })).branch).toBe('detached-label');
  await expect(git.push({ projectPath })).rejects.toMatchObject({ code: 'GIT_INVALID_INPUT' });
  expect(await listRefs(remote)).toBe(published);
});

test('an unborn checkout is not an alias named HEAD or a similar source ref', async () => {
  const { git, projectPath, remote } = await pushFixture();
  await runGit(projectPath, ['branch', '-m', 'decoy']);
  await runGit(projectPath, ['tag', 'refs/heads/unborn']);
  await runGit(projectPath, ['switch', '--orphan', 'unborn']);
  await runGit(projectPath, ['symbolic-ref', 'refs/HEAD', 'refs/heads/decoy']);
  expect(await git.getStatus({ projectPath })).toMatchObject({ branch: 'unborn', hasCommits: false });
  await expect(git.getRemoteStatus({ projectPath })).rejects.toMatchObject({ code: 'GIT_INVALID_INPUT' });
  for (const remoteBranch of ['decoy', 'unborn', undefined]) {
    await expect(git.push({ projectPath, remoteBranch })).rejects.toMatchObject({ code: 'GIT_INVALID_INPUT' });
    expect(await listRefs(remote)).toBe('');
  }
});

test('confirms the exact attached name even with Unicode whitespace and a HEAD tag', async () => {
  const { git, projectPath, remote } = await pushFixture();
  const branch = 'release\u00a0';
  await runGit(projectPath, ['branch', '-m', branch]);
  const tip = await oid(projectPath);
  await runGit(projectPath, ['update-ref', 'refs/tags/HEAD', tip]);
  expect(await git.getStatus({ projectPath })).toMatchObject({ branch, hasCommits: true });
  expect(await git.getRemoteStatus({ projectPath })).toMatchObject({ branch });
  await expect(git.push({ projectPath, remoteBranch: 'release' })).rejects.toMatchObject({ code: 'GIT_INVALID_INPUT' });
  expect(await listRefs(remote)).toBe('');
  expect(await git.push({ projectPath, remoteBranch: branch })).toMatchObject({ success: true });
  expect(await listRefs(remote)).toBe(`refs/heads/${branch} ${tip}\n`);

  await runGit(projectPath, ['branch', `--set-upstream-to=origin/${branch}`, branch]);
  await runGit(projectPath, ['commit', '--allow-empty', '-m', 'Ahead of the configured upstream']);
  await runGit(projectPath, ['update-ref', 'refs/remotes/origin/release', await oid(projectPath)]);
  await runGit(projectPath, ['tag', `origin/${branch}`, tip]);
  expect(await git.getRemoteStatus({ projectPath })).toMatchObject({
    branch, remoteName: 'origin', remoteBranch: `remotes/origin/${branch}`, hasUpstream: true, ahead: 1, behind: 0,
  });
  await runGit(projectPath, ['update-ref', '-d', `refs/remotes/origin/${branch}`]);
  expect(await git.getRemoteStatus({ projectPath })).toMatchObject({ hasRemote: true, hasUpstream: false, remoteName: 'origin' });
});

test.skipIf(process.platform === 'win32')('does not push a different branch with the same UTF-8 display name', async () => {
  const { git, projectPath, remote } = await pushFixture();
  const branch = 'release\ufffd';
  const tip = await oid(projectPath);
  await runGit(projectPath, ['branch', branch]);
  const switchBranch = Bun.spawnSync(['sh', '-c', String.raw`exec git switch -c "$(printf 'release\377')"`], { cwd: projectPath, env: process.env });
  expect(switchBranch.exitCode).toBe(0);
  await runGit(projectPath, ['commit', '--allow-empty', '-m', 'Advance byte-named branch']);
  await expect(git.push({ projectPath, remoteBranch: branch })).rejects.toMatchObject({ code: 'GIT_INVALID_INPUT' });
  expect(await listRefs(remote)).toBe('');

  await runGit(projectPath, ['switch', branch]);
  await git.push({ projectPath, remoteBranch: branch });
  expect(await listRefs(remote)).toBe(`refs/heads/${branch} ${tip}\n`);
});

test.skipIf(process.platform === 'win32')('does not mark a byte-distinct branch current for an unborn HEAD', async () => {
  const { git, projectPath } = await executorRuntimeFixture();
  const branch = 'release\ufffd';
  await runGit(projectPath, ['branch', branch]);
  const checkout = Bun.spawnSync(['sh', '-c', String.raw`exec git switch --orphan "$(printf 'release\377')"`], {
    cwd: projectPath, env: process.env,
  });
  expect(checkout.exitCode).toBe(0);
  const { refs } = await git.getRefs({ projectPath });
  expect(refs.map(ref => ref.name)).toContain(branch);
  expect(refs.filter(ref => ref.isCurrent)).toEqual([]);
});

test('distinguishes up-to-date, behind and diverged upstreams', async () => {
  const { git, projectPath } = await pushFixture();
  const status = () => git.getRemoteStatus({ projectPath });
  await runGit(projectPath, ['push', '--set-upstream', 'origin', 'refs/heads/main']);
  expect(await status()).toMatchObject({ isUpToDate: true, ahead: 0, behind: 0 });
  await runGit(projectPath, ['switch', '-c', 'other']);
  await runGit(projectPath, ['commit', '--allow-empty', '-m', 'Remote commit']);
  await runGit(projectPath, ['push', 'origin', 'HEAD:refs/heads/main']);
  await runGit(projectPath, ['switch', 'main']);
  expect(await status()).toMatchObject({ isUpToDate: false, ahead: 0, behind: 1 });
  await runGit(projectPath, ['commit', '--allow-empty', '-m', 'Local commit']);
  expect(await status()).toMatchObject({ isUpToDate: false, ahead: 1, behind: 1 });
});

test.each([
  { alias: 'refs/refs/heads/main', onlyRef: true, joined: false },
  { alias: 'refs/heads/refs/heads/main', onlyRef: false, joined: true },
  { alias: 'refs/remotes/refs/heads/main/HEAD', onlyRef: false, joined: false },
])(
  'does not update or confirm a Git-expanded destination at a global push URL: $alias', async ({ alias, onlyRef, joined }) => {
    const { git, root, projectPath } = await executorRuntimeFixture();
    const exact = path.join(root, 'exact.git');
    const ambiguous = path.join(root, 'ambiguous.git');
    const last = path.join(root, 'last.git');
    await runGit(projectPath, ['config', '--global', 'remote.origin.url', exact]);
    for (const remote of joined ? [exact, ambiguous, last] : [exact, ambiguous]) {
      await runGit(root, ['init', '--bare', remote]);
      await runGit(projectPath, ['config', '--global', '--add', 'remote.origin.pushurl', remote]);
    }
    await runGit(projectPath, ['push', ambiguous, `HEAD:${alias}`, ...(onlyRef ? [] : ['HEAD:refs/heads/other'])]);
    const before = await listRefs(ambiguous);
    await runGit(projectPath, ['commit', '--allow-empty', '-m', 'Advance main']);
    const tip = await oid(projectPath);
    if (joined) await installHook(projectPath, 'pre-push', 'printf "checking refs: "');

    await expect(git.push({ projectPath, remoteBranch: 'main' })).rejects.toMatchObject({ code: 'GIT_MUTATION_OUTCOME_UNKNOWN' });
    expect(await listRefs(exact)).toBe(`refs/heads/main ${tip}\n`);
    expect(await listRefs(ambiguous)).toBe(before);
    if (joined) expect(await listRefs(last)).toBe(`refs/heads/main ${tip}\n`);
  },
);

test.each([
  ['a bare Done', 'Done'],
  ['a hook line ending in Done', 'Build Done'],
  ['an unterminated report', 'To unfinished\n=\trefs/heads/main:refs/heads/main\t[up to date]'],
])('does not confirm %s even when the next report succeeds', async (_description, prefix) => {
  const { git, projectPath, remote } = await pushFixture();
  await installHook(projectPath, 'pre-push', `printf '%s\\n' '${prefix}'\necho 'Hook completed' >&2`);
  const tip = await oid(projectPath);
  await expect(git.push({ projectPath })).rejects.toMatchObject({
    code: 'GIT_MUTATION_OUTCOME_UNKNOWN', message: expect.stringMatching(/pre-push hook[\s\S]*Hook completed/),
  });
  expect(await listRefs(remote)).toBe(`refs/heads/main ${tip}\n`);
});

test('allows ordinary hook logs but does not confirm a truncated push report', async () => {
  const { git, projectPath, remote } = await pushFixture('remoteDone');
  await installHook(projectPath, 'pre-push', 'printf "To address all issues, run:\\n%040000d\\n" 0\nprintf "%02200000d\\n" 0 >&2');
  await git.push({ projectPath });
  const tip = await oid(projectPath);
  expect(await listRefs(remote)).toBe(`refs/heads/main ${tip}\n`);

  await runGit(projectPath, ['commit', '--allow-empty', '-m', 'Not published']);
  await installHook(projectPath, 'pre-push', 'printf "!\\tUnit tests failed\\n"\necho "Checks failed: merge conflict markers found" >&2\nexit 1');
  await expect(git.push({ projectPath })).rejects.toMatchObject({
    code: 'GIT_MUTATION_OUTCOME_UNKNOWN', message: expect.stringContaining('Checks failed: merge conflict markers found'),
  });
  expect(await listRefs(remote)).toBe(`refs/heads/main ${tip}\n`);

  await installHook(projectPath, 'pre-push', 'printf "\\357\\273\\277%02000000d\\n" 0\nexit 1');
  await expect(git.push({ projectPath })).rejects.toMatchObject({ code: 'GIT_MUTATION_OUTCOME_UNKNOWN' });
  expect(await listRefs(remote)).toBe(`refs/heads/main ${tip}\n`);
});

test('does not confirm a multi-URL push when only the first complete report fits', async () => {
  const { git, root, projectPath, remote } = await pushFixture();
  await git.push({ projectPath });
  const { stdout } = await runGit(projectPath, ['push', '--porcelain', 'origin', 'refs/heads/main:refs/heads/main']);
  // The retained prefix must end at the first report's Done, not partway through the second.
  const padding = 1024 * 1024 - Buffer.byteLength(stdout) - 1;
  await installHook(projectPath, 'pre-push', `case "$2" in *remote.git) printf '%0${padding}d\\n' 0;; esac`);
  expect(await git.push({ projectPath })).toMatchObject({ success: true });

  const second = await createBareRemote(root, 'second.git');
  await addOriginPushUrls(projectPath, remote, second);
  const tip = await oid(projectPath);
  await expect(git.push({ projectPath })).rejects.toMatchObject({
    code: 'GIT_MUTATION_OUTCOME_UNKNOWN', message: expect.stringContaining('truncated'),
  });
  for (const dest of [remote, second]) expect(await listRefs(dest)).toBe(`refs/heads/main ${tip}\n`);
});

test('does not confirm an up-to-date tag in place of the requested branch', async () => {
  const { git, projectPath, remote } = await pushFixture();
  await runGit(projectPath, ['push', 'origin', 'HEAD:refs/tags/refs/heads/main']);
  const before = await listRefs(remote);
  await expect(git.push({ projectPath, remoteBranch: 'main' })).rejects.toMatchObject({ code: 'GIT_MUTATION_OUTCOME_UNKNOWN' });
  expect(await listRefs(remote)).toBe(before);
});

test.each([
  { alias: 'refs/refs/heads/main', ambiguous: true },
  { alias: 'refs/remotes/refs/heads/main/HEAD', ambiguous: false },
])('leaves $alias unchanged when the exact remote branch also exists', async ({ alias, ambiguous }) => {
  const { git, projectPath, remote } = await pushFixture();
  const original = await oid(projectPath);
  await runGit(projectPath, ['push', 'origin', 'HEAD:refs/heads/main', `HEAD:${alias}`]);
  await runGit(projectPath, ['commit', '--allow-empty', '-m', 'Advance main']);
  const push = git.push({ projectPath });
  if (ambiguous) await expect(push).rejects.toThrow('matches more than one');
  else expect(await push).toMatchObject({ success: true });
  expect(await listRefs(remote)).toBe(`refs/heads/main ${ambiguous ? original : await oid(projectPath)}\n${alias} ${original}\n`);
});

test('confirms both push URLs and does not hide a rejected followed tag behind positive branch rows', async () => {
  const { git, root, projectPath, remote } = await pushFixture();
  const second = await createBareRemote(root, 'second.git');
  await addOriginPushUrls(projectPath, remote, second);
  await runGit(projectPath, ['config', 'push.followTags', 'true']);
  await runGit(projectPath, ['tag', '-a', 'refs/heads/main-v1', '-m', 'Follow this tag']);
  const followed = `refs/tags/refs/heads/main-v1 ${await oid(projectPath, 'refs/tags/refs/heads/main-v1')}\n`;
  expect(await git.push({ projectPath })).toMatchObject({ success: true });
  for (const dest of [remote, second]) expect(await listRefs(dest)).toBe(`refs/heads/main ${await oid(projectPath)}\n${followed}`);

  await runGit(projectPath, ['commit', '--allow-empty', '-m', 'Advance both branches']);
  await runGit(projectPath, ['tag', '-a', 'v2', '-m', 'Second tag']);
  await installHook(second, 'update', 'test "$1" != refs/tags/v2');
  await expect(git.push({ projectPath })).rejects.toMatchObject({
    code: 'GIT_MUTATION_OUTCOME_UNKNOWN', message: expect.stringContaining('hook declined'),
  });
  const accepted = `refs/heads/main ${await oid(projectPath)}\n${followed}`;
  expect(await listRefs(second)).toBe(accepted);
  expect(await listRefs(remote)).toBe(`${accepted}refs/tags/v2 ${await oid(projectPath, 'refs/tags/v2')}\n`);
});

test('retains the receiving hook explanation after noisy or sensitive local diagnostics', async () => {
  const { git, projectPath, remote } = await pushFixture();
  await installHook(remote, 'update', 'echo "Reviewed commits only: ftps://user:private-ftps-token@host.invalid/policy" >&2\nexit 1');
  await installHook(projectPath, 'pre-push', 'printf "%03000d\\nhttps://%03000d:private-token@host.invalid/\\n" 0 0 >&2');
  const failure = await git.push({ projectPath }).then(() => null, (error: Error) => error);
  expect(failure).toMatchObject({ code: 'GIT_MUTATION_OUTCOME_UNKNOWN' });
  expect(failure?.message).toMatch(/Inspect the remote[\s\S]*hook declined[\s\S]*<remote>[\s\S]*Reviewed commits only/);
  expect(failure?.message).not.toContain('private-token');
  expect(failure?.message).not.toContain('private-ftps-token');
  expect(failure?.message.length).toBeLessThanOrEqual(2048);
  expect(await listRefs(remote)).toBe('');
});

test('keeps native diagnostics without replaying a push after acknowledgment loss', async () => {
  const { git, projectPath, remote } = await pushFixture();
  await expect(git.push({ projectPath, remote: 'missing' })).rejects.toMatchObject({
    code: 'GIT_MUTATION_OUTCOME_UNKNOWN', message: expect.stringContaining('missing'),
  });
  expect(await listRefs(remote)).toBe('');

  // The receiver advertises normally and applies the pack, but its final status never reaches the sender.
  await installHook(projectPath, 'pre-push', 'echo run >> .git/push-attempts\nprintf "%03000d\\n" 0 >&2\necho "Executable not found: git-lfs; skipping index.lock check" >&2');
  const receivePack = `sh -c 'git receive-pack --stateless-rpc --advertise-refs "$1" && exec git receive-pack --stateless-rpc "$1" >/dev/null' --`;
  await runGit(projectPath, ['config', 'remote.origin.receivepack', receivePack]);
  await expect(git.push({ projectPath })).rejects.toMatchObject({
    code: 'GIT_MUTATION_OUTCOME_UNKNOWN', message: expect.stringMatching(/Inspect the remote[\s\S]*git-lfs[\s\S]*(?:disconnect|hung up)/i),
  });
  expect(await listRefs(remote)).toBe(`refs/heads/main ${await oid(projectPath)}\n`);
  expect(await readFile(path.join(projectPath, '.git/push-attempts'), 'utf8')).toBe('run\n');
});

test('does not infer whether a smart HTTP receiver applied a failed push', async () => {
  const { git, root, projectPath, remote } = await pushFixture();
  const httpRepo = await createBareRemote(root, 'http.git');
  const endpoint = '/' + crypto.randomUUID();
  const server = Bun.serve({
    hostname: '0.0.0.0', port: 0,
    async fetch(request) {
      const pathname = new URL(request.url).pathname;
      if (pathname === endpoint + '/unavailable/info/refs') return new Response(null, { status: 503 });
      if (pathname === endpoint + '/info/refs') {
        const refs = Bun.spawnSync(['git', 'receive-pack', '--stateless-rpc', '--advertise-refs', httpRepo]);
        return new Response(Buffer.concat([Buffer.from('001f# service=git-receive-pack\n0000'), refs.stdout]), {
          headers: { 'Content-Type': 'application/x-git-receive-pack-advertisement' },
        });
      }
      if (pathname === endpoint + '/git-receive-pack' && request.method === 'POST') {
        const pack = new Uint8Array(await request.arrayBuffer());
        const receive = Bun.spawnSync(['git', 'receive-pack', '--stateless-rpc', httpRepo], { stdin: pack });
        if (receive.exitCode !== 0) return new Response(null, { status: 500 });
        return new Response('not a Git packet', { headers: { 'Content-Type': 'application/x-git-receive-pack-result' } });
      }
      return new Response(null, { status: 404 });
    },
  });
  try {
    const url = `http://127.0.0.1:${server.port}${endpoint}`;
    await runGit(projectPath, ['remote', 'add', 'http', url + '/unavailable']);
    await expect(git.push({ projectPath, remote: 'http' })).rejects.toMatchObject({
      code: 'GIT_MUTATION_OUTCOME_UNKNOWN', message: expect.stringContaining('503'),
    });
    expect(await listRefs(httpRepo)).toBe('');
    await runGit(projectPath, ['remote', 'set-url', 'http', url]);
    await expect(git.push({ projectPath, remote: 'http' })).rejects.toMatchObject({ code: 'GIT_MUTATION_OUTCOME_UNKNOWN' });
    expect(await listRefs(httpRepo)).toBe(`refs/heads/main ${await oid(projectPath)}\n`);

    await runGit(projectPath, ['commit', '--allow-empty', '-m', 'Advance HTTP receiver']);
    await installHook(remote, 'update', 'exit 1');
    await addOriginPushUrls(projectPath, remote, url);
    await expect(git.push({ projectPath })).rejects.toMatchObject({
      code: 'GIT_MUTATION_OUTCOME_UNKNOWN', message: expect.stringMatching(/hook declined[\s\S]*(?:protocol error|hung up)/i),
    });
    expect(await listRefs(remote)).toBe('');
    expect(await listRefs(httpRepo)).toBe(`refs/heads/main ${await oid(projectPath)}\n`);
  } finally { await server.stop(true); }
});

test('pushes the branch attached to the selected linked worktree', async () => {
  const { git, root, projectPath, remote } = await pushFixture();
  const linked = path.join(root, 'linked');
  await runGit(projectPath, ['worktree', 'add', '-b', 'side', linked]);
  await runGit(linked, ['commit', '--allow-empty', '-m', 'Linked tip']);
  await expect(git.push({ projectPath: linked, remoteBranch: 'main' })).rejects.toMatchObject({ code: 'GIT_INVALID_INPUT' });
  expect(await listRefs(remote)).toBe('');
  expect(await git.push({ projectPath: linked, remoteBranch: 'side' })).toMatchObject({ success: true });
  expect(await listRefs(remote)).toBe(`refs/heads/side ${await oid(linked)}\n`);
});

test('publishes the named submodule branch when on-demand recursion is configured', async () => {
  const { git, root, projectPath, remote } = await pushFixture();
  const childRemote = path.join(root, 'child.git');
  const child = path.join(projectPath, 'module');
  await runGit(root, ['init', '--bare', '-b', 'main', childRemote]);
  await runGit(projectPath, ['push', childRemote, 'refs/heads/main']);
  await runGit(projectPath, ['submodule', 'add', childRemote, 'module']);
  await runGit(projectPath, ['commit', '-m', 'Add submodule']);
  await runGit(child, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'Advance child']);
  await runGit(projectPath, ['add', 'module']);
  await runGit(projectPath, ['commit', '-m', 'Update submodule']);
  await runGit(projectPath, ['config', 'push.recurseSubmodules', 'on-demand']);
  expect(await git.push({ projectPath })).toMatchObject({ success: true });
  expect(await listRefs(remote)).toBe(`refs/heads/main ${await oid(projectPath)}\n`);
  expect(await listRefs(childRemote)).toBe(`refs/heads/main ${await oid(child)}\n`);
});
