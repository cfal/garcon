import { describe, expect, test } from 'bun:test';
import { QueueExecutionAttempt } from '../execution-attempt.ts';

const terminalHandoff = (overrides = {}) => ({
  validate: overrides.validate ?? (() => undefined),
  commit: overrides.commit ?? (() => undefined),
});

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

  test('commits a goal-control handoff without resetting settlement', () => {
    const downstream = terminalHandoff();
    const attempt = new QueueExecutionAttempt({ turnId: 'turn-1' }, 'entry-1');
    attempt.markSettled();
    const handoff = attempt.handoffTurn(
      { turnId: 'turn-1' },
      { turnId: 'turn-2', clientRequestId: 'request-2' },
      downstream,
    );

    expect(attempt.identity()).toEqual({ turnId: 'turn-1' });
    handoff.validate();
    handoff.commit();

    expect(attempt.identity()).toEqual({ turnId: 'turn-2', clientRequestId: 'request-2' });
    expect(attempt.isSettled).toBe(true);
  });

  test('leaves the predecessor unchanged when downstream validation fails', () => {
    const attempt = new QueueExecutionAttempt({ turnId: 'turn-1' });
    const handoff = attempt.handoffTurn(
      { turnId: 'turn-1' },
      { turnId: 'turn-2' },
      terminalHandoff({ validate: () => { throw new Error('boundary failed'); } }),
    );

    expect(() => handoff.validate()).toThrow('boundary failed');
    expect(attempt.identity()).toEqual({ turnId: 'turn-1' });
  });

  test('rejects stale handoff validation before and after construction', () => {
    const attempt = new QueueExecutionAttempt({ turnId: 'turn-1' });
    expect(() => attempt.handoffTurn(
      { turnId: 'other' },
      { turnId: 'turn-2' },
      terminalHandoff(),
    )).toThrow('active turn changed');

    const handoff = attempt.handoffTurn(
      { turnId: 'turn-1' },
      { turnId: 'turn-2' },
      terminalHandoff(),
    );
    attempt.replaceReservedTurn({ turnId: 'turn-3' });
    expect(() => handoff.validate()).toThrow('active turn changed');
    expect(attempt.identity()).toEqual({ turnId: 'turn-3' });
  });
});
