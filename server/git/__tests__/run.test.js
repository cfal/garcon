import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { assertGitRepository, GitOutputLimitError, runGit } from '../run.js';

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
  let spawnMock;

  beforeEach(() => {
    originalSpawn = Bun.spawn;
    spawnMock = mock(() => ({
      stdout: textStream('ok\n'),
      stderr: textStream(''),
      exited: Promise.resolve(0),
      kill: mock(() => undefined),
    }));
    Bun.spawn = spawnMock;
  });

  afterEach(() => {
    Bun.spawn = originalSpawn;
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
