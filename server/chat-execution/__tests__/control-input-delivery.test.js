import { describe, expect, it, mock } from 'bun:test';
import {
  ControlInputBlockedError,
  ControlInputDelivery,
} from '../control-input-delivery.ts';
import { DomainError } from '../../lib/domain-error.ts';

function domainError(code) {
  return new DomainError(code, code, 409);
}

function capturedTarget(turnId = 'turn-1', waitUntilSettled = async () => undefined) {
  return {
    attempt: { waitUntilSettled },
    identity: { turnId },
    providerTarget: {},
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createHarness(overrides = {}) {
  const events = [];
  const captureTarget = mock(() => capturedTarget());
  const deliverSteer = mock(async () => { events.push('steer'); });
  const scheduleRun = mock(async (_chatId, _content, _viewId, onReserved) => {
    events.push('run');
    onReserved('hidden-turn');
  });
  const watchRouteChange = mock(() => ({
    promise: new Promise(() => undefined),
    cancel: mock(() => undefined),
  }));
  const options = {
    captureTarget,
    deliverSteer,
    scheduleRun,
    watchRouteChange,
    ...overrides,
  };
  const delivery = new ControlInputDelivery(options);
  return {
    ...options,
    controller: new AbortController(),
    delivery,
    events,
    onHiddenRun: mock(() => undefined),
  };
}

function deliver(harness) {
  return harness.delivery.deliver(
    'chat-1',
    'control',
    'view-1',
    harness.controller.signal,
    harness.onHiddenRun,
  );
}

describe('ControlInputDelivery', () => {
  it('uses the active steer route when it is accepted', async () => {
    const harness = createHarness();

    await deliver(harness);

    expect(harness.events).toEqual(['steer']);
    expect(harness.scheduleRun).not.toHaveBeenCalled();
  });

  it('starts a hidden turn after the rejected attempt settles', async () => {
    const events = [];
    const harness = createHarness({
      captureTarget: mock()
        .mockImplementationOnce(() => capturedTarget())
        .mockImplementation(() => null),
      deliverSteer: mock(async () => {
        events.push('steer');
        throw domainError('STEER_TURN_CHANGED');
      }),
      scheduleRun: mock(async (_chatId, _content, _viewId, onReserved) => {
        events.push('run');
        onReserved('hidden-turn');
      }),
    });

    await deliver(harness);

    expect(events).toEqual(['steer', 'run']);
    expect(harness.onHiddenRun).toHaveBeenCalledWith('hidden-turn');
  });

  it('retries steering when a new turn races with direct admission', async () => {
    const events = [];
    const harness = createHarness({
      captureTarget: mock()
        .mockImplementationOnce(() => null)
        .mockImplementationOnce(() => capturedTarget('turn-2')),
      deliverSteer: mock(async () => { events.push('steer'); }),
      scheduleRun: mock(async () => {
        events.push('run');
        throw domainError('SESSION_BUSY');
      }),
    });

    await deliver(harness);

    expect(events).toEqual(['run', 'steer']);
  });

  it('waits for a queued successor after transient direct-admission contention', async () => {
    const routeChange = deferred();
    const cancel = mock(() => undefined);
    const events = [];
    const harness = createHarness({
      captureTarget: mock()
        .mockImplementationOnce(() => null)
        .mockImplementationOnce(() => null)
        .mockImplementation(() => capturedTarget('turn-2')),
      deliverSteer: mock(async () => { events.push('steer'); }),
      scheduleRun: mock(async () => {
        events.push('run');
        throw domainError('SESSION_BUSY');
      }),
      watchRouteChange: mock(() => ({ promise: routeChange.promise, cancel })),
    });

    const result = deliver(harness);
    await Promise.resolve();
    expect(events).toEqual(['run']);

    routeChange.resolve();
    await result;

    expect(events).toEqual(['run', 'steer']);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('does not consume the route watch after acquiring direct ownership', async () => {
    const routeChange = deferred();
    const cancel = mock(() => undefined);
    const events = [];
    const scheduleRun = mock(async (
      _chatId,
      _content,
      _viewId,
      onReserved,
      onOwnershipAcquired,
    ) => {
      events.push('run');
      onOwnershipAcquired();
      if (scheduleRun.mock.calls.length === 1) throw domainError('SESSION_BUSY');
      onReserved('hidden-turn');
    });
    const harness = createHarness({
      captureTarget: mock(() => null),
      scheduleRun,
      watchRouteChange: mock(() => ({ promise: routeChange.promise, cancel })),
    });

    await deliver(harness);

    expect(events).toEqual(['run', 'run']);
    expect(cancel).toHaveBeenCalledTimes(2);
  });

  it('reports unsupported after bounded unsupported active turns', async () => {
    const waitUntilSettled = mock(async () => undefined);
    const harness = createHarness({
      captureTarget: mock(() => capturedTarget('turn-1', waitUntilSettled)),
      deliverSteer: mock(async () => { throw domainError('OPERATION_UNSUPPORTED'); }),
    });

    await expect(deliver(harness)).rejects.toMatchObject({
      code: 'OPERATION_UNSUPPORTED',
    });
    expect(harness.deliverSteer).toHaveBeenCalledTimes(3);
    expect(waitUntilSettled).toHaveBeenCalledTimes(2);
    expect(harness.scheduleRun).not.toHaveBeenCalled();
  });

  it('does not open a route watch after the final busy run attempt', async () => {
    const cancel = mock(() => undefined);
    const harness = createHarness({
      captureTarget: mock(() => null),
      scheduleRun: mock(async () => { throw domainError('SESSION_BUSY'); }),
      watchRouteChange: mock(() => ({ promise: Promise.resolve(), cancel })),
    });

    await expect(deliver(harness)).rejects.toMatchObject({ code: 'SESSION_BUSY' });
    expect(harness.scheduleRun).toHaveBeenCalledTimes(3);
    expect(harness.watchRouteChange).toHaveBeenCalledTimes(2);
    expect(cancel).toHaveBeenCalledTimes(2);
  });

  it('reports a blocked run after steering proves unsupported', async () => {
    const harness = createHarness({
      captureTarget: mock()
        .mockImplementationOnce(() => capturedTarget())
        .mockImplementation(() => null),
      deliverSteer: mock(async () => { throw domainError('OPERATION_UNSUPPORTED'); }),
      scheduleRun: mock(async () => { throw new ControlInputBlockedError(); }),
    });

    await expect(deliver(harness)).rejects.toBeInstanceOf(ControlInputBlockedError);
    expect(harness.deliverSteer).toHaveBeenCalledTimes(1);
    expect(harness.scheduleRun).toHaveBeenCalledTimes(1);
  });

  it('reports busy without retrying an unchanged blocked hidden run', async () => {
    const harness = createHarness({
      captureTarget: mock(() => null),
      scheduleRun: mock(async () => { throw new ControlInputBlockedError(); }),
    });

    await expect(deliver(harness)).rejects.toMatchObject({ code: 'SESSION_BUSY' });
    expect(harness.scheduleRun).toHaveBeenCalledTimes(1);
  });

  it('does not retry an ambiguous provider delivery failure', async () => {
    const failure = domainError('STEER_OUTCOME_UNKNOWN');
    const harness = createHarness({
      deliverSteer: mock(async () => { throw failure; }),
    });

    await expect(deliver(harness)).rejects.toBe(failure);
    expect(harness.scheduleRun).not.toHaveBeenCalled();
  });

  it('aborts while waiting for an active attempt to settle', async () => {
    const waiting = new Promise(() => undefined);
    const harness = createHarness({
      captureTarget: mock(() => capturedTarget('turn-1', () => waiting)),
      deliverSteer: mock(async () => { throw domainError('STEER_TURN_CHANGED'); }),
    });

    const result = deliver(harness);
    harness.controller.abort(new Error('chat deleted'));

    await expect(result).rejects.toThrow('chat deleted');
    expect(harness.scheduleRun).not.toHaveBeenCalled();
  });

  it('cancels a route-change watch when delivery is aborted', async () => {
    const routeChange = deferred();
    const cancel = mock(() => undefined);
    const harness = createHarness({
      captureTarget: mock(() => null),
      scheduleRun: mock(async () => { throw domainError('SESSION_BUSY'); }),
      watchRouteChange: mock(() => ({ promise: routeChange.promise, cancel })),
    });

    const result = deliver(harness);
    await Promise.resolve();
    harness.controller.abort(new Error('view replaced'));

    await expect(result).rejects.toThrow('view replaced');
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
