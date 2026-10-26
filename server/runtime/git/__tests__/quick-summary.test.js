import { afterEach, describe, it, expect } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createGitOperations } from '../git-service.js';
import { createQuickSummaryOperations } from '../quick-summary.js';
import { runGitTraced } from '../run.js';
import { runGitCommand, initRepoWithCommit } from './repository-fixture.js';

describe('getQuickSummary', () => {
  const directories = [];
  const git = createGitOperations();

  async function repository(committed = true) {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-git-quick-'));
    directories.push(projectPath);
    if (committed) await initRepoWithCommit(projectPath);
    return projectPath;
  }

  afterEach(async () => {
    for (const dir of directories.splice(0)) await fs.rm(dir, { recursive: true, force: true });
  });

  it('reports tracked line totals and untracked presence without exact counts or fingerprints', async () => {
    const projectPath = await repository();
    await fs.writeFile(path.join(projectPath, 'a.txt'), 'one\ntwo\n');
    await fs.writeFile(path.join(projectPath, 'b.txt'), 'new\nfile\n');
    await runGitCommand(projectPath, ['add', 'b.txt']);
    await fs.writeFile(path.join(projectPath, 'c.txt'), 'loose\nline\n');

    expect(await git.getQuickSummary({ projectPath })).toEqual({
      status: 'ready', project: projectPath, branch: expect.any(String),
      hasChanges: true, hasUntracked: true, diffStats: { additions: 3, deletions: 0 },
    });
  });

  it('skips diffs and ignores ignored files in a clean repository', async () => {
    const projectPath = await repository();
    await fs.appendFile(path.join(projectPath, '.git/info/exclude'), '\nignored/\n');
    await fs.mkdir(path.join(projectPath, 'ignored'));
    await fs.writeFile(path.join(projectPath, 'ignored/cache'), 'not a change');
    const trace = [];

    expect(await git.getQuickSummary({ projectPath, trace })).toMatchObject({
      status: 'ready', hasChanges: false, hasUntracked: false,
      diffStats: { additions: 0, deletions: 0 },
    });
    expect(trace.some(({ args }) => args[0] === 'diff' || args[0] === 'ls-files')).toBe(false);
  });

  it('collapses deeply nested untracked artifacts instead of enumerating their files', async () => {
    const projectPath = await repository();
    const artifacts = path.join(projectPath, 'artifacts/nested/cache');
    await fs.mkdir(artifacts, { recursive: true });
    for (let i = 0; i < 200; i++) await fs.writeFile(path.join(artifacts, i + '.txt'), 'line\n');
    const trace = [];

    expect(await git.getQuickSummary({ projectPath, trace })).toMatchObject({
      status: 'ready', hasChanges: true, hasUntracked: true,
      diffStats: { additions: 0, deletions: 0 },
    });
    const status = trace.find(({ args }) => args[0] === 'status');
    expect(status.args).toContain('--untracked-files=normal');
    expect(status.stdoutBytes).toBe(Buffer.byteLength('?? artifacts/\0'));
    expect(trace.some(({ args }) => args[0] === 'diff')).toBe(false);
  });

  it('preserves an unborn branch and includes staged additions', async () => {
    const projectPath = await repository(false);
    await runGitCommand(projectPath, ['init', '-b', 'new-project']);
    await fs.writeFile(path.join(projectPath, 'a.txt'), 'new\n');
    await runGitCommand(projectPath, ['add', 'a.txt']);
    expect(await git.getQuickSummary({ projectPath })).toMatchObject({
      status: 'ready', branch: 'new-project', hasChanges: true, hasUntracked: false,
      diffStats: { additions: 1, deletions: 0 },
    });
  });

  it('labels detached HEAD with its short hash or matching tag', async () => {
    const projectPath = await repository();
    await runGitCommand(projectPath, ['checkout', '--detach']);
    const { stdout } = await runGitCommand(projectPath, ['rev-parse', '--short', 'HEAD']);
    expect((await git.getQuickSummary({ projectPath })).branch).toBe(stdout.trim());
    await runGitCommand(projectPath, ['tag', 'release']);
    expect((await git.getQuickSummary({ projectPath })).branch).toBe('release');
  });

  it('reports binary changes even with zero line totals', async () => {
    const projectPath = await repository();
    await fs.writeFile(path.join(projectPath, 'binary'), Buffer.from([0, 1, 2]));
    await runGitCommand(projectPath, ['add', 'binary']);
    expect(await git.getQuickSummary({ projectPath })).toMatchObject({
      hasChanges: true, hasUntracked: false, diffStats: { additions: 0, deletions: 0 },
    });
  });

  it('keeps change presence when optional diff totals fail', async () => {
    const projectPath = await repository();
    await fs.writeFile(path.join(projectPath, 'a.txt'), 'changed\n');
    const diffOptions = [];
    const bounded = createQuickSummaryOperations(async (cwd, args, trace, options) => {
      if (args[0] === 'diff') {
        diffOptions.push(options);
        throw new Error('Optional diff timed out');
      }
      return runGitTraced(cwd, args, trace, options);
    });
    expect(await bounded.getQuickSummary({ projectPath })).toMatchObject({
      status: 'ready', hasChanges: true, hasUntracked: false, diffStats: null,
    });
    expect(diffOptions).toHaveLength(2);
    for (const options of diffOptions) {
      expect(options.timeoutMs).toBe(2_000);
      expect(options.maxStdoutBytes).toBe(1024 * 1024);
    }
  });

  it('returns a typed non-repository response', async () => {
    const projectPath = await repository(false);
    expect(await git.getQuickSummary({ projectPath })).toEqual({
      status: 'not-git-repository', project: projectPath,
      message: 'Git is not initialized in this directory.',
    });
  });

  it('does not turn cancellation into a non-repository or optional-stat result', async () => {
    const projectPath = await repository();
    const controller = new AbortController();
    controller.abort();
    await expect(git.getQuickSummary({ projectPath, signal: controller.signal })).rejects.toThrow();
  });

  it('propagates cancellation during optional diff collection', async () => {
    const projectPath = await repository();
    await fs.writeFile(path.join(projectPath, 'a.txt'), 'changed\n');
    const controller = new AbortController();
    const cancelled = createQuickSummaryOperations(async (cwd, args, trace, options) => {
      if (args[0] === 'diff') controller.abort();
      return runGitTraced(cwd, args, trace, options);
    });
    await expect(cancelled.getQuickSummary({ projectPath, signal: controller.signal })).rejects.toThrow();
  });
});
