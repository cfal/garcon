import { describe, expect, it, mock } from 'bun:test';
import { QueueDrainer } from '../queue-drainer.ts';
import { DomainError, ProjectUnavailableError } from '../../lib/domain-error.ts';

const TS = '2026-08-15T00:00:00.000Z';

function control(entries = []) {
  return {
    serverInstanceId: 'server-1',
    entries,
    controlEntries: [],
    recentlyDispatched: [],
    appliedCommands: [],
    pause: null,
    reorderRevision: 0,
    version: 1,
    updatedAt: TS,
  };
}

function availableProjectAdmission() {
  return { assertAvailable: mock(async () => undefined) };
}

function idleOwnership(overrides = {}) {
  return {
    hasSuppression: () => false,
    hasDirect: () => false,
    attempt: () => null,
    ...overrides,
  };
}

function queueCallbacks(overrides = {}) {
  return {
    isShuttingDown: () => false,
    registerQueued: mock(() => true),
    appendControlReceipt: mock(() => undefined),
    discardPreparedInput: mock(() => undefined),
    publishIdle: mock(() => undefined),
    publishProjectUnavailable: mock(() => undefined),
    publishTurnFailed: mock(() => undefined),
    retireAttempt: mock(() => undefined),
    ...overrides,
  };
}

