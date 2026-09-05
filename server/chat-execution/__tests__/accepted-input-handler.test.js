import { describe, expect, mock, test } from 'bun:test';
import { AcceptedInputHandler } from '../accepted-input-handler.ts';
import { DuplicateGoalControlInputError } from '../goal-control-delivery.ts';
import {
  DomainError,
  GoalControlDeliveryError,
  QueueEntrySteerError,
  SteerDeliveryError,
} from '../../lib/domain-error.ts';

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
    controlEntries: [],
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
    settleGoalControl: mock(async () => undefined),
    settleGoalControlFailure: mock(async () => undefined),
    settleSteerSuccess: mock(async () => undefined),
    settleSteerFailure: mock(async () => undefined),
    settleOperationFailure: mock(async () => undefined),
    settleDuplicateInput: mock(async () => undefined),
    ...overrides,
  };
}

function queueSteerInput(overrides = {}) {
  return {
    command: command(),
    content: 'observed queue content',
    providerContent: 'observed queue content\n\nresolved context',
    clientMessageId: 'message-steer',
    transcriptViewId: 'view-1',
    target: { attempt: {}, identity: { turnId: 'turn-current' }, providerTarget: null },
    expectedRevision: 2,
    expectedReorderRevision: 4,
    settlement: settlement(),
    ...overrides,
  };
}

