import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveRealWithinBase } from '../../lib/path-boundary.js';
import { inspectProjectDirectory } from '../../projects/project-directory-service.js';
import { runGit } from '../../git/run.js';
import { resolveTicketProjectDefault } from '../project-default.js';

describe('ticket project defaults', () => {
  let root;
  let options;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(homedir(), 'garcon-ticket-project-')));
    options = { inspect: (path) => inspectProjectDirectory(path, {
      resolvePath: (path) => resolveRealWithinBase(root, path),
    }) };
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  async function git(cwd, ...args) {
    return runGit(cwd, ['-c', 'user.name=Synthetic Author', '-c', 'user.email=author@example.invalid', ...args], {
      env: { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    });
  }
  async function repo(name, args = []) {
    const directory = join(root, name);
    mkdirSync(directory);
    await git(directory, 'init', ...args);
    await git(directory, 'commit', '--allow-empty', '-m', 'Synthetic initial commit');
    return directory;
  }
  const resolve = (directory, signal) => resolveTicketProjectDefault(directory, signal, options);

  test('groups base, linked worktree, subdirectory and symlink at the primary checkout', async () => {
    const base = await repo('base');
    const worktree = join(root, 'linked');
    await git(base, 'worktree', 'add', '-b', 'synthetic-work', worktree);
    const subdirectory = join(worktree, 'nested');
    mkdirSync(subdirectory);
    const alias = join(root, 'alias');
    symlinkSync(subdirectory, alias);
    for (const path of [base, worktree, subdirectory, alias]) {
      expect(await resolve(path)).toEqual({ project: base, kind: 'repository' });
    }
  });

  test('uses a configured primary checkout with separate Git storage and distinguishes clones', async () => {
    const base = await repo('separate', [`--separate-git-dir=${join(root, 'metadata')}`]);
    await git(base, 'config', 'core.worktree', '../separate');
    expect(await resolve(base)).toEqual({ project: base, kind: 'repository' });
    const clone = join(root, 'clone');
    await git(root, 'clone', base, clone);
    expect(await resolve(clone)).toEqual({ project: clone, kind: 'repository' });
  });

  test('falls back to each captured context when separate Git storage cannot identify its primary checkout', async () => {
    const base = await repo('separate', [`--separate-git-dir=${join(root, 'metadata')}`]);
    const linked = join(root, 'linked');
    await git(base, 'worktree', 'add', '-b', 'synthetic-linked', linked);
    const nested = join(linked, 'nested');
    mkdirSync(nested);
    for (const directory of [base, linked, nested]) {
      expect(await resolve(directory)).toEqual({ project: directory, kind: 'folder' });
    }
  });

  test('uses the shared bare directory and treats submodules independently', async () => {
    const bare = join(root, 'bare');
    await git(root, 'init', '--bare', bare);
    expect(await resolve(bare)).toEqual({ project: bare, kind: 'repository' });
    const source = await repo('module-source');
    const base = await repo('parent');
    await git(base, '-c', 'protocol.file.allow=always', 'submodule', 'add', source, 'module');
    expect(await resolve(join(base, 'module'))).toEqual({ project: join(base, 'module'), kind: 'repository' });
  });

  test('reads the main worktree configuration rather than a linked-worktree override', async () => {
    const base = await repo('configured', [`--separate-git-dir=${join(root, 'metadata')}`]);
    await git(base, 'config', 'core.worktree', '../configured');
    const linked = join(root, 'linked');
    await git(base, 'worktree', 'add', '-b', 'synthetic-linked', linked);
    await git(base, 'config', 'extensions.worktreeConfig', 'true');
    await git(base, 'config', '--worktree', 'core.worktree', base);
    await git(base, 'config', '--local', '--unset', 'core.worktree');
    await git(linked, 'config', '--worktree', 'core.worktree', linked);
    expect(await resolve(base)).toEqual({ project: base, kind: 'repository' });
    expect(await resolve(linked)).toEqual({ project: base, kind: 'repository' });
  });

  test('uses the canonical context for non-Git folders and broken Git metadata', async () => {
    const folder = join(root, 'plain folder');
    mkdirSync(folder);
    const alias = join(root, 'alias');
    symlinkSync(folder, alias);
    expect(await resolve(alias)).toEqual({ project: folder, kind: 'folder' });
    writeFileSync(join(folder, '.git'), 'gitdir: missing\n');
    expect(await resolve(alias)).toEqual({ project: folder, kind: 'folder' });
  });

  test('rejects unavailable, outside-base and control-containing contexts without leaking paths', async () => {
    const controlled = join(root, 'line\nbreak');
    mkdirSync(controlled);
    const alias = join(root, 'control-alias');
    symlinkSync(controlled, alias);
    for (const path of [join(root, 'absent'), homedir(), controlled, alias]) {
      try { await resolve(path); throw new Error('Expected rejection'); }
      catch (error) {
        expect(error.code).toBe('TICKET_PROJECT_UNAVAILABLE');
        expect(error.message).not.toContain(path);
      }
    }
  });

  test.each([' ', '\u00a0'])('rejects canonical contexts ending in %j without probing a trimmed sibling', async (suffix) => {
    const sibling = await repo('context');
    const directory = `${sibling}${suffix}`;
    mkdirSync(directory);
    const alias = join(root, 'context-alias');
    symlinkSync(directory, alias);
    const calls = [];
    for (const path of [directory, alias]) {
      await expect(resolveTicketProjectDefault(path, undefined, {
        ...options, git: async (cwd) => { calls.push(cwd); throw new Error('Unexpected Git probe'); },
      })).rejects.toMatchObject({ code: 'TICKET_PROJECT_UNAVAILABLE' });
    }
    expect(calls).toEqual([]);
  });

  test.each([' ', '\u00a0'])('falls back when the primary checkout ends in %j without substituting its sibling', async (suffix) => {
    await repo('primary');
    const base = await repo(`primary${suffix}`);
    const linked = join(root, 'linked');
    await git(base, 'worktree', 'add', '-b', 'synthetic-linked', linked);
    expect(await resolve(linked)).toEqual({ project: linked, kind: 'folder' });
  });

  test('falls back regardless of Git diagnostic wording or exit status', async () => {
    const boundary = 'fatal: not a git repository (or any parent up to mount point /)\n'
      + 'Stopping at filesystem boundary (GIT_DISCOVERY_ACROSS_FILESYSTEM not set).\n';
    const probe = (failure) => resolveTicketProjectDefault(root, undefined, {
      ...options, git: async () => { throw failure; },
    });
    expect(await probe({ code: 128, stderr: boundary })).toEqual({ project: root, kind: 'folder' });
    for (const failure of [
      { code: 128, stderr: boundary, timedOut: true },
      { code: 128, stderr: boundary, aborted: true },
      { code: 1, stderr: boundary },
      { code: 128, stderr: `${boundary}fatal: additional failure\n` },
    ]) {
      expect(await probe(failure)).toEqual({ project: root, kind: 'folder' });
    }
  });

  test('falls back on missing Git, permission errors, timeout, unsafe or malformed output within the probe bounds', async () => {
    const failures = [new Error('missing git'), { code: 'EACCES' },
      { code: 128, timedOut: true, stderr: 'fatal: not a git repository (or any of the parent directories): .git\n' },
      { code: 128, stderr: 'fatal: detected dubious ownership' }];
    for (const failure of failures) {
      expect(await resolveTicketProjectDefault(root, undefined, {
        ...options, git: async () => { throw failure; },
      })).toEqual({ project: root, kind: 'folder' });
    }
    const calls = [];
    expect(await resolveTicketProjectDefault(root, undefined, {
      ...options, git: async (_cwd, args, config) => {
        calls.push(config);
        if (args.includes('--git-common-dir')) return { stdout: `${root}\n`, stderr: '' };
        if (args.includes('--is-bare-repository')) return { stdout: 'false\n', stderr: '' };
        if (args.includes('config')) throw { code: 1, stdout: '', stderr: '' };
        return { stdout: `worktree ${root}\nHEAD abc\n`, stderr: '' };
      },
    })).toEqual({ project: root, kind: 'folder' });
    expect(calls).toHaveLength(4);
    for (const config of calls) {
      expect(config.env.LC_ALL).toBe('C');
      expect(config.disableOptionalLocks).toBe(true);
      expect(config.maxStdoutBytes).toBe(1024 * 1024);
      expect(config.timeoutMs).toBeLessThanOrEqual(5000);
      expect(config.signal).toBe(calls[0].signal);
    }
    expect(calls[3].timeoutMs).toBeLessThanOrEqual(calls[0].timeoutMs);
  });

  test('falls back when the discovered primary checkout is inaccessible', async () => {
    expect(await resolveTicketProjectDefault(root, undefined, {
      ...options, git: async (_cwd, args) => {
        if (args.includes('--git-common-dir')) return { stdout: `${root}\n`, stderr: '' };
        if (args.includes('--is-bare-repository')) return { stdout: 'false\n', stderr: '' };
        if (args.includes('config')) throw { code: 1, stdout: '', stderr: '' };
        return { stdout: `worktree ${join(root, 'absent')}\0HEAD abc\0\0`, stderr: '' };
      },
    })).toEqual({ project: root, kind: 'folder' });
  });

  test('honors cancellation before and during a probe', async () => {
    const controller = new AbortController();
    controller.abort(new Error('Synthetic abort'));
    await expect(resolve(root, controller.signal)).rejects.toThrow('Synthetic abort');
    const during = new AbortController();
    await expect(resolveTicketProjectDefault(root, during.signal, {
      ...options, git: async () => {
        during.abort(new Error('Synthetic mid-probe abort'));
        return { stdout: `${root}\n`, stderr: '' };
      },
    })).rejects.toThrow('Synthetic mid-probe abort');
  });
});
