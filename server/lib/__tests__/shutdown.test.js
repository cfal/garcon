import { describe, expect, it, mock } from 'bun:test';
import {
  abortRunningSessionsWithTimeout,
  shutdownExitCode,
  waitForShutdownPhasesWithTimeout,
  waitForShutdownTaskWithTimeout,
} from '../shutdown.js';

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('abortRunningSessionsWithTimeout', () => {
  it('awaits all running session aborts before completing', async () => {
    const aborted = [];
    const result = await abortRunningSessionsWithTimeout({
      runningSessions: {
        claude: [{ id: 'chat-1' }],
        codex: [{ id: 'chat-2' }],
      },
      abortSession: async (chatId) => {
        aborted.push(chatId);
      },
      timeoutMs: 50,
    });

    expect(result).toEqual({ attempted: 2, completed: true, timedOut: false });
    expect(aborted).toEqual(['chat-1', 'chat-2']);
  });

  it('returns after the timeout when an abort does not settle', async () => {
    const startedAt = Date.now();
    const result = await abortRunningSessionsWithTimeout({
      runningSessions: { claude: [{ id: 'chat-1' }] },
      abortSession: () => new Promise(() => {}),
      timeoutMs: 5,
    });

    expect(result).toEqual({ attempted: 1, completed: false, timedOut: true });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(5);
  });

  it('reports individual abort errors without rejecting the shutdown wait', async () => {
    const onAbortError = mock(() => undefined);
    const result = await abortRunningSessionsWithTimeout({
      runningSessions: { claude: [{ id: 'chat-1' }] },
      abortSession: async () => {
        throw new Error('interrupt failed');
      },
      timeoutMs: 50,
      onAbortError,
    });

    expect(result).toEqual({ attempted: 1, completed: true, timedOut: false });
    expect(onAbortError).toHaveBeenCalledTimes(1);
    expect(onAbortError.mock.calls[0][0]).toBe('chat-1');
    expect(onAbortError.mock.calls[0][1].message).toBe('interrupt failed');
  });

  it('ignores running session records without usable chat IDs', async () => {
    const abortSession = mock(async () => undefined);
    const result = await abortRunningSessionsWithTimeout({
      runningSessions: { claude: [{ id: null }, { id: '' }, {}] },
      abortSession,
    });

    expect(result).toEqual({ attempted: 0, completed: true, timedOut: false });
    expect(abortSession).not.toHaveBeenCalled();
  });
});

describe('shutdownExitCode', () => {
  it('returns non-zero for abort timeout or cleanup failure', () => {
    expect(shutdownExitCode({ abortTimedOut: false, cleanupFailed: false })).toBe(0);
    expect(shutdownExitCode({ abortTimedOut: true, cleanupFailed: false })).toBe(1);
    expect(shutdownExitCode({ abortTimedOut: false, cleanupFailed: true })).toBe(1);
  });
});

describe('waitForShutdownTaskWithTimeout', () => {
  it('reports whether command background work settled before shutdown', async () => {
    expect(await waitForShutdownTaskWithTimeout(Promise.resolve(), 50)).toBe(true);
    expect(await waitForShutdownTaskWithTimeout(new Promise(() => {}), 5)).toBe(false);
  });
});

describe('waitForShutdownPhasesWithTimeout', () => {
  it('starts recovery draining only after command producers settle', async () => {
    const commands = deferred();
    let recoveryStarted = false;
    const wait = waitForShutdownPhasesWithTimeout([
      () => commands.promise,
      async () => {
        recoveryStarted = true;
      },
    ], 50);

    await Promise.resolve();
    expect(recoveryStarted).toBe(false);
    commands.resolve();

    await expect(wait).resolves.toEqual({ completed: true, errors: [] });
    expect(recoveryStarted).toBe(true);
  });

  it('returns earlier failures after running later drain phases', async () => {
    let recoveryDrained = false;
    const wait = waitForShutdownPhasesWithTimeout([
      async () => {
        throw new Error('command task failed');
      },
      async () => {
        recoveryDrained = true;
      },
    ], 50);

    const result = await wait;

    expect(result.completed).toBe(true);
    expect(result.errors).toEqual([expect.objectContaining({ message: 'command task failed' })]);
    expect(recoveryDrained).toBe(true);
  });

  it('does not start a later phase after the shared deadline expires', async () => {
    const commands = deferred();
    let recoveryStarted = false;
    const wait = waitForShutdownPhasesWithTimeout([
      () => commands.promise,
      async () => {
        recoveryStarted = true;
      },
    ], 5);

    await expect(wait).resolves.toEqual({ completed: false, errors: [] });
    expect(recoveryStarted).toBe(false);
    commands.resolve();
    await Promise.resolve();
    expect(recoveryStarted).toBe(false);
  });
});
