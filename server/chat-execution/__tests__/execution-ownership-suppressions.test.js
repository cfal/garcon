import { describe, expect, test } from 'bun:test';
import { ExecutionOwnership } from '../execution-ownership.ts';

// Pins the drain-suppression transitions that gate the queue dispatch loop. The
// manual-stop hold is the regression-prone one: a stop taken while a drain is
// still running must keep the hold so the drain observes the stop and exits,
// while every other exit releases it.
describe('ExecutionOwnership drain suppressions', () => {
  test('abort suppression enters and clears independently', () => {
    const ownership = new ExecutionOwnership();
    expect(ownership.hasSuppression('c1', 'abort')).toBe(false);
    ownership.enterAbortSuppression('c1');
    expect(ownership.hasSuppression('c1', 'abort')).toBe(true);
    ownership.clearAbortSuppression('c1');
    expect(ownership.hasSuppression('c1', 'abort')).toBe(false);
  });

  test('deletion suppression enters and clears independently', () => {
    const ownership = new ExecutionOwnership();
    ownership.enterDeletionSuppression('c1');
    expect(ownership.hasSuppression('c1', 'deletion')).toBe(true);
    ownership.clearDeletionSuppression('c1');
    expect(ownership.hasSuppression('c1', 'deletion')).toBe(false);
  });

  test('manual stop while idle is released on exit', () => {
    const ownership = new ExecutionOwnership();
    ownership.enterManualStop('c1');
    expect(ownership.hasSuppression('c1', 'manual-stop')).toBe(true);
    ownership.exitManualStop('c1', { drainStillActive: false });
    expect(ownership.hasSuppression('c1', 'manual-stop')).toBe(false);
  });

  test('manual stop is retained while a predating drain is still active', () => {
    const ownership = new ExecutionOwnership();
    ownership.enterManualStop('c1');
    ownership.exitManualStop('c1', { drainStillActive: true });
    expect(ownership.hasSuppression('c1', 'manual-stop')).toBe(true);
    ownership.exitManualStop('c1', { drainStillActive: false });
    expect(ownership.hasSuppression('c1', 'manual-stop')).toBe(false);
  });

  test('stop-then-resume clears both abort and manual-stop holds', () => {
    const ownership = new ExecutionOwnership();
    ownership.enterAbortSuppression('c1');
    ownership.enterManualStop('c1');
    // Resume path releases abort, and the idle exit releases the manual hold.
    ownership.clearAbortSuppression('c1');
    ownership.exitManualStop('c1', { drainStillActive: false });
    expect(ownership.hasSuppression('c1', 'abort')).toBe(false);
    expect(ownership.hasSuppression('c1', 'manual-stop')).toBe(false);
  });

  test('holds are scoped per chat', () => {
    const ownership = new ExecutionOwnership();
    ownership.enterManualStop('c1');
    ownership.enterDeletionSuppression('c2');
    expect(ownership.hasSuppression('c2', 'manual-stop')).toBe(false);
    expect(ownership.hasSuppression('c1', 'deletion')).toBe(false);
    expect(ownership.hasSuppression('c1', 'manual-stop')).toBe(true);
    expect(ownership.hasSuppression('c2', 'deletion')).toBe(true);
  });
});
