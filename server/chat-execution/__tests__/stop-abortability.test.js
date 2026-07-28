import { describe, expect, it, mock } from 'bun:test';
import { QueueExecutionAttempt } from '../execution-attempt.ts';
import { waitUntilStopAbortable } from '../stop-abortability.ts';

function deferred() {
  let resolve;
  const promise = new Promise((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe('waitUntilStopAbortable', () => {
  it('warns without timing out a turn that is still becoming abortable', async () => {
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const originalWarn = console.warn;
    const warn = mock(() => undefined);
    const abortable = deferred();
    let signal;
    let cleared = false;

    globalThis.setTimeout = (callback, delay) => {
      expect(delay).toBe(10_000);
      callback();
      return { unref: () => undefined };
    };
    globalThis.clearTimeout = () => {
      cleared = true;
    };
    console.warn = warn;

    try {
      const attempt = new QueueExecutionAttempt({ turnId: 'turn-1' });
      const wait = waitUntilStopAbortable(
        'chat-1',
        attempt,
        {
          waitUntilTurnAbortable: mock((_chatId, _turn, requestSignal) => {
            signal = requestSignal;
            return abortable.promise;
          }),
        },
        () => true,
      );
      let settled = false;
      void wait.then(() => {
        settled = true;
      });
      await Promise.resolve();

      expect(settled).toBe(false);
      expect(warn).toHaveBeenCalledWith(
        '[queue]',
        'queue: Stop waiting for abortability',
        {
          chatId: 'chat-1',
          attempt: { turnId: 'turn-1' },
          waitMs: expect.any(Number),
        },
      );

      abortable.resolve(true);
      await expect(wait).resolves.toBe(true);
      expect(cleared).toBe(true);
      expect(signal.aborted).toBe(true);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
      console.warn = originalWarn;
    }
  });
});
