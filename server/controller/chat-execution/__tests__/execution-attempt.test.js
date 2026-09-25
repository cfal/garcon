import { describe, expect, test } from 'bun:test';
import { QueueExecutionAttempt } from '../execution-attempt.ts';

describe('QueueExecutionAttempt', () => {
  test('owns a defensive turn identity and matches partial turn references', () => {
    const turn = { turnId: 'turn-1', clientRequestId: 'request-1' };
    const attempt = new QueueExecutionAttempt(turn, 'entry-1');
    turn.turnId = 'mutated';
    const snapshot = attempt.identity();
    snapshot.turnId = 'also-mutated';

    expect(attempt.entryId).toBe('entry-1');
    expect(attempt.identity()).toEqual({ turnId: 'turn-1', clientRequestId: 'request-1' });
    expect(attempt.matches({ turnId: 'turn-1' })).toBe(true);
    expect(attempt.matches({ turnId: 'other' })).toBe(false);
    expect(attempt.matches(undefined)).toBe(false);
  });

  test('replaces an identity only before launch or settlement', () => {
    const attempt = new QueueExecutionAttempt({ turnId: 'turn-1' });
    attempt.replaceReservedTurn({ turnId: 'turn-2' });
    expect(attempt.identity()).toEqual({ turnId: 'turn-2' });

    attempt.markLaunching();
    expect(() => attempt.replaceReservedTurn({ turnId: 'turn-3' })).toThrow(
      'Cannot replace the identity of a launched turn',
    );
  });

  test('settles every current and future waiter exactly once', async () => {
    const attempt = new QueueExecutionAttempt({ turnId: 'turn-1' });
    let notifications = 0;
    const first = attempt.waitUntilSettled().then(() => { notifications += 1; });
    const second = attempt.waitUntilSettled().then(() => { notifications += 1; });

    attempt.markSettled();
    attempt.markSettled();
    await Promise.all([first, second, attempt.waitUntilSettled()]);

    expect(attempt.isSettled).toBe(true);
    expect(notifications).toBe(2);
  });

});
