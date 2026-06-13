import { describe, expect, it, mock } from 'bun:test';
import { abortRunningSessionsWithTimeout } from '../shutdown.js';

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
