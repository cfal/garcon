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
    recoveredInputContinuation: null,
    appliedCommands: [],
    recentlyDispatchedEntryIds: [],
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
    listUnsettledQueueReceiptKeys: mock(async () => new Set()),
    ...overrides,
  };
}

function host(overrides = {}) {
  const reservation = {
    chatId: 'chat-1',
    reservationId: 'reservation-1',
    executionAdmission: { signal: new AbortController().signal },
  };
  return {
    createQueueEntry: mock(async () => ({ entryId: 'entry-1', control: control(), duplicate: false })),
    replaceQueueEntry: mock(async () => ({ entryId: 'entry-1', control: control(), duplicate: false })),
    deleteQueueEntry: mock(async () => ({ entryId: 'entry-1', control: control(), duplicate: false })),
    requestDrain: mock(() => undefined),
    reserveDirect: mock(() => reservation),
    checkpoint: mock(() => undefined),
    consumeRecoveredInput: mock(async () => undefined),
    readControl: mock(async () => control()),
    registerPending: mock(async () => undefined),
    markPendingFailed: mock(() => false),
    releaseDirect: mock(async () => undefined),
    runDirect: mock(async () => undefined),
    trackDispatch: mock(() => undefined),
    deliverActive: mock(async () => false),
    hasAppliedCreate: mock(async () => false),
    ...overrides,
  };
}

describe('AcceptedInputSaga', () => {
  test('settles a durable enqueue before requesting dispatch', async () => {
    const events = [];
    const settle = settlement({
      listUnsettledQueueReceiptKeys: mock(async () => {
        events.push('receipts');
        return new Set(['protected']);
      }),
      settleQueueMutation: mock(async () => { events.push('settled'); }),
    });
    const sagaHost = host({
      createQueueEntry: mock(async (_chatId, _content, _command, receipts) => {
        events.push(`created:${[...receipts.protectedKeys].join(',')}`);
        return { entryId: 'entry-1', control: control(), duplicate: false };
      }),
      requestDrain: mock(() => { events.push('drain'); }),
    });

    await new AcceptedInputSaga(sagaHost).enqueue({
      command: command(),
      content: 'queued',
      settlement: settle,
    });

    expect(events).toEqual(['receipts', 'created:protected', 'settled', 'drain']);
  });

  test('records synchronous admission rejection without mutating the transcript', async () => {
    const busy = new DomainError('SESSION_BUSY', 'busy', 409, true);
    const settle = settlement();
    const sagaHost = host({ reserveDirect: mock(() => { throw busy; }) });

    await expect(new AcceptedInputSaga(sagaHost).schedule({
      command: command(),
      content: 'direct',
      options: { clientRequestId: 'request-1', turnId: 'turn-1' },
      settlement: settle,
    })).rejects.toBe(busy);

    expect(sagaHost.registerPending).not.toHaveBeenCalled();
    expect(settle.markPreScheduleFailure).toHaveBeenCalledWith(command(), {
      error: busy,
      pendingInputRecovery: false,
      retryable: true,
    });
  });

  test('rolls back preparation before releasing admission on pre-schedule failure', async () => {
    const events = [];
    const registrationError = new Error('append failed');
    const settle = settlement({
      markPreScheduleFailure: mock(async () => { events.push('settled'); }),
    });
    const sagaHost = host({
      registerPending: mock(async () => { throw registrationError; }),
      markPendingFailed: mock(() => true),
      releaseDirect: mock(async () => { events.push('released'); }),
    });

    await expect(new AcceptedInputSaga(sagaHost).schedule({
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
      pendingInputRecovery: true,
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
    const sagaHost = host({
      runDirect: mock(async (_reservation, _content, _options, _dispatch, beforeFailureRelease) => {
        try {
          await beforeFailureRelease(providerError);
        } finally {
          events.push('released');
        }
        throw providerError;
      }),
    });

    await expect(new AcceptedInputSaga(sagaHost).runInitial({
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
    const sagaHost = host({
      deliverActive: mock(async () => {
        throw new ActiveInputDeliveryError(providerError, true);
      }),
    });

    await expect(new AcceptedInputSaga(sagaHost).deliverActive({
      command: command(),
      content: 'interrupt',
      settlement: settle,
    })).rejects.toBeInstanceOf(ActiveInputDeliveryError);

    expect(settle.settleActiveInputFailure).toHaveBeenCalledWith(
      command(),
      expect.any(ActiveInputDeliveryError),
      true,
    );
    expect(sagaHost.createQueueEntry).not.toHaveBeenCalled();
  });
});
