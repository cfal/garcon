import { describe, expect, mock, test } from 'bun:test';
import { AcceptedInputSaga } from '../accepted-input-saga.ts';
import { ActiveInputDeliveryError, DomainError } from '../../lib/domain-error.ts';

function command(overrides = {}) {
  return {
    key: 'command-1',
    chatId: 'chat-1',
    clientRequestId: 'request-1',
    turnId: 'turn-1',
    entryId: 'entry-1',
    ...overrides,
  };
}

function control(overrides = {}) {
  return {
    version: 0,
    entries: [],
    pause: null,
    appliedCommands: [],
    recentlyDispatched: [],
    ...overrides,
  };
}

function settlement(overrides = {}) {
  return {
    markScheduled: mock(async () => undefined),
    markPreScheduleFailure: mock(async () => undefined),
    settleQueueMutation: mock(async () => undefined),
    settleQueueMutationFailure: mock(async () => undefined),
    settleActiveInput: mock(async () => undefined),
    settleActiveInputFailure: mock(async () => undefined),
    settleOperationFailure: mock(async () => undefined),
    ...overrides,
  };
}

// Builds the saga over its injected collaborators while exposing every mock
// flatly for assertions. Queue mutations map to the control operations, pending
// bookkeeping to the pending-input store, and the rest to the coordinator port.
function scaffold(overrides = {}) {
  const reservation = {
    chatId: 'chat-1',
    reservationId: 'reservation-1',
    executionAdmission: { signal: new AbortController().signal },
  };
  const m = {
    create: mock(async () => ({ entryId: 'entry-1', control: control(), duplicate: false })),
    replace: mock(async () => ({ entryId: 'entry-1', control: control(), duplicate: false })),
    delete: mock(async () => ({ entryId: 'entry-1', control: control(), duplicate: false })),
    read: mock(async () => control()),
    markFailed: mock(() => false),
    requestDrain: mock(() => undefined),
    reserveDirect: mock(() => reservation),
    checkpoint: mock(() => undefined),
    registerPending: mock(async () => undefined),
    releaseDirect: mock(async () => undefined),
    runDirect: mock(async () => undefined),
    trackDispatch: mock(() => undefined),
    deliverActive: mock(async () => false),
    hasAppliedCreate: mock(async () => false),
    ...overrides,
  };
  const saga = new AcceptedInputSaga({
    controls: { create: m.create, replace: m.replace, delete: m.delete, read: m.read },
    pendingInputs: { markFailed: m.markFailed },
    coordinator: {
      requestDrain: m.requestDrain,
      reserveDirect: m.reserveDirect,
      checkpoint: m.checkpoint,
      registerPending: m.registerPending,
      releaseDirect: m.releaseDirect,
      runDirect: m.runDirect,
      trackDispatch: m.trackDispatch,
      deliverActive: m.deliverActive,
      hasAppliedCreate: m.hasAppliedCreate,
    },
  });
  return { m, saga };
}

describe('AcceptedInputSaga', () => {
  test('settles an enqueue before requesting dispatch', async () => {
    const events = [];
    const settle = settlement({
      settleQueueMutation: mock(async () => { events.push('settled'); }),
    });
    const { saga, m } = scaffold({
      create: mock(async () => {
        events.push('created');
        return { entryId: 'entry-1', control: control(), duplicate: false };
      }),
      requestDrain: mock(() => { events.push('drain'); }),
    });

    await saga.enqueue({
      command: command(),
      content: 'queued',
      settlement: settle,
    });

    expect(events).toEqual(['created', 'settled', 'drain']);
    expect(m.create).toHaveBeenCalled();
  });

  test('records synchronous admission rejection without mutating the transcript', async () => {
    const busy = new DomainError('SESSION_BUSY', 'busy', 409, true);
    const settle = settlement();
    const { saga, m } = scaffold({ reserveDirect: mock(() => { throw busy; }) });

    await expect(saga.schedule({
      command: command(),
      content: 'direct',
      options: { clientRequestId: 'request-1', turnId: 'turn-1' },
      settlement: settle,
    })).rejects.toBe(busy);

    expect(m.registerPending).not.toHaveBeenCalled();
    expect(settle.markPreScheduleFailure).toHaveBeenCalledWith(command(), {
      error: busy,
      retryable: true,
    });
  });

  test('rolls back preparation before releasing admission on pre-schedule failure', async () => {
    const events = [];
    const registrationError = new Error('append failed');
    const settle = settlement({
      markPreScheduleFailure: mock(async () => { events.push('settled'); }),
    });
    const { saga } = scaffold({
      registerPending: mock(async () => { throw registrationError; }),
      markFailed: mock(() => true),
      releaseDirect: mock(async () => { events.push('released'); }),
    });

    await expect(saga.schedule({
      command: command(),
      content: 'direct',
      options: { clientRequestId: 'request-1', turnId: 'turn-1' },
      settlement: settle,
      preparation: {
        operation: 'fork-run',
        prepare: mock(async () => { events.push('prepared'); }),
        compensate: mock(async () => { events.push('compensated'); }),
      },
    })).rejects.toBe(registrationError);

    expect(events).toEqual(['prepared', 'compensated', 'released', 'settled']);
    expect(settle.markPreScheduleFailure).toHaveBeenCalledWith(command(), {
      error: registrationError,
      retryable: true,
      preserveForkPreparation: false,
    });
  });

  test('finishes initial-input compensation before execution admission is released', async () => {
    const events = [];
    const providerError = new Error('provider failed');
    const settle = settlement({
      settleOperationFailure: mock(async () => { events.push('settled'); }),
    });
    const { saga } = scaffold({
      runDirect: mock(async (_reservation, _content, _options, _dispatch, beforeFailureRelease) => {
        try {
          await beforeFailureRelease(providerError);
        } finally {
          events.push('released');
        }
        throw providerError;
      }),
    });

    await expect(saga.runInitial({
      command: command(),
      content: 'initial',
      options: { clientRequestId: 'request-1', turnId: 'turn-1' },
      settlement: settle,
      preparation: {
        operation: 'chat-start',
        prepare: mock(async () => undefined),
        compensate: mock(async () => { events.push('compensated'); }),
      },
    })).rejects.toBe(providerError);

    expect(events).toEqual(['compensated', 'settled', 'released']);
  });

  test('records an active delivery as ambiguous once the provider callback may have run', async () => {
    const providerError = new Error('connection lost');
    const settle = settlement();
    const { saga, m } = scaffold({
      deliverActive: mock(async () => {
        throw new ActiveInputDeliveryError(providerError, true);
      }),
    });

    await expect(saga.deliverActive({
      command: command(),
      content: 'interrupt',
      settlement: settle,
    })).rejects.toBeInstanceOf(ActiveInputDeliveryError);

    expect(settle.settleActiveInputFailure).toHaveBeenCalledWith(
      command(),
      expect.any(ActiveInputDeliveryError),
      true,
    );
    expect(m.create).not.toHaveBeenCalled();
  });
});
