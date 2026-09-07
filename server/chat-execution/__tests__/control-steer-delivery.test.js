import { describe, expect, it, mock } from 'bun:test';
import { DomainError } from '../../lib/domain-error.ts';
import { ControlSteerDelivery } from '../control-steer-delivery.ts';

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function target(settlement = Promise.resolve()) {
  return {
    identity: { turnId: 'turn-1' },
    providerTarget: null,
    attempt: {
      waitUntilSettled: mock(() => settlement),
    },
  };
}

describe('ControlSteerDelivery', () => {
  it('returns delivered after one accepted captured-target steer', async () => {
    const deliver = mock(async () => undefined);
    const steering = new ControlSteerDelivery(deliver);
    const captured = target();

    await expect(steering.toCapturedTarget(
      'chat-1',
      'control',
      'view-1',
      captured,
      new AbortController().signal,
    )).resolves.toBe('delivered');

    expect(deliver).toHaveBeenCalledTimes(1);
    expect(captured.attempt.waitUntilSettled).not.toHaveBeenCalled();
  });

  for (const code of [
    'STEER_TURN_UNAVAILABLE',
    'STEER_TURN_CHANGED',
    'STEER_TURN_NOT_STEERABLE',
    'OPERATION_UNSUPPORTED',
    'STEER_NOT_DELIVERED',
  ]) {
    it(`waits for exact-attempt settlement after ${code}`, async () => {
      const settled = deferred();
      const captured = target(settled.promise);
      const steering = new ControlSteerDelivery(mock(async () => {
        throw new DomainError(code, 'not delivered');
      }));

      const delivery = steering.toCapturedTarget(
        'chat-1',
        'control',
        'view-1',
        captured,
        new AbortController().signal,
      );
      let finished = false;
      void delivery.then(() => { finished = true; });
      await Promise.resolve();
      expect(finished).toBe(false);

      settled.resolve();
      await expect(delivery).resolves.toBe('definitive-non-delivery');
      expect(captured.attempt.waitUntilSettled).toHaveBeenCalledTimes(1);
    });
  }

  for (const code of ['STEER_OUTCOME_UNKNOWN', 'STEER_PROVIDER_REJECTED']) {
    it(`does not authorize fallback after ${code}`, async () => {
      const error = new DomainError(code, 'terminal');
      const captured = target();
      const steering = new ControlSteerDelivery(mock(async () => { throw error; }));

      await expect(steering.toCapturedTarget(
        'chat-1',
        'control',
        'view-1',
        captured,
        new AbortController().signal,
      )).rejects.toBe(error);
      expect(captured.attempt.waitUntilSettled).not.toHaveBeenCalled();
    });
  }

  it('aborts an exact-attempt settlement wait without authorizing fallback', async () => {
    const captured = target(new Promise(() => undefined));
    const steering = new ControlSteerDelivery(mock(async () => {
      throw new DomainError('STEER_TURN_CHANGED', 'changed');
    }));
    const abort = new AbortController();
    const reason = new Error('source replaced');

    const delivery = steering.toCapturedTarget(
      'chat-1',
      'control',
      'view-1',
      captured,
      abort.signal,
    );
    await Promise.resolve();
    abort.abort(reason);

    await expect(delivery).rejects.toBe(reason);
  });
});
