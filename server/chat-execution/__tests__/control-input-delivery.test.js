import { describe, expect, it, mock } from 'bun:test';
import { ControlInputDelivery } from '../control-input-delivery.ts';
import { DomainError } from '../../lib/domain-error.ts';

function domainError(code) {
  return new DomainError(code, code, 409);
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function capturedTarget(turnId = 'turn-1', waitUntilSettled = async () => undefined) {
  return {
    attempt: { waitUntilSettled },
    identity: { turnId },
    providerTarget: {},
  };
}

function createHarness(overrides = {}) {
  const events = [];
  const captureTarget = mock(() => capturedTarget());
  const deliverSteer = mock(async () => { events.push('steer'); });
  const scheduleRun = mock(async (_chatId, _content, _viewId, onReserved) => {
    events.push('run');
    onReserved('control-turn');
  });
  const options = { captureTarget, deliverSteer, scheduleRun, ...overrides };
  return {
    ...options,
    controller: new AbortController(),
    delivery: new ControlInputDelivery(options),
    events,
    onControlRun: mock(() => undefined),
  };
}

function deliver(harness, emittingRunId = 'turn-1') {
  return harness.delivery.deliver(
    'chat-1',
    'control',
    'view-1',
    emittingRunId,
    harness.controller.signal,
    harness.onControlRun,
  );
}

describe('ControlInputDelivery', () => {
  it('uses the captured emitting-turn steer exactly once', async () => {
    const harness = createHarness();

    await deliver(harness);

    expect(harness.events).toEqual(['steer']);
    expect(harness.captureTarget).toHaveBeenCalledTimes(1);
    expect(harness.scheduleRun).not.toHaveBeenCalled();
  });

  it('schedules one direct run when no emitting turn is attributable', async () => {
    const harness = createHarness();

    await deliver(harness, null);

    expect(harness.events).toEqual(['run']);
    expect(harness.captureTarget).not.toHaveBeenCalled();
    expect(harness.onControlRun).toHaveBeenCalledWith('control-turn');
  });

  it('does not steer a mismatched successor turn', async () => {
    const harness = createHarness({
      captureTarget: mock(() => capturedTarget('turn-2')),
    });

    await deliver(harness);

    expect(harness.deliverSteer).not.toHaveBeenCalled();
    expect(harness.scheduleRun).toHaveBeenCalledTimes(1);
    expect(harness.captureTarget).toHaveBeenCalledTimes(1);
  });

  it('[TLV5-CHAT-ID-DISCOVERY.04-CORE-CONTROL-UNIT-01] waits for the rejected emitting attempt before one direct fallback', async () => {
    const settled = deferred();
    const events = [];
    const harness = createHarness({
      captureTarget: mock(() => capturedTarget('turn-1', () => settled.promise)),
      deliverSteer: mock(async () => {
        events.push('steer');
        throw domainError('STEER_TURN_CHANGED');
      }),
      scheduleRun: mock(async (_chatId, _content, _viewId, onReserved) => {
        events.push('run');
        onReserved('control-turn');
      }),
    });

    const result = deliver(harness);
    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual(['steer']);

    settled.resolve();
    await result;

    expect(events).toEqual(['steer', 'run']);
    expect(harness.captureTarget).toHaveBeenCalledTimes(1);
    expect(harness.deliverSteer).toHaveBeenCalledTimes(1);
    expect(harness.scheduleRun).toHaveBeenCalledTimes(1);
  });

  for (const code of [
    'STEER_TURN_UNAVAILABLE',
    'STEER_TURN_NOT_STEERABLE',
    'OPERATION_UNSUPPORTED',
    'STEER_NOT_DELIVERED',
  ]) {
    it(`uses one direct fallback after ${code}`, async () => {
      const waitUntilSettled = mock(async () => undefined);
      const harness = createHarness({
        captureTarget: mock(() => capturedTarget('turn-1', waitUntilSettled)),
        deliverSteer: mock(async () => { throw domainError(code); }),
      });

      await deliver(harness);

      expect(waitUntilSettled).toHaveBeenCalledTimes(1);
      expect(harness.scheduleRun).toHaveBeenCalledTimes(1);
    });
  }

  it('does not fall back after ambiguous delivery', async () => {
    const failure = domainError('STEER_OUTCOME_UNKNOWN');
    const harness = createHarness({
      deliverSteer: mock(async () => { throw failure; }),
    });

    await expect(deliver(harness)).rejects.toBe(failure);
    expect(harness.scheduleRun).not.toHaveBeenCalled();
  });

  it('does not retry a failed direct reservation', async () => {
    const failure = domainError('SESSION_BUSY');
    const harness = createHarness({
      captureTarget: mock(() => null),
      scheduleRun: mock(async () => { throw failure; }),
    });

    await expect(deliver(harness)).rejects.toBe(failure);
    expect(harness.captureTarget).toHaveBeenCalledTimes(1);
    expect(harness.scheduleRun).toHaveBeenCalledTimes(1);
  });

  it('aborts while waiting for the emitting attempt to settle', async () => {
    const harness = createHarness({
      captureTarget: mock(() => capturedTarget('turn-1', () => new Promise(() => undefined))),
      deliverSteer: mock(async () => { throw domainError('STEER_TURN_CHANGED'); }),
    });

    const result = deliver(harness);
    harness.controller.abort(new Error('chat deleted'));

    await expect(result).rejects.toThrow('chat deleted');
    expect(harness.scheduleRun).not.toHaveBeenCalled();
  });
});
