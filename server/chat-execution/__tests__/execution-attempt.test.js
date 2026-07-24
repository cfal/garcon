import { describe, expect, test } from 'bun:test';
import { QueueExecutionAttempt } from '../execution-attempt.ts';

const terminalHandoff = () => ({
  validate: () => undefined,
  commit: () => undefined,
});

// Resolves a wait promise against a sentinel so a still-pending wait is
// observable without hanging the test.
const PENDING = Symbol('pending');
async function settledValue(promise) {
  return Promise.race([promise, Promise.resolve().then(() => Promise.resolve().then(() => PENDING))]);
}

describe('QueueExecutionAttempt', () => {
  test('reserved (no entry) resolves registration immediately and gates launch', async () => {
    const attempt = new QueueExecutionAttempt({ turnId: 't' });
    expect(attempt.isSettled).toBe(false);
    expect(attempt.isRunSettled).toBe(false);
    expect(attempt.isSettlementReady).toBe(false);
    expect(await attempt.waitUntilRegistered()).toBe(true);

    const launch = attempt.waitForLaunchDecision();
    expect(await settledValue(launch)).toBe(PENDING);
    attempt.allowLaunch();
    expect(await launch).toBe(true);
  });

  test('dispatch happy path advances phases and settlement readiness', async () => {
    const attempt = new QueueExecutionAttempt({ turnId: 't' }, 'e1');
    const registered = attempt.waitUntilRegistered();
    expect(await settledValue(registered)).toBe(PENDING);

    attempt.markRegistered();
    expect(await registered).toBe(true);

    attempt.markLaunching();
    const abortable = attempt.waitUntilAbortable();
    attempt.markAbortable();
    expect(await abortable).toBe(true);

    attempt.markRunSettled();
    expect(attempt.isRunSettled).toBe(true);
    expect(attempt.isSettlementReady).toBe(false);
    attempt.markTerminalObserved();
    expect(attempt.isSettlementReady).toBe(true);

    const settled = attempt.waitUntilSettled();
    attempt.markSettled();
    await settled;
    expect(attempt.isSettled).toBe(true);
  });

  test('settling from registering resolves outstanding waits false', async () => {
    const attempt = new QueueExecutionAttempt({ turnId: 't' }, 'e1');
    const registered = attempt.waitUntilRegistered();
    const abortable = attempt.waitUntilAbortable();
    const launch = attempt.waitForLaunchDecision();

    attempt.markSettled();

    expect(await registered).toBe(false);
    expect(await abortable).toBe(false);
    expect(await launch).toBe(false);
    expect(attempt.isSettled).toBe(true);
  });

  test('allowLaunch after registration wins over a later settle', async () => {
    const attempt = new QueueExecutionAttempt({ turnId: 't' }, 'e1');
    attempt.markRegistered();
    expect(await attempt.waitUntilRegistered()).toBe(true);

    const launch = attempt.waitForLaunchDecision();
    attempt.allowLaunch();
    expect(await launch).toBe(true);
    attempt.markSettled();
    // A launch decision already resolved true stays true.
    expect(await launch).toBe(true);
  });

  test('abortable resolves false when settled before becoming abortable', async () => {
    const attempt = new QueueExecutionAttempt({ turnId: 't' }, 'e1');
    attempt.markRegistered();
    attempt.markLaunching();
    const abortable = attempt.waitUntilAbortable();
    attempt.markSettled();
    expect(await abortable).toBe(false);
  });

  test('waitForLaunchDecision resolves false on an aborted signal without settling', async () => {
    const attempt = new QueueExecutionAttempt({ turnId: 't' }, 'e1');
    attempt.markRegistered();
    const preAborted = new AbortController();
    preAborted.abort();
    expect(await attempt.waitForLaunchDecision(preAborted.signal)).toBe(false);

    const controller = new AbortController();
    const launch = attempt.waitForLaunchDecision(controller.signal);
    expect(await settledValue(launch)).toBe(PENDING);
    controller.abort();
    expect(await launch).toBe(false);
    // The attempt itself is not settled by an aborted wait.
    expect(attempt.isSettled).toBe(false);
  });

  test('expected-abort stop ids toggle the expected-abort flag', () => {
    const attempt = new QueueExecutionAttempt({ turnId: 't' }, 'e1');
    expect(attempt.isExpectedAbort).toBe(false);
    attempt.expectAbort('s1');
    attempt.expectAbort('s2');
    expect(attempt.isExpectedAbort).toBe(true);
    attempt.clearExpectedAbort('s1');
    expect(attempt.isExpectedAbort).toBe(true);
    attempt.clearExpectedAbort();
    expect(attempt.isExpectedAbort).toBe(false);
  });

  test('identity can be replaced only while reserved', () => {
    const attempt = new QueueExecutionAttempt({ turnId: 't' });
    attempt.replaceReservedTurn({ turnId: 't2' });
    expect(attempt.identity()).toEqual({ turnId: 't2' });
    attempt.markLaunching();
    expect(() => attempt.replaceReservedTurn({ turnId: 't3' })).toThrow();
  });

  test('hands off identity without resetting lifecycle signals', async () => {
    const attempt = new QueueExecutionAttempt({ turnId: 'turn-a' }, 'e1');
    attempt.markRegistered();
    attempt.allowLaunch();
    attempt.markAbortable();
    attempt.expectAbort('stop-1');
    attempt.markRunSettled();
    attempt.markTerminalObserved();

    const handoff = attempt.handoffTurn(
      { turnId: 'turn-a' },
      { clientRequestId: 'request-b', turnId: 'turn-b' },
      terminalHandoff(),
    );
    expect(attempt.identity()).toEqual({ turnId: 'turn-a' });
    handoff.validate();
    handoff.commit();

    expect(attempt.identity()).toEqual({ clientRequestId: 'request-b', turnId: 'turn-b' });
    expect(attempt.isExpectedAbort).toBe(true);
    expect(attempt.isRunSettled).toBe(true);
    expect(attempt.isSettlementReady).toBe(true);
    expect(await attempt.waitUntilAbortable()).toBe(true);
  });

  test('leaves the predecessor unchanged when downstream validation fails', () => {
    const attempt = new QueueExecutionAttempt({ turnId: 'turn-a' }, 'e1');

    const handoff = attempt.handoffTurn(
      { turnId: 'turn-a' },
      { turnId: 'turn-b' },
      {
        validate: () => { throw new Error('boundary failed'); },
        commit: () => undefined,
      },
    );
    expect(() => handoff.validate()).toThrow('boundary failed');

    expect(attempt.identity()).toEqual({ turnId: 'turn-a' });
  });

  test('rejects a stale handoff without changing the current identity', () => {
    const attempt = new QueueExecutionAttempt({ turnId: 'turn-b' }, 'e1');

    expect(() => attempt.handoffTurn(
      { turnId: 'turn-a' },
      { turnId: 'turn-c' },
      terminalHandoff(),
    )).toThrow('active turn changed');

    expect(attempt.identity()).toEqual({ turnId: 'turn-b' });
  });

  test('revalidates the predecessor immediately before commit', () => {
    const attempt = new QueueExecutionAttempt({ turnId: 'turn-a' });
    const handoff = attempt.handoffTurn(
      { turnId: 'turn-a' },
      { turnId: 'turn-b' },
      terminalHandoff(),
    );
    attempt.replaceReservedTurn({ turnId: 'turn-c' });

    expect(() => handoff.validate()).toThrow('active turn changed');
    expect(attempt.identity()).toEqual({ turnId: 'turn-c' });
  });

  test('matches compares turn identity', () => {
    const attempt = new QueueExecutionAttempt({ turnId: 't', clientRequestId: 'r' }, 'e1');
    expect(attempt.matches({ turnId: 't' })).toBe(true);
    expect(attempt.matches({ turnId: 'other' })).toBe(false);
    expect(attempt.matches(undefined)).toBe(false);
  });

  test('waitUntilSettled resolves immediately once already settled', async () => {
    const attempt = new QueueExecutionAttempt({ turnId: 't' }, 'e1');
    attempt.markSettled();
    await attempt.waitUntilSettled();
    expect(attempt.isSettled).toBe(true);
    // Late registration wait still resolves false after settle.
    expect(await attempt.waitUntilRegistered()).toBe(false);
    // Late launch wait resolves false after settle.
    expect(await attempt.waitForLaunchDecision()).toBe(false);
  });
});