// Builds the handler over its injected collaborators while exposing every mock
// flatly for assertions.
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
    move: mock(async () => ({
      entryId: 'entry-1',
      control: control(),
      duplicate: false,
      rebased: false,
    })),
    reserveSteer: mock(async () => ({
      entry: {
        id: 'entry-1',
        content: 'queued guidance',
        createdAt: '2026-08-02T00:00:00.000Z',
        revision: 2,
        status: 'steering',
      },
      control: control({
        entries: [{ id: 'entry-1', content: 'queued guidance', revision: 2, status: 'steering' }],
      }),
    })),
    releaseSteer: mock(async () => control({
      entries: [{ id: 'entry-1', content: 'queued guidance', revision: 2, status: 'queued' }],
    })),
    consumeSteer: mock(async () => control({ recentlyDispatched: [{
      entryId: 'entry-1',
      revision: 2,
      dispatchedAt: '2026-08-02T00:00:01.000Z',
    }] })),
    requeueAndPause: mock(async () => control({
      entries: [{ id: 'entry-1', content: 'queued guidance', revision: 2, status: 'queued' }],
      pause: { kind: 'completion-uncertain', entryId: 'entry-1' },
    })),
    read: mock(async () => control()),
    requestDrain: mock(() => undefined),
    reserveDirect: mock(() => reservation),
    checkpoint: mock(() => undefined),
    admitInput: mock(async () => true),
    discardPreparedInput: mock(() => undefined),
    releaseDirect: mock(async () => undefined),
    runDirect: mock(async () => undefined),
    trackDispatch: mock(() => undefined),
    deliverGoalControl: mock(async () => false),
    steer: mock(async () => ({ turnId: 'turn-1' })),
    ...overrides,
  };
  const handler = new AcceptedInputHandler({
    controls: {
      create: m.create,
      replace: m.replace,
      delete: m.delete,
      move: m.move,
      reserveSteer: m.reserveSteer,
      releaseSteer: m.releaseSteer,
      consumeSteer: m.consumeSteer,
      requeueAndPause: m.requeueAndPause,
      read: m.read,
    },
    coordinator: {
      requestDrain: m.requestDrain,
      reserveDirect: m.reserveDirect,
      checkpoint: m.checkpoint,
      admitInput: m.admitInput,
      discardPreparedInput: m.discardPreparedInput,
      releaseDirect: m.releaseDirect,
      runDirect: m.runDirect,
      trackDispatch: m.trackDispatch,
      deliverGoalControl: m.deliverGoalControl,
      steer: m.steer,
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

    expect(m.admitInput).not.toHaveBeenCalled();
    expect(settle.markPreScheduleFailure).toHaveBeenCalledWith(command(), {
      error: busy,
      retryable: true,
    });
  });

  test('settles a committed duplicate without dispatching it again', async () => {
    const settle = settlement();
    const { handler, m } = scaffold({
      admitInput: mock(async () => false),
    });

    await handler.schedule({
      command: command(),
      content: 'already committed',
      options: { clientRequestId: 'request-1', turnId: 'turn-1' },
      settlement: settle,
    });

    expect(settle.settleDuplicateInput).toHaveBeenCalledWith(command());
    expect(m.releaseDirect).toHaveBeenCalledOnce();
    expect(m.runDirect).not.toHaveBeenCalled();
    expect(settle.markScheduled).not.toHaveBeenCalled();
  });

  test('admits direct presentation without exposing it to provider run options', async () => {
    const presentation = { origin: 'cli', style: 'notice', title: 'Context' };
    const { handler, m } = scaffold();
    await handler.schedule({
      command: command(),
      content: 'body only',
      options: { clientRequestId: 'request-1', turnId: 'turn-1' },
      userMessagePresentation: presentation,
      settlement: settlement(),
    });

    expect(m.admitInput).toHaveBeenCalledWith('chat-1', 'body only', {
      clientRequestId: 'request-1',
      turnId: 'turn-1',
      userMessagePresentation: presentation,
    });
    expect(m.runDirect.mock.calls[0][2]).toEqual({
      clientRequestId: 'request-1',
      turnId: 'turn-1',
    });
  });

  test('rolls back preparation before releasing admission on pre-schedule failure', async () => {
    const events = [];
    const registrationError = new Error('append failed');
    const settle = settlement({
      markPreScheduleFailure: mock(async () => { events.push('settled'); }),
    });
    const { handler } = scaffold({
      admitInput: mock(async () => { throw registrationError; }),
      discardPreparedInput: mock(() => { events.push('discarded'); }),
      releaseDirect: mock(async () => { events.push('released'); }),
    });

    await expect(handler.schedule({
      command: command(),
      content: 'direct',
      options: {
        clientRequestId: 'request-1',
        clientMessageId: 'message-1',
        turnId: 'turn-1',
      },
      settlement: settle,
      preparation: {
        operation: 'fork-run',
        prepare: mock(async () => { events.push('prepared'); }),
        compensate: mock(async () => { events.push('compensated'); }),
      },
    })).rejects.toBe(registrationError);

    expect(events).toEqual(['prepared', 'compensated', 'discarded', 'released', 'settled']);
    expect(settle.markPreScheduleFailure).toHaveBeenCalledWith(command(), {
      error: registrationError,
      retryable: true,
      preserveForkPreparation: false,
    });
  });

  test('retains a prepared target when preambles block its opening slash command', async () => {
    const events = [];
    const blocked = new DomainError(
      'PREAMBLE_SLASH_COMMAND_BLOCKED',
      'Start with a regular message',
      422,
    );
    const settle = settlement({
      markPreScheduleFailure: mock(async () => { events.push('settled'); }),
    });
    const { handler } = scaffold({
      admitInput: mock(async () => { throw blocked; }),
      discardPreparedInput: mock(() => { events.push('discarded'); }),
      releaseDirect: mock(async () => { events.push('released'); }),
    });
    const compensate = mock(async () => { events.push('compensated'); });

    await expect(handler.schedule({
      command: command(),
      content: '/provider-command',
      options: {
        clientRequestId: 'request-1',
        clientMessageId: 'message-1',
        turnId: 'turn-1',
      },
      settlement: settle,
      preparation: {
        operation: 'chat-start',
        prepare: mock(async () => { events.push('prepared'); }),
        compensate,
      },
    })).rejects.toBe(blocked);

    expect(events).toEqual(['prepared', 'discarded', 'released', 'settled']);
    expect(compensate).not.toHaveBeenCalled();
    expect(settle.markPreScheduleFailure).toHaveBeenCalledWith(command(), {
      error: blocked,
      retryable: false,
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

  test('settles an accepted goal-control delivery failure without queueing a fallback', async () => {
    const providerError = new Error('connection lost');
    const settle = settlement();
    const { handler, m } = scaffold({
      deliverGoalControl: mock(async (_chatId, _content, _options, beforeDelivery) => {
        await beforeDelivery();
        throw new GoalControlDeliveryError(providerError, true);
      }),
    });

    await expect(handler.deliverGoalControl({
      command: command(),
      content: 'interrupt',
      clientMessageId: 'message-goal',
      transcriptViewId: 'view-1',
      settlement: settle,
    })).rejects.toBeInstanceOf(GoalControlDeliveryError);

    expect(settle.settleGoalControlFailure).toHaveBeenCalledWith(
      command(),
      expect.any(GoalControlDeliveryError),
      true,
    );
    expect(settle.markScheduled).toHaveBeenCalledWith(command(), 'turn-1');
    expect(m.create).not.toHaveBeenCalled();
  });

  test('settles confirmed active goal-control delivery without touching the queue', async () => {
    const events = [];
    const settle = settlement({
      markScheduled: mock(async () => { events.push('scheduled'); }),
      settleGoalControl: mock(async () => { events.push('settled'); }),
    });
    const { handler, m } = scaffold({
      deliverGoalControl: mock(async (_chatId, _content, _options, beforeDelivery) => {
        await beforeDelivery();
        events.push('delivered');
        return true;
      }),
    });

    await expect(handler.deliverGoalControl({
      command: command(),
      content: 'steer',
      clientMessageId: 'message-goal',
      transcriptViewId: 'view-1',
      settlement: settle,
    })).resolves.toMatchObject({ delivery: 'active' });

    expect(events).toEqual(['scheduled', 'delivered', 'settled']);
    expect(m.create).not.toHaveBeenCalled();
  });

  test('settles duplicate goal control without queueing or native redelivery', async () => {
    const settle = settlement();
    const { handler, m } = scaffold({
      deliverGoalControl: mock(async () => {
        throw new DuplicateGoalControlInputError();
      }),
    });

    await expect(handler.deliverGoalControl({
      command: command(),
      content: 'already committed',
      clientMessageId: 'message-goal',
      transcriptViewId: 'view-1',
      settlement: settle,
    })).resolves.toMatchObject({ delivery: 'active' });

    expect(settle.settleDuplicateInput).toHaveBeenCalledWith(command());
    expect(settle.settleGoalControlFailure).not.toHaveBeenCalled();
    expect(m.create).not.toHaveBeenCalled();
  });

  test('queues goal control when no active delivery target accepts it', async () => {
    const events = [];
    const settle = settlement({
      settleQueueMutation: mock(async () => { events.push('settled'); }),
    });
    const queuedControl = control({
      entries: [{ id: 'entry-1', content: 'interrupt', revision: 1, status: 'queued' }],
    });
    const { handler, m } = scaffold({
      deliverGoalControl: mock(async () => false),
      create: mock(async () => {
        events.push('queued');
        return { entryId: 'entry-1', control: queuedControl, duplicate: false };
      }),
      requestDrain: mock(() => { events.push('drain'); }),
    });

    await expect(handler.deliverGoalControl({
      command: command(),
      content: 'interrupt',
      clientMessageId: 'message-goal',
      transcriptViewId: 'view-1',
      settlement: settle,
    })).resolves.toEqual({
      delivery: 'queued',
      entryId: 'entry-1',
      control: queuedControl,
    });

    expect(events).toEqual(['queued', 'settled', 'drain']);
    expect(m.create).toHaveBeenCalledWith(
      'chat-1',
      'interrupt',
      { key: 'command-1', entryId: 'entry-1' },
      { clientMessageId: 'message-goal', transcriptViewId: 'view-1' },
    );
  });

  test('settles strict steering without creating a goal-control fallback', async () => {
    const events = [];
    const settle = settlement({
      markScheduled: mock(async () => { events.push('scheduled'); }),
      settleSteerSuccess: mock(async () => { events.push('settled'); }),
    });
    const { handler, m } = scaffold({
      steer: mock(async (
        _chatId,
        _content,
        _providerContent,
        _options,
        _target,
        beforeDelivery,
      ) => {
        await beforeDelivery('turn-current');
        events.push('delivered');
        return { turnId: 'turn-current', duplicate: false };
      }),
    });

    await expect(handler.steer({
      command: command({ turnId: undefined, entryId: undefined }),
      content: 'focus here',
      providerContent: 'focus here\n\nresolved context',
      clientMessageId: 'message-steer',
      transcriptViewId: 'view-1',
      userMessagePresentation: { origin: 'cli', style: 'error', title: 'Stop condition' },
      target: { attempt: {}, identity: { turnId: 'turn-current' } },
      settlement: settle,
    })).resolves.toEqual({ turnId: 'turn-current', duplicate: false });

    expect(events).toEqual(['scheduled', 'delivered', 'settled']);
    expect(m.steer).toHaveBeenCalledWith(
      'chat-1',
      'focus here',
      'focus here\n\nresolved context',
      expect.any(Object),
      expect.any(Object),
      expect.any(Function),
      { origin: 'cli', style: 'error', title: 'Stop condition' },
    );
    expect(m.create).not.toHaveBeenCalled();
  });

  test('reserves and consumes the queue head around accepted native steering', async () => {
    const events = [];
    const settle = settlement({
      markScheduled: mock(async () => { events.push('scheduled'); }),
      settleSteerSuccess: mock(async () => { events.push('settled'); }),
    });
    const { handler, m } = scaffold({
      reserveSteer: mock(async () => {
        events.push('reserved');
        return {
          entry: {
            id: 'entry-1',
            content: 'authoritative queue content',
            createdAt: '2026-08-02T00:00:00.000Z',
            revision: 2,
            status: 'steering',
          },
          control: control(),
        };
      }),
      steer: mock(async (
        _chatId,
        content,
        _providerContent,
        _options,
        _target,
        beforeDelivery,
      ) => {
        expect(content).toBe('authoritative queue content');
        await beforeDelivery('turn-current');
        events.push('delivered');
        return { turnId: 'turn-current', duplicate: false };
      }),
      consumeSteer: mock(async () => {
        events.push('consumed');
        return control();
      }),
      requestDrain: mock(() => { events.push('drain'); }),
    });

    await expect(handler.steerQueueEntry(queueSteerInput({ settlement: settle }))).resolves
      .toEqual({ turnId: 'turn-current', duplicate: false, control: control() });

    expect(events).toEqual(['reserved', 'scheduled', 'delivered', 'consumed', 'drain', 'settled']);
    expect(m.releaseSteer).not.toHaveBeenCalled();
  });

  test('releases the queue source after definite non-delivery', async () => {
    const deliveryError = new SteerDeliveryError(new Error('provider unavailable'), 'not-sent');
    const settle = settlement();
    const released = control({
      entries: [{ id: 'entry-1', content: 'queued guidance', revision: 2, status: 'queued' }],
    });
    const { handler, m } = scaffold({
      steer: mock(async () => { throw deliveryError; }),
      releaseSteer: mock(async () => released),
    });

    const rejection = await handler.steerQueueEntry(queueSteerInput({ settlement: settle }))
      .catch((error) => error);

    expect(rejection).toBeInstanceOf(QueueEntrySteerError);
    expect(rejection).toMatchObject({
      code: 'STEER_NOT_DELIVERED',
      deliveryOutcome: 'not-sent',
      control: released,
    });
    expect(m.releaseSteer).toHaveBeenCalledWith('chat-1', 'entry-1');
    expect(m.requestDrain).toHaveBeenCalledWith('chat-1', 'rejected queued steer released');
    expect(m.consumeSteer).not.toHaveBeenCalled();
    expect(settle.settleSteerFailure).toHaveBeenCalledWith(
      command(),
      rejection,
      'not-sent',
    );
  });

  test('consumes the queue source after an unknown native outcome', async () => {
    const deliveryError = new SteerDeliveryError(new Error('ack lost'), 'unknown');
    const settle = settlement();
    const consumed = control();
    const { handler, m } = scaffold({
      steer: mock(async () => { throw deliveryError; }),
      consumeSteer: mock(async () => consumed),
    });

    const rejection = await handler.steerQueueEntry(queueSteerInput({ settlement: settle }))
      .catch((error) => error);

    expect(rejection).toMatchObject({
      code: 'STEER_OUTCOME_UNKNOWN',
      deliveryOutcome: 'unknown',
      control: consumed,
    });
    expect(m.consumeSteer).toHaveBeenCalledWith('chat-1', 'entry-1');
    expect(m.releaseSteer).not.toHaveBeenCalled();
    expect(m.requestDrain).toHaveBeenCalledWith('chat-1', 'unconfirmed queued steer consumed');
    expect(settle.settleSteerFailure).toHaveBeenCalledWith(command(), rejection, 'unknown');
  });

  test('pauses the source when accepted steering cannot be consumed', async () => {
    const consumeError = new Error('consume failed');
    const paused = control({
      entries: [{ id: 'entry-1', content: 'queued guidance', revision: 2, status: 'queued' }],
      pause: { kind: 'completion-uncertain', entryId: 'entry-1' },
    });
    const settle = settlement();
    const { handler, m } = scaffold({
      consumeSteer: mock(async () => { throw consumeError; }),
      requeueAndPause: mock(async () => paused),
    });

    const rejection = await handler.steerQueueEntry(queueSteerInput({ settlement: settle }))
      .catch((error) => error);

    expect(rejection).toMatchObject({
      code: 'QUEUE_STEER_FINALIZATION_FAILED',
      deliveryOutcome: 'accepted',
      control: paused,
    });
    expect(m.requeueAndPause).toHaveBeenCalledWith(
      'chat-1',
      'entry-1',
      'completion-uncertain',
    );
    expect(settle.settleSteerFailure).toHaveBeenCalledWith(command(), rejection, 'accepted');
  });

  test('reports recovery failure when release and compensation both fail', async () => {
    const settle = settlement();
    const { handler, m } = scaffold({
      steer: mock(async () => {
        throw new SteerDeliveryError(new Error('provider unavailable'), 'not-sent');
      }),
      releaseSteer: mock(async () => { throw new Error('release failed'); }),
      requeueAndPause: mock(async () => { throw new Error('pause failed'); }),
    });

    const rejection = await handler.steerQueueEntry(queueSteerInput({ settlement: settle }))
      .catch((error) => error);

    expect(rejection).toMatchObject({
      code: 'QUEUE_STEER_RECOVERY_FAILED',
      deliveryOutcome: 'not-sent',
      control: undefined,
    });
    expect(settle.settleSteerFailure).toHaveBeenCalledWith(command(), rejection, 'not-sent');
  });

  test('preserves a reservation rejection when ledger settlement also fails', async () => {
    const reservationError = new DomainError('QUEUE_ENTRY_REVISION_CONFLICT', 'changed', 409);
    const settle = settlement({
      settleSteerFailure: mock(async () => { throw new Error('ledger unavailable'); }),
    });
    const { handler, m } = scaffold({
      reserveSteer: mock(async () => { throw reservationError; }),
    });

    const rejection = await handler.steerQueueEntry(queueSteerInput({ settlement: settle }))
      .catch((error) => error);

    expect(rejection).toMatchObject({
      code: 'QUEUE_ENTRY_REVISION_CONFLICT',
      deliveryOutcome: 'not-sent',
    });
    expect(m.steer).not.toHaveBeenCalled();
  });

  test('requeues and pauses a recoverable queue steer', async () => {
    const queuedControl = control({ entries: [{ id: 'entry-1', status: 'queued' }] });
    const { handler, m } = scaffold({
      read: mock(async () => queuedControl),
      requeueAndPause: mock(async () => control({
        entries: [{ id: 'entry-1', status: 'queued' }],
        pause: { kind: 'completion-uncertain', entryId: 'entry-1' },
      })),
    });

    await handler.recoverQueueEntrySteer('chat-1', 'entry-1');

    expect(m.requeueAndPause).toHaveBeenCalledWith(
      'chat-1',
      'entry-1',
      'completion-uncertain',
    );
  });
});
