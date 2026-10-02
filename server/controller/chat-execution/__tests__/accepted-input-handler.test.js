import { describe, expect, mock, spyOn, test } from 'bun:test';
import { AgentCallError } from '@garcon/server-agent-interface';
import { AcceptedInputHandler } from '../accepted-input-handler.ts';
import { DomainError, ProjectUnavailableError } from '../../../common/domain-error.js';
import { SteerDeliveryError } from '../steering-errors.js';
import { reconnectTimedOut } from '../../../common/executor-disconnect.js';
import { QueueEntrySteerError } from '../queue-steer-error.js';

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
        entries: [{ id: 'entry-1', content: 'queued guidance', images: [], revision: 2, status: 'steering' }],
      }),
    })),
    releaseSteer: mock(async () => control({
      entries: [{ id: 'entry-1', content: 'queued guidance', images: [], revision: 2, status: 'queued' }],
    })),
    createSteer: mock(async () => ({ entryId: 'steer-1', control: control(), duplicate: false })),
    markSteer: mock(async () => control()),
    consumeSteer: mock(async () => control({ recentlyDispatched: [{
      entryId: 'entry-1',
      revision: 2,
      dispatchedAt: '2026-08-02T00:00:01.000Z',
    }] })),
    requeueAndPause: mock(async () => control({
      entries: [{ id: 'entry-1', content: 'queued guidance', images: [], revision: 2, status: 'queued' }],
      pause: { kind: 'completion-uncertain', entryId: 'entry-1' },
    })),
    read: mock(async () => control()),
    requestDrain: mock(() => undefined),
    reserveDirect: mock(() => reservation),
    checkpoint: mock(() => undefined),
    hasMatchingInput: mock(async () => false),
    admitInput: mock(async () => true),
    discardPreparedInput: mock(() => undefined),
    releaseDirect: mock(async () => undefined),
    runDirect: mock(async () => undefined),
    trackDispatch: mock(() => undefined),
    steer: mock(async () => ({ turnId: 'turn-1' })),
    assertProjectAvailable: mock(async () => undefined),
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
      createSteer: m.createSteer,
      markSteer: m.markSteer,
      requeueAndPause: m.requeueAndPause,
      read: m.read,
    },
    coordinator: {
      requestDrain: m.requestDrain,
      reserveDirect: m.reserveDirect,
      checkpoint: m.checkpoint,
      hasMatchingInput: m.hasMatchingInput,
      admitInput: m.admitInput,
      discardPreparedInput: m.discardPreparedInput,
      releaseDirect: m.releaseDirect,
      runDirect: m.runDirect,
      trackDispatch: m.trackDispatch,
      steer: m.steer,
    },
    projectAdmission: {
      assertAvailable: m.assertProjectAvailable,
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

  test('queues a steer under its submission identity before requesting dispatch', async () => {
    const events = [];
    const settle = settlement({
      settleQueueMutation: mock(async () => { events.push('settled'); }),
    });
    const { handler, m } = scaffold({
      createSteer: mock(async () => {
        events.push('created');
        return { entryId: 'steer-1', control: control(), duplicate: false };
      }),
      requestDrain: mock(() => { events.push('drain'); }),
    });

    await handler.enqueueSteer({
      command: { ...command(), entryId: 'steer-1' },
      content: 'guidance',
      clientMessageId: 'message-steer',
      transcriptViewId: 'view-1',
      settlement: settle,
    });

    expect(events).toEqual(['created', 'settled', 'drain']);
    expect(m.createSteer).toHaveBeenCalledWith(
      'chat-1',
      'guidance',
      { key: command().key, entryId: 'steer-1' },
      { clientMessageId: 'message-steer', transcriptViewId: 'view-1' },
    );
  });

  test('records a queued steer that could not be created as a failed steer', async () => {
    const settle = settlement();
    const failure = new Error('control store unavailable');
    const { handler } = scaffold({ createSteer: mock(async () => { throw failure; }) });

    await expect(handler.enqueueSteer({
      command: { ...command(), entryId: 'steer-1' },
      content: 'guidance',
      clientMessageId: 'message-steer',
      transcriptViewId: 'view-1',
      settlement: settle,
    })).rejects.toBe(failure);
    expect(settle.settleSteerFailure).toHaveBeenCalledWith(expect.anything(), failure);
  });

  test('keeps a queued message as a steer and settles it', async () => {
    const settle = settlement();
    const { handler, m } = scaffold();

    await handler.markQueueEntrySteer({
      command: { ...command(), entryId: 'entry-1' },
      expectedRevision: 2,
      expectedReorderRevision: 4,
      settlement: settle,
    });

    expect(m.markSteer).toHaveBeenCalledWith('chat-1', {
      entryId: 'entry-1',
      expectedRevision: 2,
      expectedReorderRevision: 4,
    });
    expect(settle.settleQueueMutation).toHaveBeenCalledWith(expect.anything(), 'entry-1');
    expect(m.requestDrain).toHaveBeenCalled();
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

  test('skips control, preparation, and project admission for a matching input', async () => {
    const settle = settlement();
    const { handler, m } = scaffold({ hasMatchingInput: mock(async () => true) });
    const prepare = mock(async () => undefined);

    await handler.schedule({
      command: command(),
      content: 'already committed',
      options: { clientRequestId: 'request-1', clientMessageId: 'message-1', turnId: 'turn-1' },
      settlement: settle,
      preparation: {
        operation: 'fork-run',
        prepare,
        compensate: mock(async () => undefined),
      },
    });

    expect(settle.settleDuplicateInput).toHaveBeenCalledWith(command());
    expect(m.read).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    expect(m.assertProjectAvailable).not.toHaveBeenCalled();
    expect(m.admitInput).not.toHaveBeenCalled();
  });

  describe('admission deadline after a preparation', () => {
    // The operation asked for its chat lock at 1 s, so its deadline is 21 s.
    async function admissionDeadlineAfter({ startsAt, lasts, operation = 'fork-run', admissionDeadline = 21_000 }) {
      let now = startsAt;
      const clock = spyOn(performance, 'now').mockImplementation(() => now);
      try {
        const { handler, m } = scaffold();
        await handler.schedule({
          command: command(),
          content: 'prepared work',
          options: { clientRequestId: 'request-1', clientMessageId: 'message-1', turnId: 'turn-1' },
          settlement: settlement(),
          admissionDeadline,
          preparation: { operation, prepare: mock(async () => { now += lasts; }), compensate: mock(async () => undefined) },
        });
        return m.assertProjectAvailable.mock.calls[0][1];
      } finally {
        clock.mockRestore();
      }
    }

    test('does not count a slow preparation, such as a native fork, against the deadline', async () => {
      // 2 s of the budget were left when a 60 s fork began.
      expect(await admissionDeadlineAfter({ startsAt: 19_000, lasts: 60_000 })).toBe(81_000);
    });

    test('leaves the deadline in place after a quick preparation of any kind', async () => {
      for (const operation of ['chat-start', 'fork-run', 'agent-handoff']) {
        expect(await admissionDeadlineAfter({ operation, startsAt: 19_000, lasts: 5 })).toBe(21_005);
      }
    });

    test('ends a budget spent before the preparation began at once', async () => {
      expect(await admissionDeadlineAfter({ startsAt: 30_000, lasts: 1_000 })).toBe(31_000);
    });

    test('keeps background admission without a deadline', async () => {
      expect(await admissionDeadlineAfter({ startsAt: 1_000, lasts: 1_000, admissionDeadline: null })).toBeNull();
    });
  });

  test('checks admission within the given deadline without a preparation', async () => {
    const { handler, m } = scaffold();

    await handler.schedule({
      command: command(),
      content: 'new work',
      options: { clientRequestId: 'request-1', clientMessageId: 'message-1', turnId: 'turn-1' },
      settlement: settlement(),
      admissionDeadline: 21_000,
    });

    expect(m.assertProjectAvailable).toHaveBeenCalledWith('chat-1', 21_000);
  });

  test('compensates preparation when the project is unavailable before transcript admission', async () => {
    const events = [];
    const unavailable = new ProjectUnavailableError('/workspace/missing', 'not-found');
    const settle = settlement({
      markPreScheduleFailure: mock(async () => { events.push('settled'); }),
    });
    const { handler, m } = scaffold({
      assertProjectAvailable: mock(async () => { throw unavailable; }),
      releaseDirect: mock(async () => { events.push('released'); }),
    });

    await expect(handler.schedule({
      command: command(),
      content: 'new work',
      options: { clientRequestId: 'request-1', clientMessageId: 'message-1', turnId: 'turn-1' },
      settlement: settle,
      preparation: {
        operation: 'chat-start',
        prepare: mock(async () => { events.push('prepared'); }),
        compensate: mock(async () => { events.push('compensated'); }),
      },
    })).rejects.toBe(unavailable);

    expect(events).toEqual(['prepared', 'compensated', 'released', 'settled']);
    expect(m.admitInput).not.toHaveBeenCalled();
    expect(m.runDirect).not.toHaveBeenCalled();
    expect(settle.markPreScheduleFailure).toHaveBeenCalledWith(command(), {
      error: unavailable,
      retryable: true,
      preserveForkPreparation: false,
    });
  });

  test('rejects compact when the project is unavailable and releases ownership', async () => {
    const unavailable = new ProjectUnavailableError('/workspace/missing', 'not-found');
    const settle = settlement();
    const dispatch = mock(async () => undefined);
    const { handler, m } = scaffold({
      assertProjectAvailable: mock(async () => { throw unavailable; }),
    });

    await expect(handler.scheduleOperation({
      command: command(),
      settlement: settle,
      dispatch,
    })).rejects.toBe(unavailable);

    expect(m.releaseDirect).toHaveBeenCalledOnce();
    expect(m.runDirect).not.toHaveBeenCalled();
    expect(m.trackDispatch).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(settle.markScheduled).not.toHaveBeenCalled();
    expect(settle.markPreScheduleFailure).toHaveBeenCalledWith(command(), {
      error: unavailable,
      retryable: true,
    });
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

  test('settles a detached startup failure before release without compensating accepted creation', async () => {
    const failure = new DomainError('CARRYOVER_COMPACTION_FAILED', 'Synthetic failure', 422);
    const settle = settlement();
    const compensate = mock(async () => {});
    const { handler, m } = scaffold({ runDirect: mock(async (_reservation, _content, _options, _dispatch, beforeRelease) => {
      await beforeRelease(failure);
      expect(settle.settleOperationFailure).toHaveBeenCalledWith(command(), failure);
      throw failure;
    }) });
    await handler.schedule({ command: command(), content: 'Task', options: { turnId: 'turn-1' },
      settlement: settle, preparation: { operation: 'chat-start', prepare: async () => {}, compensate } });
    await m.trackDispatch.mock.calls[0][0];
    expect(compensate).not.toHaveBeenCalled();
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

  test.each([
    ['ordinary failure', new Error('provider failed'), ['compensated', 'settled', 'released']],
    ['setup failure', new AgentCallError('not-dispatched', 'setup reply lost'), ['compensated', 'settled', 'released']],
    // A start holding its chat's lock stops waiting for a reconnecting executor.
    ['missed dispatch deadline', reconnectTimedOut(), ['compensated', 'settled', 'released']],
    ['uncertain launch', new AgentCallError('unknown', 'execution reply lost'), ['settled', 'released']],
  ])('finishes initial-input settlement before release after %s', async (_name, providerError, expected) => {
    const events = [];
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

    expect(events).toEqual(expected);
  });

  test('settles strict steering without creating a queue fallback', async () => {
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
      entries: [{ id: 'entry-1', content: 'queued guidance', images: [], revision: 2, status: 'queued' }],
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
      entries: [{ id: 'entry-1', content: 'queued guidance', images: [], revision: 2, status: 'queued' }],
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