describe('QueueDrainer', () => {
  it('discards a prepared input when queue removal fails after transcript admission', async () => {
    const failure = new Error('queue removal failed');
    const discardPreparedInput = mock(() => undefined);
    const entry = {
      id: 'entry-1',
      content: 'queued input',
      revision: 1,
      createdAt: TS,
      updatedAt: TS,
      status: 'queued',
      submission: {
        clientMessageId: 'message-1',
        transcriptViewId: 'view-1',
      },
    };
    const drainer = new QueueDrainer({
      ownership: {
        hasSuppression: () => false,
        hasDirect: () => false,
        attempt: () => null,
      },
      controls: {
        read: mock(async () => control([entry])),
        pause: mock(async () => ({ control: control([entry]), changed: true })),
        dequeueNextTurn: mock(async (chatId, admit) => {
          expect(chatId).toBe('chat-1');
          expect(admit({ kind: 'user', entry })).toBe(true);
          throw failure;
        }),
      },
      projectAdmission: availableProjectAdmission(),
      turnRunner: {
        isChatRunning: () => false,
      },
      getDrainOptions: () => ({}),
      callbacks: {
        isShuttingDown: () => false,
        registerQueued: mock(() => true),
        appendControlReceipt: mock(() => undefined),
        discardPreparedInput,
        publishIdle: mock(() => undefined),
        publishProjectUnavailable: mock(() => undefined),
        publishTurnFailed: mock(() => undefined),
        retireAttempt: mock(() => undefined),
      },
    });

    await expect(drainer.run('chat-1')).rejects.toBe(failure);
    expect(discardPreparedInput).toHaveBeenCalledOnce();
    expect(discardPreparedInput).toHaveBeenCalledWith('chat-1', 'message-1');
  });

  it('does not commit finalization for a turn dropped during shutdown', async () => {
    const entry = {
      id: 'entry-1',
      content: 'queued input',
      revision: 1,
      createdAt: TS,
      updatedAt: TS,
      status: 'queued',
      submission: null,
    };
    const settle = mock(() => undefined);
    const runAgentTurn = mock(async () => undefined);
    const retireAttempt = mock(() => undefined);
    let shutdownChecks = 0;
    const drainer = new QueueDrainer({
      ownership: {
        hasSuppression: () => false,
        hasDirect: () => false,
        attempt: () => null,
        installAttempt: () => ({ signal: new AbortController().signal }),
        beginFinalization: () => ({ settle }),
        setActiveDrainEntry: mock(() => undefined),
      },
      controls: {
        read: mock(async () => control([entry])),
        pause: mock(async () => ({ control: control([entry]), changed: true })),
        dequeueNextTurn: mock(async (_chatId, admit) => {
          const input = { kind: 'user', entry };
          return { input, control: {}, inserted: admit(input) };
        }),
      },
      projectAdmission: availableProjectAdmission(),
      turnRunner: {
        isChatRunning: () => false,
        runAgentTurn,
      },
      getDrainOptions: () => ({}),
      callbacks: {
        isShuttingDown: () => {
          shutdownChecks += 1;
          return shutdownChecks > 3;
        },
        registerQueued: mock(() => true),
        appendControlReceipt: mock(() => undefined),
        discardPreparedInput: mock(() => undefined),
        publishIdle: mock(() => undefined),
        publishProjectUnavailable: mock(() => undefined),
        publishTurnFailed: mock(() => undefined),
        retireAttempt,
      },
    });

    await drainer.run('chat-1');

    expect(settle).toHaveBeenCalledOnce();
    expect(settle).toHaveBeenCalledWith('not-committed');
    expect(retireAttempt).toHaveBeenCalledOnce();
    expect(runAgentTurn).not.toHaveBeenCalled();
  });

  it('removes a blocked preamble slash command and drains the next queued turn', async () => {
    const entries = [
      {
        id: 'entry-1',
        content: '/provider-command',
        revision: 1,
        createdAt: TS,
        updatedAt: TS,
        status: 'queued',
        submission: null,
      },
      {
        id: 'entry-2',
        content: 'regular input',
        revision: 1,
        createdAt: TS,
        updatedAt: TS,
        status: 'queued',
        submission: null,
      },
    ];
    const publishTurnFailed = mock(() => undefined);
    const runAgentTurn = mock(async () => undefined);
    const registerQueued = mock((_chatId, content) => {
      if (content.startsWith('/')) {
        throw new DomainError(
          'PREAMBLE_SLASH_COMMAND_BLOCKED',
          'Matching preambles haven’t been sent yet.',
          422,
        );
      }
      return true;
    });
    const drainer = new QueueDrainer({
      ownership: {
        hasSuppression: () => false,
        hasDirect: () => false,
        attempt: () => null,
        installAttempt: () => ({ signal: new AbortController().signal }),
        beginFinalization: () => ({ settle: mock(() => undefined) }),
        setActiveDrainEntry: mock(() => undefined),
      },
      controls: {
        dequeueNextTurn: mock(async (_chatId, admit) => {
          const entry = entries.shift();
          if (!entry) return null;
          const input = { kind: 'user', entry };
          return { input, control: {}, inserted: admit(input) };
        }),
        read: mock(async () => control([...entries])),
        pause: mock(async () => ({ control: control([...entries]), changed: true })),
      },
      projectAdmission: availableProjectAdmission(),
      turnRunner: {
        isChatRunning: () => false,
        runAgentTurn,
      },
      getDrainOptions: () => ({}),
      callbacks: {
        isShuttingDown: () => false,
        registerQueued,
        appendControlReceipt: mock(() => undefined),
        discardPreparedInput: mock(() => undefined),
        publishIdle: mock(() => undefined),
        publishProjectUnavailable: mock(() => undefined),
        publishTurnFailed,
        retireAttempt: mock(() => undefined),
      },
    });

    await drainer.run('chat-1');

    expect(entries).toHaveLength(0);
    expect(publishTurnFailed).toHaveBeenCalledTimes(1);
    expect(publishTurnFailed.mock.calls[0]?.[1]).toContain('preambles');
    expect(runAgentTurn).toHaveBeenCalledTimes(1);
    expect(runAgentTurn.mock.calls[0]?.[1]).toBe('regular input');
  });

  it('observes a provider rejection after the execution attempt settles first', async () => {
    const entry = {
      id: 'entry-1',
      content: 'queued input',
      revision: 1,
      createdAt: TS,
      updatedAt: TS,
      status: 'queued',
      submission: null,
    };
    let rejectProvider;
    const providerRun = new Promise((_resolve, reject) => {
      rejectProvider = reject;
    });
    let attempt;
    const publishTurnFailed = mock(() => undefined);
    const drainer = new QueueDrainer({
      ownership: {
        hasSuppression: () => false,
        hasDirect: () => false,
        attempt: () => null,
        installAttempt: (_chatId, installedAttempt) => {
          attempt = installedAttempt;
          queueMicrotask(() => installedAttempt.markSettled());
          return { signal: new AbortController().signal };
        },
        beginFinalization: () => ({ settle: mock(() => undefined) }),
        setActiveDrainEntry: mock(() => undefined),
      },
      controls: {
        read: mock(async () => control([entry])),
        pause: mock(async () => ({ control: control([entry]), changed: true })),
        dequeueNextTurn: mock(async (_chatId, admit) => {
          const input = { kind: 'user', entry };
          return { input, control: {}, inserted: admit(input) };
        }),
      },
      projectAdmission: availableProjectAdmission(),
      turnRunner: {
        isChatRunning: () => attempt?.isSettled ?? false,
        runAgentTurn: mock(() => providerRun),
      },
      getDrainOptions: () => ({}),
      callbacks: {
        isShuttingDown: () => false,
        registerQueued: mock(() => true),
        appendControlReceipt: mock(() => undefined),
        discardPreparedInput: mock(() => undefined),
        publishIdle: mock(() => undefined),
        publishProjectUnavailable: mock(() => undefined),
        publishTurnFailed,
        retireAttempt: mock(() => undefined),
      },
    });

    await drainer.run('chat-1');
    rejectProvider(new Error('late provider rejection'));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(publishTurnFailed).not.toHaveBeenCalled();
  });

  it('pauses an unavailable queue before dequeue or transcript admission', async () => {
    const entry = {
      id: 'entry-1',
      content: 'queued input',
      revision: 1,
      createdAt: TS,
      updatedAt: TS,
      status: 'queued',
      submission: null,
    };
    const pending = control([entry]);
    const dequeueNextTurn = mock(async () => null);
    const pause = mock(async () => ({ control: { ...pending, pause: { id: 'pause-1' } }, changed: true }));
    const callbacks = queueCallbacks();
    const unavailable = new ProjectUnavailableError('/workspace/missing', 'not-found');
    const drainer = new QueueDrainer({
      ownership: idleOwnership(),
      controls: { read: mock(async () => pending), pause, dequeueNextTurn },
      turnRunner: { isChatRunning: () => false, runAgentTurn: mock(async () => undefined) },
      getDrainOptions: () => ({}),
      projectAdmission: { assertAvailable: mock(async () => { throw unavailable; }) },
      callbacks,
    });

    await drainer.run('chat-1');

    expect(pause).toHaveBeenCalledWith('chat-1');
    expect(dequeueNextTurn).not.toHaveBeenCalled();
    expect(callbacks.registerQueued).not.toHaveBeenCalled();
    expect(callbacks.publishProjectUnavailable).toHaveBeenCalledWith('chat-1', unavailable);
    expect(callbacks.publishTurnFailed).not.toHaveBeenCalled();
  });

  it('does not resolve empty, paused, or steering-blocked queues', async () => {
    const queued = {
      id: 'entry-1',
      content: 'queued input',
      revision: 1,
      createdAt: TS,
      updatedAt: TS,
      status: 'queued',
      submission: null,
    };
    const assertAvailable = mock(async () => undefined);
    const cases = [
      control(),
      { ...control([queued]), pause: { id: 'pause-1', kind: 'manual', pausedAt: TS } },
      control([{ ...queued, status: 'steering' }]),
    ];

    for (const pending of cases) {
      const drainer = new QueueDrainer({
        ownership: idleOwnership(),
        controls: {
          read: mock(async () => pending),
          pause: mock(async () => ({ control: pending, changed: false })),
          dequeueNextTurn: mock(async () => null),
        },
        turnRunner: { isChatRunning: () => false, runAgentTurn: mock(async () => undefined) },
        getDrainOptions: () => ({}),
        projectAdmission: { assertAvailable },
        callbacks: queueCallbacks(),
      });
      await drainer.run('chat-1');
    }

    expect(assertAvailable).not.toHaveBeenCalled();
  });

  it('halts after deferred resolution when Stop acquires suppression', async () => {
    const entry = {
      id: 'entry-1',
      content: 'queued input',
      revision: 1,
      createdAt: TS,
      updatedAt: TS,
      status: 'queued',
      submission: null,
    };
    let suppressed = false;
    let finishResolution;
    const resolution = new Promise((resolve) => { finishResolution = resolve; });
    const resolutionStarted = Promise.withResolvers();
    const dequeueNextTurn = mock(async () => null);
    const drainer = new QueueDrainer({
      ownership: idleOwnership({ hasSuppression: () => suppressed }),
      controls: {
        read: mock(async () => control([entry])),
        pause: mock(async () => ({ control: control([entry]), changed: true })),
        dequeueNextTurn,
      },
      turnRunner: { isChatRunning: () => false, runAgentTurn: mock(async () => undefined) },
      getDrainOptions: () => ({}),
      projectAdmission: {
        assertAvailable: mock(async () => {
          resolutionStarted.resolve();
          await resolution;
        }),
      },
      callbacks: queueCallbacks(),
    });

    const drain = drainer.run('chat-1');
    await resolutionStarted.promise;
    suppressed = true;
    finishResolution();
    await drain;

    expect(dequeueNextTurn).not.toHaveBeenCalled();
  });
});
