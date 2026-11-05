import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runExactGit, runExactGitWithStdin } from '../exact-objects.js';
import {
  assertGitRepository,
  GitOutputLimitError,
  runGit,
  runGitWithStdin,
} from '../run.js';

function textStream(value) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(value));
      controller.close();
    },
  });
}

describe('runGit', () => {
  let originalSpawn;
  let originalKill;
  let spawnMock;

  beforeEach(() => {
    originalSpawn = Bun.spawn;
    originalKill = process.kill;
    spawnMock = mock(() => ({
      stdout: textStream('ok\n'),
      stderr: textStream(''),
      exited: Promise.resolve(0),
      kill: mock(() => undefined),
    }));
    Bun.spawn = (...args) => {
      if (args[0][0] === 'taskkill') {
        spawnMock.mock.results.at(-1).value.kill();
        return { exited: Promise.resolve(0) };
      }
      return Object.assign(spawnMock(...args), { pid: 424242 });
    };
    process.kill = mock((pid, signal) => {
      expect(pid).toBe(-424242);
      if (signal === 'SIGKILL') throw Object.assign(new Error('No remaining group'), { code: 'ESRCH' });
      spawnMock.mock.results.at(-1).value.kill();
      return true;
    });
  });

  afterEach(() => {
    Bun.spawn = originalSpawn;
    process.kill = originalKill;
  });

  it('sets GIT_OPTIONAL_LOCKS=0 when optional locks are disabled', async () => {
    await runGit('/repo', ['status', '--porcelain'], { disableOptionalLocks: true });

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0][1].env).toMatchObject({
      GIT_OPTIONAL_LOCKS: '0',
    });
  });

  it('does not set a custom environment by default', async () => {
    await runGit('/repo', ['add', '--', 'a.txt']);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0][1].env).toBeUndefined();
  });

  it('stops oversized stdout without retrying the process', async () => {
    const kill = mock(() => undefined);
    spawnMock.mockImplementation(() => ({
      stdout: textStream('output over limit'),
      stderr: textStream('diagnostic'),
      exited: Promise.resolve(1),
      kill,
    }));

    await expect(
      runGit('/repo', ['diff'], { maxStdoutBytes: 5 }),
    ).rejects.toBeInstanceOf(GitOutputLimitError);
    expect(kill).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('drains and truncates oversized stderr without failing a successful command', async () => {
    const kill = mock(() => undefined);
    spawnMock.mockImplementation(() => ({
      stdout: textStream('output'),
      stderr: textStream('diagnostic over limit'),
      exited: Promise.resolve(0),
      kill,
    }));

    await expect(
      runGit('/repo', ['status'], { maxStderrBytes: 5 }),
    ).resolves.toEqual({
      stdout: 'output',
      stderr: 'diagn',
    });
    expect(kill).not.toHaveBeenCalled();
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('enforces limits while draining real subprocess pipes', async () => {
    Bun.spawn = originalSpawn;
    process.kill = originalKill;
    const commandDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-fake-git-'));
    const fakeGitPath = path.join(commandDirectory, 'git');
    await fs.writeFile(fakeGitPath, `#!/usr/bin/env bun
const output = 'x'.repeat(4 * 1024 * 1024);
const stream = process.argv.includes('stderr-overflow') ? process.stderr : process.stdout;
stream.write(output);
`, { mode: 0o755 });
    const commandPath = `${commandDirectory}${path.delimiter}${process.env.PATH ?? ''}`;

    try {
      await expect(runGit(process.cwd(), ['stdout-overflow'], {
        env: { PATH: commandPath },
        maxStdoutBytes: 1024,
        timeoutMs: 5_000,
      })).rejects.toMatchObject({ stream: 'stdout', maxBytes: 1024 });
      await expect(runGit(process.cwd(), ['stderr-overflow'], {
        env: { PATH: commandPath },
        maxStderrBytes: 1024,
        timeoutMs: 5_000,
      })).resolves.toEqual({ stdout: '', stderr: 'x'.repeat(1024) });
    } finally {
      await fs.rm(commandDirectory, { recursive: true, force: true });
    }
  });

  it('captures stdout and enforces limits for stdin commands', async () => {
    spawnMock.mockImplementation(() => ({
      stdout: textStream('committed\n'),
      stderr: textStream(''),
      exited: Promise.resolve(0),
      kill: mock(() => undefined),
    }));

    await expect(
      runGitWithStdin('/repo', ['commit'], 'paths\0', { maxStdoutBytes: 5 }),
    ).rejects.toMatchObject({
      stream: 'stdout',
      maxBytes: 5,
    });
  });

  it('kills an active process and preserves caller abort metadata', async () => {
    let resolveExit;
    const exited = new Promise((resolve) => {
      resolveExit = resolve;
    });
    const kill = mock(() => resolveExit(143));
    spawnMock.mockImplementation(() => ({
      stdout: textStream(''),
      stderr: textStream(''),
      exited,
      kill,
    }));
    const controller = new AbortController();

    const result = runGit('/repo', ['for-each-ref'], {
      signal: controller.signal,
    });
    controller.abort();

    await expect(result).rejects.toMatchObject({ aborted: true });
    expect(kill).toHaveBeenCalledTimes(1);
  });

  it('reports a pre-aborted signal when spawn refuses to start the process', async () => {
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    spawnMock.mockImplementation(() => {
      throw abortError;
    });
    const controller = new AbortController();
    controller.abort();

    await expect(
      runGit('/repo', ['status'], { signal: controller.signal }),
    ).rejects.toMatchObject({ aborted: true, timedOut: false });
  });

  it('rethrows synchronous spawn failures that are not aborts', async () => {
    const spawnError = new Error('spawn failed');
    spawnMock.mockImplementation(() => {
      throw spawnError;
    });

    await expect(
      runGit('/repo', ['status']),
    ).rejects.toBe(spawnError);
  });

  it('spends one timeout budget across lock retries', async () => {
    const attemptTimes = [];
    spawnMock.mockImplementation(() => {
      attemptTimes.push(performance.now());
      return {
        stdout: textStream(''),
        stderr: textStream("fatal: Unable to create '.git/index.lock': File exists."),
        exited: Promise.resolve(128),
        kill: mock(() => undefined),
      };
    });

    const startedAt = performance.now();
    await expect(
      runGit('/repo', ['reset', 'HEAD', '--', 'a.txt'], { timeoutMs: 150 }),
    ).rejects.toMatchObject({
      timedOut: true,
      stderr: expect.stringContaining('index.lock'),
    });
    // Instant mock exits can squeeze extra attempts into the final fractional millisecond.
    expect(attemptTimes.length).toBeGreaterThanOrEqual(2);
    expect(attemptTimes[1] - attemptTimes[0]).toBeGreaterThanOrEqual(90);
    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(150);
    expect(performance.now() - startedAt).toBeLessThan(300);
  });

  it.each(['argv', 'stdin'])('never retries an exact-delivery %s command after a native lock error', async input => {
    spawnMock.mockImplementation(() => ({
      stdout: textStream(''),
      stderr: textStream("fatal: Unable to create '.git/index.lock': File exists."),
      exited: Promise.resolve(128),
      kill: mock(() => undefined),
    }));
    const result = input === 'argv' ? runExactGit('/repo', ['merge', 'a'.repeat(40)])
      : runExactGitWithStdin('/repo', ['update-ref', '--stdin'], 'start\nabort\n');
    await expect(result).rejects.toMatchObject({ code: 128 });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0][1].env).toMatchObject({ GIT_NO_REPLACE_OBJECTS: '1', GIT_GRAFT_FILE: os.devNull, GIT_NO_LAZY_FETCH: '1' });
  });

  it('keeps the lock retry delay inside the timeout budget', async () => {
    spawnMock.mockImplementation(() => ({
      stdout: textStream(''),
      stderr: textStream("fatal: Unable to create '.git/index.lock': File exists."),
      exited: Promise.resolve(128),
      kill: mock(() => undefined),
    }));

    const startedAt = performance.now();
    await expect(
      runGit('/repo', ['reset', 'HEAD', '--', 'a.txt'], { timeoutMs: 40 }),
    ).rejects.toMatchObject({ timedOut: true });
    // The delay used to sleep a full 100ms after the budget had already
    // expired, overshooting timeoutMs by more than double.
    expect(performance.now() - startedAt).toBeLessThan(90);
  });

  it('reports an already-aborted caller signal as aborted', async () => {
    const kill = mock(() => undefined);
    spawnMock.mockImplementation(() => ({
      stdout: textStream(''),
      stderr: textStream('error: operation was aborted'),
      exited: Promise.resolve(1),
      kill,
    }));
    const controller = new AbortController();
    controller.abort();

    await expect(
      runGit('/repo', ['status'], { signal: controller.signal }),
    ).rejects.toMatchObject({ aborted: true, timedOut: false });
  });

  it('reports a caller abort that fires during the lock retry delay as aborted', async () => {
    const controller = new AbortController();
    const kill = mock(() => undefined);
    let attempts = 0;
    spawnMock.mockImplementation(() => {
      attempts += 1;
      // The timer fires after the attempt settles and cleanup() detaches the
      // caller listener (microtasks drain before timers), but well before the
      // 100ms retry delay ends, so only the post-sleep signal recheck catches it.
      setTimeout(() => controller.abort(), 10);
      return {
        stdout: textStream(''),
        stderr: textStream("fatal: Unable to create '.git/index.lock': File exists."),
        exited: Promise.resolve(128),
        kill,
      };
    });

    await expect(
      runGit('/repo', ['reset', 'HEAD', '--', 'a.txt'], { signal: controller.signal }),
    ).rejects.toMatchObject({ aborted: true });
    expect(attempts).toBe(1);
    // An untouched kill proves the abort fired after cleanup detached the kill
    // listener, inside the retry delay rather than during the attempt.
    expect(kill).not.toHaveBeenCalled();
  });

  it('does not translate an aborted repository probe into a repository error', async () => {
    let resolveExit;
    let resolveSpawned;
    const exited = new Promise((resolve) => {
      resolveExit = resolve;
    });
    const spawned = new Promise((resolve) => {
      resolveSpawned = resolve;
    });
    const kill = mock(() => resolveExit(143));
    spawnMock.mockImplementation(() => {
      resolveSpawned();
      return {
        stdout: textStream(''),
        stderr: textStream(''),
        exited,
        kill,
      };
    });
    const controller = new AbortController();

    const result = assertGitRepository(process.cwd(), controller.signal);
    await spawned;
    controller.abort();

    await expect(result).rejects.toMatchObject({ aborted: true });
    expect(kill).toHaveBeenCalledTimes(1);
  });
});
