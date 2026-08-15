import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { ChatExecutionCoordinator } from '../chat-execution-coordinator.js';
import { InMemoryChatExecutionControlRepository } from '../chat-execution-control-repository.ts';

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
    () => ({
      model: 'test-model',
      permissionMode: 'default',
      thinkingMode: 'none',
    }),
    () => true,
    new InMemoryChatExecutionControlRepository('server-instance-test'),
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

  it('keeps future-turn inputs out of the transcript until dequeue', async () => {
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
