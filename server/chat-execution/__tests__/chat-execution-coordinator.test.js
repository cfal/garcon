import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { ChatExecutionCoordinator } from '../chat-execution-coordinator.js';
import { InMemoryChatExecutionControlRepository } from '../chat-execution-control-repository.ts';
import { DomainError } from '../../lib/domain-error.ts';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('Timed out waiting for coordinator state');
}

function rejectWhenExecutionAdmissionAborts(_chatId, _content, options) {
  return new Promise((_resolve, reject) => {
    const { signal } = options.executionAdmission;
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

function createFixture(overrides = {}) {
  const events = [];
  const queuedAdmission = overrides.queuedAdmission ?? (() => ({ inserted: true }));
  const projection = {
    admitInput: mock(async () => ({ inserted: true })),
    admitQueuedInput: mock((...args) => {
      events.push('transcript');
      return queuedAdmission(...args);
    }),
    discardPreparedInput: mock(() => undefined),
  };
  const turnRunner = {
    runAgentTurn: mock(async () => undefined),
    captureSteerTarget: mock(() => null),
    steerInput: mock(async () => ({ kind: 'declined' })),
    submitGoalControl: mock(async () => false),
    abortSession: mock(async () => false),
    isChatRunning: mock(() => false),
    ...overrides.turnRunner,
  };
  const coordinator = new ChatExecutionCoordinator(
    '/unused',
    turnRunner,
    projection,
    overrides.getDrainOptions ?? (() => ({
      model: 'test-model',
      permissionMode: 'default',
      thinkingMode: 'none',
    })),
    overrides.chatExists ?? (() => true),
    overrides.controlRepository
      ?? new InMemoryChatExecutionControlRepository('server-instance-test'),
  );
  return { coordinator, events, projection, turnRunner };
}

describe('ChatExecutionCoordinator', () => {
  let coordinator;

  beforeEach(() => {
    ({ coordinator } = createFixture());
  });

  afterEach(async () => {
    coordinator.beginShutdown();
  });

  it('excludes direct execution until a transcript snapshot is released', async () => {
    const snapshot = coordinator.reserveTranscriptSnapshot('chat-1');

    expect(coordinator.ownsExecution('chat-1')).toBe(true);
    expect(() => coordinator.reserveDirectTurn('chat-1')).toThrow('already owns execution');

    await coordinator.releaseTranscriptSnapshot(snapshot);
    const direct = coordinator.reserveDirectTurn('chat-1');
    await coordinator.releaseDirectTurn(direct);
    expect(coordinator.ownsExecution('chat-1')).toBe(false);
  });

  it('defers a requested queue drain until a transcript snapshot is released', async () => {
    const run = deferred();
    const fixture = createFixture({
      turnRunner: { runAgentTurn: mock(() => run.promise) },
    });
    coordinator = fixture.coordinator;
    const snapshot = coordinator.reserveTranscriptSnapshot('chat-1');
    await coordinator.createChatQueueEntry('chat-1', 'queued');

    await coordinator.triggerDrain('chat-1');
    expect(fixture.turnRunner.runAgentTurn).not.toHaveBeenCalled();

    const release = coordinator.releaseTranscriptSnapshot(snapshot);
    await waitFor(() => fixture.turnRunner.runAgentTurn.mock.calls.length === 1);
    const options = fixture.turnRunner.runAgentTurn.mock.calls[0][2];
    await coordinator.onAgentTurnTerminal('chat-1', { turnId: options.turnId });
    run.resolve();
    await release;
  });

  it('[TLV5-L04.03-CORE-UNIT-01] keeps future-turn inputs out of the transcript until dequeue', async () => {
    const provider = deferred();
    const fixture = createFixture({
      turnRunner: {
        runAgentTurn: mock(() => {
          fixture.events.push('provider');
          return provider.promise;
        }),
      },
    });
    coordinator = fixture.coordinator;
    await coordinator.createChatQueueEntry('chat-1', 'queued input');
    expect(fixture.projection.admitQueuedInput).not.toHaveBeenCalled();

    const drain = coordinator.triggerDrain('chat-1');
    await waitFor(() => fixture.turnRunner.runAgentTurn.mock.calls.length === 1);

    expect(fixture.events).toEqual(['transcript', 'provider']);
    expect(fixture.projection.admitQueuedInput.mock.calls[0][1].content).toBe('queued input');
    const options = fixture.turnRunner.runAgentTurn.mock.calls[0][2];
    await coordinator.onAgentTurnTerminal('chat-1', { turnId: options.turnId });
    provider.resolve();
    await drain;
    expect((await coordinator.readChatExecutionControl('chat-1')).entries).toEqual([]);
  });

  it('removes a committed duplicate without dispatching it again', async () => {
    const fixture = createFixture({ queuedAdmission: () => ({ inserted: false }) });
    coordinator = fixture.coordinator;
    await coordinator.createChatQueueEntry('chat-1', 'duplicate');

    await coordinator.triggerDrain('chat-1');

    expect(fixture.projection.admitQueuedInput).toHaveBeenCalledTimes(1);
    expect(fixture.turnRunner.runAgentTurn).not.toHaveBeenCalled();
    expect((await coordinator.readChatExecutionControl('chat-1')).entries).toEqual([]);
  });

  it('does not restore a committed queue input when provider dispatch fails', async () => {
    const fixture = createFixture({
      turnRunner: { runAgentTurn: mock(async () => { throw new Error('launch failed'); }) },
    });
    coordinator = fixture.coordinator;
    const failures = [];
    coordinator.onTurnFailed((chatId, message) => failures.push({ chatId, message }));
    await coordinator.createChatQueueEntry('chat-1', 'retry later');

    await coordinator.triggerDrain('chat-1');

    const control = await coordinator.readChatExecutionControl('chat-1');
    expect(control.entries).toEqual([]);
    expect(control.pause).toBeNull();
    expect(failures).toEqual([{ chatId: 'chat-1', message: 'launch failed' }]);
  });

  it('pauses the remaining queue before releasing a failed queued turn', async () => {
    const provider = deferred();
    const fixture = createFixture({
      turnRunner: { runAgentTurn: mock(() => provider.promise) },
    });
    coordinator = fixture.coordinator;
    await coordinator.createChatQueueEntry('chat-1', 'failed head');
    await coordinator.createChatQueueEntry('chat-1', 'queued tail');

    const drain = coordinator.triggerDrain('chat-1');
    await waitFor(() => fixture.turnRunner.runAgentTurn.mock.calls.length === 1);
    const options = fixture.turnRunner.runAgentTurn.mock.calls[0][2];
    await coordinator.onAgentTurnTerminal('chat-1', { turnId: options.turnId }, 'failed');

    const control = await coordinator.readChatExecutionControl('chat-1');
    expect(control.entries.map((entry) => entry.content)).toEqual(['queued tail']);
    expect(control.pause).toMatchObject({
      kind: 'queued-turn-failed',
      entryId: expect.any(String),
    });

    provider.reject(new Error('provider failed'));
    await drain;
  });

  it('holds direct ownership until the matching run-ended signal', async () => {
    const provider = deferred();
    const fixture = createFixture({
      turnRunner: { runAgentTurn: mock(() => provider.promise) },
    });
    coordinator = fixture.coordinator;
    const reservation = coordinator.reserveDirectTurn('chat-1', { turnId: 'turn-1' });
    const run = coordinator.runReservedTurn(reservation, 'work', {
      clientMessageId: 'message-1',
      turnId: 'turn-1',
    });
    provider.resolve();
    await run;

    expect(fixture.projection.discardPreparedInput).toHaveBeenCalledOnce();
    expect(fixture.projection.discardPreparedInput).toHaveBeenCalledWith('chat-1', 'message-1');

    expect(coordinator.ownsExecution('chat-1')).toBe(true);
    await coordinator.onAgentTurnTerminal('chat-1', { turnId: 'other-turn' });
    expect(coordinator.ownsExecution('chat-1')).toBe(true);

    await coordinator.onAgentTurnTerminal('chat-1', { turnId: 'turn-1' });
    expect(coordinator.ownsExecution('chat-1')).toBe(false);
  });

  it('[TLV5-CHAT-ID-DISCOVERY.04-CORE-CONTROL-UNIT-01] delivers control steering without admitting or cleaning up user input', async () => {
    const providerTarget = { providerTurnId: 'provider-turn-1' };
    const fixture = createFixture({
      turnRunner: {
        captureSteerTarget: mock(() => providerTarget),
        steerInput: mock(async (_chatId, _content, _options, _target, prepare) => {
          await prepare();
          return { kind: 'accepted' };
        }),
      },
    });
    coordinator = fixture.coordinator;
    const reservation = coordinator.reserveDirectTurn('chat-1', { turnId: 'turn-1' });
    await coordinator.deliverControlInput(
      'chat-1',
      '<garcon-chat-id>1787836573296800</garcon-chat-id>',
      'view-1',
      new AbortController().signal,
      mock(() => undefined),
    );

    expect(fixture.turnRunner.steerInput).toHaveBeenCalledTimes(1);
    const steerCall = fixture.turnRunner.steerInput.mock.calls[0];
    expect(steerCall[0]).toBe('chat-1');
    expect(steerCall[1]).toBe('<garcon-chat-id>1787836573296800</garcon-chat-id>');
    expect(steerCall[2]).toEqual({
      clientRequestId: expect.any(String),
      clientMessageId: steerCall[2].clientRequestId,
      transcriptViewId: 'view-1',
    });
    expect(steerCall[3]).toBe(providerTarget);
    expect(steerCall[4]).toEqual(expect.any(Function));
    expect(fixture.projection.admitInput).not.toHaveBeenCalled();
    expect(fixture.projection.discardPreparedInput).not.toHaveBeenCalled();
    await coordinator.releaseDirectTurn(reservation);
  });

  it('does not fall back after steering accepts without preparing delivery', async () => {
    const fixture = createFixture({
      turnRunner: {
        captureSteerTarget: mock(() => ({ providerTurnId: 'provider-turn-1' })),
        steerInput: mock(async () => ({ kind: 'accepted' })),
      },
    });
    coordinator = fixture.coordinator;
    const reservation = coordinator.reserveDirectTurn('chat-1', { turnId: 'turn-1' });

    await expect(coordinator.deliverControlInput(
      'chat-1',
      '<garcon-chat-id>1787836573296800</garcon-chat-id>',
      'view-1',
      new AbortController().signal,
      mock(() => undefined),
    )).rejects.toMatchObject({ code: 'STEER_OUTCOME_UNKNOWN' });

    expect(fixture.turnRunner.runAgentTurn).not.toHaveBeenCalled();
    await coordinator.releaseDirectTurn(reservation);
  });

  it('[TLV5-CHAT-ID-DISCOVERY.04-CORE-HIDDEN-RUN-UNIT-01] schedules a hidden control turn without admitting user input', async () => {
    const provider = deferred();
    const fixture = createFixture({
      turnRunner: {
        captureSteerTarget: mock(() => null),
        runAgentTurn: mock(() => provider.promise),
      },
    });
    coordinator = fixture.coordinator;
    const onHiddenRun = mock(() => undefined);

    await coordinator.deliverControlInput(
      'chat-1',
      '<garcon-chat-id>1787836573296800</garcon-chat-id>',
      'view-1',
      new AbortController().signal,
      onHiddenRun,
    );

    expect(fixture.turnRunner.runAgentTurn).toHaveBeenCalledTimes(1);
    const runCall = fixture.turnRunner.runAgentTurn.mock.calls[0];
    expect(runCall[0]).toBe('chat-1');
    expect(runCall[1]).toBe('<garcon-chat-id>1787836573296800</garcon-chat-id>');
    expect(runCall[2]).toMatchObject({
      clientRequestId: expect.any(String),
      clientMessageId: expect.any(String),
      transcriptViewId: 'view-1',
      turnId: expect.any(String),
      commandType: 'agent-run',
    });
    expect(onHiddenRun).toHaveBeenCalledWith(runCall[2].turnId);
    expect(fixture.projection.admitInput).not.toHaveBeenCalled();
    expect(coordinator.ownsExecution('chat-1')).toBe(true);

    const activeTarget = coordinator.captureSteerTarget('chat-1');
    await coordinator.onAgentTurnTerminal('chat-1', activeTarget.identity);
    provider.resolve();
    await coordinator.waitForDispatches();
    expect(coordinator.ownsExecution('chat-1')).toBe(false);
  });

  it('releases hidden control ownership when run options cannot be resolved', async () => {
    const fixture = createFixture({
      getDrainOptions: () => { throw new Error('session disappeared'); },
    });
    coordinator = fixture.coordinator;

    await expect(coordinator.deliverControlInput(
      'chat-1',
      '<garcon-chat-id>1787836573296800</garcon-chat-id>',
      'view-1',
      new AbortController().signal,
      mock(() => undefined),
    )).rejects.toThrow('session disappeared');

    expect(coordinator.ownsExecution('chat-1')).toBe(false);
    await coordinator.waitForExecutionOwners();
  });

  it('blocks hidden control delivery when pause state exists without entries', async () => {
    const controlRepository = new InMemoryChatExecutionControlRepository('server-instance-test');
    const control = controlRepository.load('chat-1');
    control.pause = {
      id: 'pause-1',
      kind: 'manual',
      pausedAt: '2026-08-29T00:00:00.000Z',
    };
    controlRepository.save('chat-1', control);
    const fixture = createFixture({ controlRepository });
    coordinator = fixture.coordinator;

    await expect(coordinator.deliverControlInput(
      'chat-1',
      '<garcon-chat-id>1787836573296800</garcon-chat-id>',
      'view-1',
      new AbortController().signal,
      mock(() => undefined),
    )).rejects.toMatchObject({
      code: 'SESSION_BUSY',
      message: 'Server control input is blocked by paused or pending queue work',
    });

    expect(fixture.turnRunner.runAgentTurn).not.toHaveBeenCalled();
    expect(coordinator.ownsExecution('chat-1')).toBe(false);
  });

  it('blocks hidden control delivery while chat deletion is suppressing execution', async () => {
    const fixture = createFixture();
    coordinator = fixture.coordinator;
    expect(await coordinator.abortForChatDeletion('chat-1')).toBe(true);

    await expect(coordinator.deliverControlInput(
      'chat-1',
      '<garcon-chat-id>1787836573296800</garcon-chat-id>',
      'view-1',
      new AbortController().signal,
      mock(() => undefined),
    )).rejects.toMatchObject({
      code: 'SESSION_BUSY',
      message: 'Server control input is blocked by paused or pending queue work',
    });

    expect(fixture.turnRunner.runAgentTurn).not.toHaveBeenCalled();
    expect(coordinator.ownsExecution('chat-1')).toBe(false);
    coordinator.rollbackChatDeletion('chat-1');
  });

  it('blocks hidden control delivery after the chat leaves the registry', async () => {
    const fixture = createFixture({ chatExists: () => false });
    coordinator = fixture.coordinator;

    await expect(coordinator.deliverControlInput(
      'chat-1',
      '<garcon-chat-id>1787836573296800</garcon-chat-id>',
      'view-1',
      new AbortController().signal,
      mock(() => undefined),
    )).rejects.toMatchObject({ code: 'SESSION_BUSY' });

    expect(fixture.turnRunner.runAgentTurn).not.toHaveBeenCalled();
    expect(coordinator.ownsExecution('chat-1')).toBe(false);
  });

  it('reports pending queue work after unsupported steering and releases ownership', async () => {
    const fixture = createFixture({
      turnRunner: {
        captureSteerTarget: mock(() => ({ providerTurnId: 'provider-turn-1' })),
        steerInput: mock(async () => {
          throw new DomainError(
            'OPERATION_UNSUPPORTED',
            'This turn cannot be steered',
            422,
          );
        }),
      },
    });
    coordinator = fixture.coordinator;
    coordinator.reserveDirectTurn('chat-1', { turnId: 'turn-1' });
    await coordinator.createChatQueueEntry('chat-1', 'queued work');

    const delivery = coordinator.deliverControlInput(
      'chat-1',
      '<garcon-chat-id>1787836573296800</garcon-chat-id>',
      'view-1',
      new AbortController().signal,
      mock(() => undefined),
    );
    await waitFor(() => fixture.turnRunner.steerInput.mock.calls.length === 1);
    await coordinator.onAgentTurnTerminal('chat-1', { turnId: 'turn-1' });

    await expect(delivery).rejects.toMatchObject({ code: 'SESSION_BUSY' });

    expect(fixture.turnRunner.steerInput).toHaveBeenCalledTimes(1);
    expect(fixture.turnRunner.runAgentTurn).not.toHaveBeenCalled();
    expect(coordinator.ownsExecution('chat-1')).toBe(false);
  });

  it('treats an accepted queued steer without preparation as an unknown outcome', async () => {
    const fixture = createFixture({
      turnRunner: {
        captureSteerTarget: mock(() => ({ providerTurnId: 'provider-turn-1' })),
        steerInput: mock(async () => ({ kind: 'accepted' })),
      },
    });
    coordinator = fixture.coordinator;
    const reservation = coordinator.reserveDirectTurn('chat-1', { turnId: 'turn-1' });
    const queued = await coordinator.createChatQueueEntry('chat-1', 'queued steer');
    const target = coordinator.captureSteerTarget('chat-1');
    const settlement = {
      markScheduled: mock(async () => undefined),
      settleSteerFailure: mock(async () => undefined),
    };

    const error = await coordinator.deliverAcceptedQueueEntrySteer({
      command: {
        key: 'queued-steer-command',
        chatId: 'chat-1',
        clientRequestId: 'queued-steer-request',
        entryId: queued.entryId,
      },
      content: 'queued steer',
      providerContent: 'queued steer',
      clientMessageId: 'queued-steer-message',
      transcriptViewId: 'view-1',
      target,
      expectedRevision: queued.entry.revision,
      expectedReorderRevision: queued.control.reorderRevision,
      settlement,
    }).catch((failure) => failure);

    expect(error).toMatchObject({
      code: 'STEER_OUTCOME_UNKNOWN',
      deliveryOutcome: 'unknown',
    });
    const control = await coordinator.readChatExecutionControl('chat-1');
    expect(control.entries).toEqual([]);
    expect(control.recentlyDispatched).toEqual([
      expect.objectContaining({ entryId: queued.entryId, revision: queued.entry.revision }),
    ]);
    expect(settlement.settleSteerFailure).toHaveBeenCalledWith(
      expect.objectContaining({ entryId: queued.entryId }),
      error,
      'unknown',
    );
    await coordinator.releaseDirectTurn(reservation);
  });

  it('steers a queued successor after the requesting turn settles', async () => {
    const queuedRun = deferred();
    let steerAttempt = 0;
    const fixture = createFixture({
      turnRunner: {
        captureSteerTarget: mock(() => ({ providerTurnId: `provider-turn-${steerAttempt + 1}` })),
        steerInput: mock(async (_chatId, _content, _options, _target, prepare) => {
          steerAttempt += 1;
          if (steerAttempt === 1) {
            throw new DomainError(
              'OPERATION_UNSUPPORTED',
              'This turn cannot be steered',
              422,
            );
          }
          await prepare();
          return { kind: 'accepted' };
        }),
        runAgentTurn: mock(() => queuedRun.promise),
      },
    });
    coordinator = fixture.coordinator;
    coordinator.reserveDirectTurn('chat-1', { turnId: 'turn-1' });
    await coordinator.createChatQueueEntry('chat-1', 'queued successor');

    const delivery = coordinator.deliverControlInput(
      'chat-1',
      '<garcon-chat-id>1787836573296800</garcon-chat-id>',
      'view-1',
      new AbortController().signal,
      mock(() => undefined),
    );
    await waitFor(() => fixture.turnRunner.steerInput.mock.calls.length === 1);

    const terminal = coordinator.onAgentTurnTerminal('chat-1', { turnId: 'turn-1' });
    const drain = coordinator.triggerDrain('chat-1');
    await delivery;

    expect(fixture.turnRunner.steerInput).toHaveBeenCalledTimes(2);
    expect(fixture.turnRunner.runAgentTurn).toHaveBeenCalledWith(
      'chat-1',
      'queued successor',
      expect.objectContaining({ turnId: expect.any(String) }),
    );
    const successor = fixture.turnRunner.runAgentTurn.mock.calls[0][2];
    await coordinator.onAgentTurnTerminal('chat-1', { turnId: successor.turnId });
    queuedRun.resolve();
    await Promise.all([terminal, drain]);
  });

  it('wakes hidden control delivery when provider-only running state clears', async () => {
    const provider = deferred();
    let running = true;
    const fixture = createFixture({
      turnRunner: {
        captureSteerTarget: mock(() => null),
        isChatRunning: mock(() => running),
        runAgentTurn: mock(() => provider.promise),
      },
    });
    coordinator = fixture.coordinator;
    const abortController = new AbortController();
    const delivery = coordinator.deliverControlInput(
      'chat-1',
      '<garcon-chat-id>1787836573296800</garcon-chat-id>',
      'view-1',
      abortController.signal,
      mock(() => undefined),
    );

    await waitFor(() => fixture.turnRunner.isChatRunning.mock.calls.length > 0);
    running = false;
    await coordinator.checkChatIdle('chat-1');

    try {
      await waitFor(() => fixture.turnRunner.runAgentTurn.mock.calls.length === 1);
      await delivery;
      expect(fixture.turnRunner.runAgentTurn).toHaveBeenCalledTimes(1);
    } finally {
      abortController.abort();
      const runOptions = fixture.turnRunner.runAgentTurn.mock.calls[0]?.[2];
      if (runOptions) {
        await coordinator.onAgentTurnTerminal('chat-1', { turnId: runOptions.turnId });
      }
      provider.resolve();
      await delivery.catch(() => undefined);
      await coordinator.waitForDispatches();
    }
  });

  it('retires an interrupted run immediately and starts its queued successor', async () => {
    const first = deferred();
    const second = deferred();
    const fixture = createFixture({
      turnRunner: {
        runAgentTurn: mock((_chatId, _content, options) => (
          options.turnId === 'turn-1' ? first.promise : second.promise
        )),
        abortSession: mock(async () => true),
      },
    });
    coordinator = fixture.coordinator;
    const settled = [];
    coordinator.onTurnSettled((_chatId, turn) => settled.push(turn?.turnId));
    const reservation = coordinator.reserveDirectTurn('chat-1', { turnId: 'turn-1' });
    const firstRun = coordinator.runReservedTurn(reservation, 'first', { turnId: 'turn-1' });
    await waitFor(() => fixture.turnRunner.runAgentTurn.mock.calls.length === 1);
    await coordinator.createChatQueueEntry('chat-1', 'second');

    await expect(coordinator.interruptActiveTurn('chat-1')).resolves.toBe('interrupt-requested');
    await waitFor(() => fixture.turnRunner.runAgentTurn.mock.calls.length === 2);

    expect(settled).toContain('turn-1');
    expect(fixture.turnRunner.abortSession).toHaveBeenCalledWith('chat-1');
    const successor = fixture.turnRunner.runAgentTurn.mock.calls[1][2];
    await coordinator.onAgentTurnTerminal('chat-1', { turnId: successor.turnId });
    second.resolve();
    await coordinator.waitForExecutionOwners();

    first.resolve();
    await firstRun;
    expect((await coordinator.readChatExecutionControl('chat-1')).entries).toEqual([]);
  });

  it('ignores a late provider rejection after interruption', async () => {
    const first = deferred();
    const fixture = createFixture({
      turnRunner: {
        runAgentTurn: mock(() => first.promise),
        abortSession: mock(async () => true),
      },
    });
    coordinator = fixture.coordinator;
    const failures = [];
    coordinator.onTurnFailed((_chatId, message) => failures.push(message));
    const reservation = coordinator.reserveDirectTurn('chat-1', { turnId: 'turn-1' });
    const run = coordinator.runReservedTurn(reservation, 'first', { turnId: 'turn-1' });

    await coordinator.interruptActiveTurn('chat-1');
    first.reject(new Error('late provider failure'));

    await expect(run).rejects.toThrow('late provider failure');
    expect(failures).toEqual([]);
    expect(coordinator.ownsExecution('chat-1')).toBe(false);
  });

  it('pauses queued work for a plain Stop instead of draining it', async () => {
    const first = deferred();
    const fixture = createFixture({
      turnRunner: {
        runAgentTurn: mock(() => first.promise),
        abortSession: mock(async () => true),
      },
    });
    coordinator = fixture.coordinator;
    const reservation = coordinator.reserveDirectTurn('chat-1', { turnId: 'turn-1' });
    const run = coordinator.runReservedTurn(reservation, 'first', { turnId: 'turn-1' });
    await coordinator.createChatQueueEntry('chat-1', 'keep queued');

    const stopped = await coordinator.stopActiveTurn('chat-1');

    expect(stopped.outcome).toBe('interrupt-requested');
    expect(stopped.control.pause).toMatchObject({ kind: 'manual' });
    expect(stopped.control.entries).toMatchObject([{ content: 'keep queued' }]);
    expect(fixture.turnRunner.runAgentTurn).toHaveBeenCalledTimes(1);
    first.resolve();
    await run;
  });

  it('stops a reserved turn before the provider run starts', async () => {
    const fixture = createFixture({
      turnRunner: {
        runAgentTurn: mock(rejectWhenExecutionAdmissionAborts),
      },
    });
    coordinator = fixture.coordinator;
    const reservation = coordinator.reserveDirectTurn('chat-1', { turnId: 'turn-1' });
    const run = coordinator.runReservedTurn(reservation, 'work', { turnId: 'turn-1' });
    await waitFor(() => fixture.turnRunner.runAgentTurn.mock.calls.length === 1);

    const stopped = await coordinator.stopActiveTurn('chat-1');

    expect(stopped.outcome).toBe('interrupt-requested');
    expect(reservation.executionAdmission.signal.aborted).toBe(true);
    expect(coordinator.ownsExecution('chat-1')).toBe(false);
    await expect(run).rejects.toThrow('Turn interrupted by the user');
  });

  it('cancels reserved admission before waiting for provider interruption', async () => {
    const abort = deferred();
    const fixture = createFixture({
      turnRunner: {
        abortSession: mock(() => abort.promise),
      },
    });
    coordinator = fixture.coordinator;
    const reservation = coordinator.reserveDirectTurn('chat-1', { turnId: 'turn-1' });

    const stop = coordinator.stopActiveTurn('chat-1');
    await waitFor(() => fixture.turnRunner.abortSession.mock.calls.length === 1);

    expect(reservation.executionAdmission.signal.aborted).toBe(true);
    abort.resolve(true);
    expect((await stop).outcome).toBe('interrupt-requested');
    expect(coordinator.ownsExecution('chat-1')).toBe(false);
  });

  it('stops a dequeued turn before the provider run starts', async () => {
    const failures = [];
    const fixture = createFixture({
      turnRunner: {
        runAgentTurn: mock(rejectWhenExecutionAdmissionAborts),
      },
    });
    coordinator = fixture.coordinator;
    coordinator.onTurnFailed((_chatId, message) => failures.push(message));
    await coordinator.createChatQueueEntry('chat-1', 'queued');
    const drain = coordinator.triggerDrain('chat-1');
    await waitFor(() => fixture.turnRunner.runAgentTurn.mock.calls.length === 1);
    const options = fixture.turnRunner.runAgentTurn.mock.calls[0][2];

    const stopped = await coordinator.stopActiveTurn('chat-1');
    await drain;

    expect(stopped.outcome).toBe('interrupt-requested');
    expect(options.executionAdmission.signal.aborted).toBe(true);
    expect(coordinator.ownsExecution('chat-1')).toBe(false);
    expect(failures).toEqual([]);
  });

  it('treats interruption while idle as a no-op', async () => {
    const fixture = createFixture();
    coordinator = fixture.coordinator;

    await expect(coordinator.interruptActiveTurn('chat-1')).resolves.toBe('already-idle');

    expect(fixture.turnRunner.abortSession).toHaveBeenCalledTimes(1);
    expect(coordinator.ownsExecution('chat-1')).toBe(false);
  });

  it('coalesces simultaneous interruption requests around one provider abort', async () => {
    const abort = deferred();
    const fixture = createFixture({
      turnRunner: { abortSession: mock(() => abort.promise) },
    });
    coordinator = fixture.coordinator;

    const first = coordinator.interruptActiveTurn('chat-1');
    const second = coordinator.interruptActiveTurn('chat-1');
    abort.resolve(false);

    await expect(Promise.all([first, second])).resolves.toEqual(['already-idle', 'already-idle']);
    expect(fixture.turnRunner.abortSession).toHaveBeenCalledTimes(1);
  });

  it('clears ephemeral queue and ownership state when a chat is deleted', async () => {
    await coordinator.createChatQueueEntry('chat-1', 'discard me');
    const snapshot = coordinator.reserveTranscriptSnapshot('chat-2');

    await coordinator.deleteChatQueueFile('chat-1');
    await coordinator.deleteChatQueueFile('chat-2');

    expect((await coordinator.readChatExecutionControl('chat-1')).entries).toEqual([]);
    expect(coordinator.ownsExecution('chat-2')).toBe(false);
    await coordinator.releaseTranscriptSnapshot(snapshot);
  });
});
