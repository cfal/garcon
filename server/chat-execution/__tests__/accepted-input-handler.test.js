import { describe, expect, mock, test } from 'bun:test';
import { AcceptedInputHandler } from '../accepted-input-handler.ts';
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
    reorderRevision: 0,
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

// Builds the handler over its injected collaborators while exposing every mock
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
    stageActiveFallback: mock(async () => ({
      entryId: 'entry-1',
      control: control({ entries: [{ id: 'entry-1', status: 'sending' }] }),
      duplicate: false,
    })),
    replace: mock(async () => ({ entryId: 'entry-1', control: control(), duplicate: false })),
    delete: mock(async () => ({ entryId: 'entry-1', control: control(), duplicate: false })),
    move: mock(async () => ({
      entryId: 'entry-1',
      control: control(),
      duplicate: false,
      rebased: false,
    })),
    removeSent: mock(async () => control()),
    returnUnsent: mock(async () => control({ entries: [{ id: 'entry-1', status: 'queued' }] })),
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
  const handler = new AcceptedInputHandler({
    controls: {
      create: m.create,
      stageActiveFallback: m.stageActiveFallback,
      replace: m.replace,
      delete: m.delete,
      move: m.move,
      removeSent: m.removeSent,
      returnUnsent: m.returnUnsent,
      read: m.read,
    },
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
  return { m, handler };
}

describe('AcceptedInputHandler', () => {
  test('settles an enqueue before requesting dispatch', async () => {
    const events = [];
    const settle = settlement({
      settleQueueMutation: mock(async () => { events.push('settled'); }),
    });
    const { handler, m } = scaffold({
      create: mock(async () => {
        events.push('created');
        return { entryId: 'entry-1', control: control(), duplicate: false };
      }),
      requestDrain: mock(() => { events.push('drain'); }),
    });

    await handler.enqueue({
      command: command(),
      content: 'queued',
      settlement: settle,
    });

    expect(events).toEqual(['created', 'settled', 'drain']);
    expect(m.create).toHaveBeenCalled();
  });

  test('settles a queue move with every concurrency precondition', async () => {
    const settle = settlement();
    const { handler, m } = scaffold();

    await expect(handler.move({
      command: command(),
      targetEntryId: 'entry-2',
      placement: 'before',
      expectedReorderRevision: 4,
      expectedSourceRevision: 2,
      expectedTargetRevision: 3,
      settlement: settle,
    })).resolves.toMatchObject({ entryId: 'entry-1', duplicate: false });

    expect(m.move).toHaveBeenCalledWith('chat-1', {
      entryId: 'entry-1',
      targetEntryId: 'entry-2',
      placement: 'before',
      expectedReorderRevision: 4,
      expectedSourceRevision: 2,
      expectedTargetRevision: 3,
    }, {
      key: 'command-1',
      entryId: 'entry-1',
    });
    expect(settle.settleQueueMutation).toHaveBeenCalledOnce();
  });

  test('records synchronous admission rejection without mutating the transcript', async () => {
    const busy = new DomainError('SESSION_BUSY', 'busy', 409, true);
    const settle = settlement();
    const { handler, m } = scaffold({ reserveDirect: mock(() => { throw busy; }) });

    await expect(handler.schedule({
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
    const { handler } = scaffold({
      registerPending: mock(async () => { throw registrationError; }),
      markFailed: mock(() => true),
      releaseDirect: mock(async () => { events.push('released'); }),
    });

    await expect(handler.schedule({
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
    const { handler } = scaffold({
      runDirect: mock(async (_reservation, _content, _options, _dispatch, beforeFailureRelease) => {
        try {
          await beforeFailureRelease(providerError);
        } finally {
          events.push('released');
        }
        throw providerError;
      }),
    });

    await expect(handler.runInitial({
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

  test('stages active input before provider handoff and retains it when confirmation fails', async () => {
    const providerError = new Error('connection lost');
    const settle = settlement();
    const { handler, m } = scaffold({
      deliverActive: mock(async (_chatId, _content, _options, beforeDelivery) => {
        await beforeDelivery();
        throw new ActiveInputDeliveryError(providerError, true);
      }),
    });

    await expect(handler.deliverActive({
      command: command(),
      content: 'interrupt',
      settlement: settle,
    })).rejects.toBeInstanceOf(ActiveInputDeliveryError);

    expect(settle.settleActiveInputFailure).toHaveBeenCalledWith(
      command(),
      expect.any(ActiveInputDeliveryError),
      true,
    );
    expect(m.stageActiveFallback).toHaveBeenCalledWith(
      'chat-1',
      'interrupt',
      { key: 'command-1', entryId: 'entry-1' },
      {
        clientRequestId: 'request-1',
        clientMessageId: 'entry-1',
        turnId: 'turn-1',
      },
    );
    expect(settle.markScheduled).toHaveBeenCalledWith(command(), 'turn-1');
    expect(m.removeSent).not.toHaveBeenCalled();
    expect(m.create).not.toHaveBeenCalled();
  });

  test('removes the staged fallback after confirmed active delivery', async () => {
    const events = [];
    const settle = settlement({
      markScheduled: mock(async () => { events.push('scheduled'); }),
      settleActiveInput: mock(async () => { events.push('settled'); }),
    });
    const { handler, m } = scaffold({
      stageActiveFallback: mock(async () => {
        events.push('staged');
        return { entryId: 'entry-1', control: control(), duplicate: false };
      }),
      deliverActive: mock(async (_chatId, _content, _options, beforeDelivery) => {
        await beforeDelivery();
        events.push('delivered');
        return true;
      }),
      removeSent: mock(async () => {
        events.push('removed');
        return control();
      }),
    });

    await expect(handler.deliverActive({
      command: command(),
      content: 'steer',
      settlement: settle,
    })).resolves.toMatchObject({ delivery: 'active' });

    expect(events).toEqual(['staged', 'scheduled', 'delivered', 'removed', 'settled']);
    expect(m.removeSent).toHaveBeenCalledWith('chat-1', 'entry-1');
  });

  test('requeues a staged active fallback exactly once during accepted-command recovery', async () => {
    const events = [];
    const queuedControl = control({ entries: [{ id: 'entry-1', status: 'queued' }] });
    const settle = settlement({
      settleQueueMutation: mock(async () => { events.push('settled'); }),
    });
    const { handler, m } = scaffold({
      hasAppliedCreate: mock(async () => true),
      returnUnsent: mock(async () => {
        events.push('requeued');
        return queuedControl;
      }),
      requestDrain: mock(() => { events.push('drain'); }),
    });

    await expect(handler.recoverActive({
      command: command(),
      content: 'recover',
      settlement: settle,
    })).resolves.toEqual({
      delivery: 'queued',
      entryId: 'entry-1',
      control: queuedControl,
    });

    expect(events).toEqual(['requeued', 'settled', 'drain']);
    expect(m.deliverActive).not.toHaveBeenCalled();
  });
});
