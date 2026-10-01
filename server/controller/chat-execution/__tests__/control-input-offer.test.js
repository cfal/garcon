import { describe, expect, it, mock } from 'bun:test';
import { DomainError } from '../../../common/domain-error.ts';
import { ControlInputDelivery } from '../control-input-delivery.ts';

function target() {
  const settlement = new Promise(() => undefined);
  return {
    identity: { turnId: 'turn-1' },
    providerTarget: {},
    attempt: { waitUntilSettled: mock(() => settlement) },
  };
}

function harness(deliverSteer = mock(async () => undefined)) {
  const options = {
    captureTarget: mock(async () => { throw new Error('must use captured target'); }),
    deliverSteer,
    scheduleRun: mock(async () => { throw new Error('must not schedule under caller lock'); }),
  };
  const delivery = new ControlInputDelivery(options);
  return {
    ...options,
    offer: (captured, signal = new AbortController().signal) => (
      delivery.offerToCapturedTarget('chat-1', 'control', 'view-1', captured, signal)
    ),
  };
}

describe('ControlInputDelivery captured offer', () => {
  it('returns delivered after one accepted captured-target steer', async () => {
    const delivery = harness();
    const captured = target();

    await expect(delivery.offer(captured)).resolves.toEqual({ kind: 'delivered' });

    expect(delivery.deliverSteer).toHaveBeenCalledTimes(1);
    expect(delivery.deliverSteer).toHaveBeenCalledWith('chat-1', 'control', 'view-1', captured);
    expect(captured.attempt.waitUntilSettled).not.toHaveBeenCalled();
    expect(delivery.captureTarget).not.toHaveBeenCalled();
    expect(delivery.scheduleRun).not.toHaveBeenCalled();
  });

  for (const code of [
    'STEER_TURN_UNAVAILABLE',
    'STEER_TURN_CHANGED',
    'STEER_TURN_NOT_STEERABLE',
    'OPERATION_UNSUPPORTED',
    'EXECUTOR_UNAVAILABLE',
    'STEER_NOT_DELIVERED',
  ]) {
    it(`returns the exact settlement promise without waiting after ${code}`, async () => {
      const captured = target();
      const delivery = harness(mock(async () => { throw new DomainError(code, 'not delivered'); }));

      const offer = await delivery.offer(captured);

      expect(offer.kind).toBe('after-turn');
      expect(captured.attempt.waitUntilSettled).toHaveBeenCalledTimes(1);
      expect(offer.turnSettled).toBe(captured.attempt.waitUntilSettled.mock.results[0].value);
      expect(delivery.scheduleRun).not.toHaveBeenCalled();
    });
  }

  it('returns settlement without dispatch when no provider target is available', async () => {
    const captured = { ...target(), providerTarget: null };
    const delivery = harness();

    const offer = await delivery.offer(captured);

    expect(offer.kind).toBe('after-turn');
    expect(captured.attempt.waitUntilSettled).toHaveBeenCalledTimes(1);
    expect(offer.turnSettled).toBe(captured.attempt.waitUntilSettled.mock.results[0].value);
    expect(delivery.deliverSteer).not.toHaveBeenCalled();
    expect(delivery.scheduleRun).not.toHaveBeenCalled();
  });

  for (const error of [
    new DomainError('STEER_OUTCOME_UNKNOWN', 'unknown'),
    new DomainError('STEER_PROVIDER_REJECTED', 'rejected'),
    new Error('unclassified'),
  ]) {
    it(`does not authorize fallback after ${error.message}`, async () => {
      const captured = target();
      const delivery = harness(mock(async () => { throw error; }));

      await expect(delivery.offer(captured)).rejects.toBe(error);

      expect(captured.attempt.waitUntilSettled).not.toHaveBeenCalled();
      expect(delivery.scheduleRun).not.toHaveBeenCalled();
    });
  }

  it('does not dispatch an already aborted offer', async () => {
    const delivery = harness();
    const captured = target();
    const reason = new Error('source replaced');

    await expect(delivery.offer(captured, AbortSignal.abort(reason))).rejects.toBe(reason);

    expect(delivery.deliverSteer).not.toHaveBeenCalled();
    expect(captured.attempt.waitUntilSettled).not.toHaveBeenCalled();
  });

  it('does not authorize fallback when aborted during a rejected steer', async () => {
    const abort = new AbortController();
    const reason = new Error('source replaced');
    const captured = target();
    const delivery = harness(mock(async () => {
      abort.abort(reason);
      throw new DomainError('STEER_TURN_CHANGED', 'changed');
    }));

    await expect(delivery.offer(captured, abort.signal)).rejects.toBe(reason);

    expect(captured.attempt.waitUntilSettled).not.toHaveBeenCalled();
    expect(delivery.scheduleRun).not.toHaveBeenCalled();
  });
});
