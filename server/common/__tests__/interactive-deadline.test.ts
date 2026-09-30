import { expect, spyOn, test } from 'bun:test';
import { INTERACTIVE_EXECUTOR_WAIT_MS, SENT_READ_GRACE_MS, interactiveDeadline, readBefore } from '../interactive-deadline.ts';

test('a read waits for a reconnecting executor until the deadline and may run a grace past it once sent', () => {
  let now = 1_000;
  const clock = spyOn(performance, 'now').mockImplementation(() => now);
  try {
    const signal = new AbortController().signal;
    const deadline = interactiveDeadline();
    expect(deadline).toBe(1_000 + INTERACTIVE_EXECUTOR_WAIT_MS);
    expect(readBefore(deadline, signal)).toEqual({
      signal, dispatchDeadline: deadline, timeoutMs: INTERACTIVE_EXECUTOR_WAIT_MS + SENT_READ_GRACE_MS,
    });

    // Past the deadline a read no longer waits for a session, and reads made one
    // after another share what is left of the grace instead of each getting it.
    now = deadline + 2_000;
    expect(readBefore(deadline, signal)).toEqual({ signal, dispatchDeadline: deadline, timeoutMs: SENT_READ_GRACE_MS - 2_000 });
    now = deadline + SENT_READ_GRACE_MS + 1;
    expect(readBefore(deadline, signal)).toEqual({ signal, dispatchDeadline: deadline, timeoutMs: 1 });
    expect(readBefore(undefined, signal)).toEqual({ signal });
  } finally {
    clock.mockRestore();
  }
});
