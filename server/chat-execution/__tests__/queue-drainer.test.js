import { describe, expect, it, mock } from 'bun:test';
import { QueueDrainer } from '../queue-drainer.ts';
import { DomainError } from '../../lib/domain-error.ts';

const TS = '2026-08-15T00:00:00.000Z';

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
        dequeueNextTurn: mock(async (chatId, admit) => {
          expect(chatId).toBe('chat-1');
          expect(admit({ kind: 'user', entry })).toBe(true);
          throw failure;
        }),
      },
      turnRunner: {
        isChatRunning: () => false,
      },
      getDrainOptions: () => ({}),
      runSelectionAdmissionExclusive: (chatId, operation) => operation(),
      callbacks: {
        isShuttingDown: () => false,
        registerQueued: mock(() => true),
        appendControlReceipt: mock(() => undefined),
        discardPreparedInput,
        publishIdle: mock(() => undefined),
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
        dequeueNextTurn: mock(async (_chatId, admit) => {
          const input = { kind: 'user', entry };
          return { input, control: {}, inserted: admit(input) };
        }),
      },
      turnRunner: {
        isChatRunning: () => false,
        runAgentTurn,
      },
      getDrainOptions: () => ({}),
      runSelectionAdmissionExclusive: (chatId, operation) => operation(),
      callbacks: {
        isShuttingDown: () => {
          shutdownChecks += 1;
          return shutdownChecks > 1;
        },
        registerQueued: mock(() => true),
        appendControlReceipt: mock(() => undefined),
        discardPreparedInput: mock(() => undefined),
        publishIdle: mock(() => undefined),
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
        read: mock(async () => ({
          serverInstanceId: 'server-1',
          entries: [],
          controlEntries: [],
          recentlyDispatched: [],
          appliedCommands: [],
          pause: null,
          reorderRevision: 0,
          version: 1,
          updatedAt: TS,
        })),
      },
      turnRunner: {
        isChatRunning: () => false,
        runAgentTurn,
      },
      getDrainOptions: () => ({}),
      runSelectionAdmissionExclusive: (chatId, operation) => operation(),
      callbacks: {
        isShuttingDown: () => false,
        registerQueued,
        appendControlReceipt: mock(() => undefined),
        discardPreparedInput: mock(() => undefined),
        publishIdle: mock(() => undefined),
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
        dequeueNextTurn: mock(async (_chatId, admit) => {
          const input = { kind: 'user', entry };
          return { input, control: {}, inserted: admit(input) };
        }),
      },
      turnRunner: {
        isChatRunning: () => attempt?.isSettled ?? false,
        runAgentTurn: mock(() => providerRun),
      },
      getDrainOptions: () => ({}),
      runSelectionAdmissionExclusive: (chatId, operation) => operation(),
      callbacks: {
        isShuttingDown: () => false,
        registerQueued: mock(() => true),
        appendControlReceipt: mock(() => undefined),
        discardPreparedInput: mock(() => undefined),
        publishIdle: mock(() => undefined),
        publishTurnFailed,
        retireAttempt: mock(() => undefined),
      },
    });

    await drainer.run('chat-1');
    rejectProvider(new Error('late provider rejection'));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(publishTurnFailed).not.toHaveBeenCalled();
  });

  it('runs the dequeue transition and synchronous admission inside the selection admission lock', async () => {
    const { KeyedPromiseLock } = await import('../../lib/keyed-lock.js');
    const lock = new KeyedPromiseLock();
    const events = [];
    const drainer = new QueueDrainer({
      ownership: {
        hasSuppression: () => false,
        hasDirect: () => false,
        attempt: () => null,
      },
      controls: {
        dequeueNextTurn: mock(async (chatId, admit) => {
          events.push('dequeue:begin');
          admit({
            kind: 'user',
            entry: {
              id: 'entry-1',
              createdAt: TS,
              updatedAt: TS,
              status: 'queued',
              submission: { clientMessageId: 'message-1', transcriptViewId: 'view-1' },
            },
          });
          events.push('dequeue:end');
          return null;
        }),
        read: mock(async () => ({ entries: [], controlEntries: [], pause: null })),
      },
      turnRunner: { isChatRunning: () => false },
      getDrainOptions: () => ({}),
      runSelectionAdmissionExclusive: (chatId, operation) => {
        events.push('lock:enter');
        return lock.runExclusive(`chat:${chatId}`, async () => {
          const result = await operation();
          events.push('lock:exit');
          return result;
        });
      },
      callbacks: {
        isShuttingDown: () => false,
        registerQueued: mock(() => {
          events.push('admit');
          return true;
        }),
        appendControlReceipt: mock(() => {}),
        discardPreparedInput: mock(() => {}),
        publishIdle: mock(() => {}),
        publishTurnFailed: mock(() => {}),
        retireAttempt: mock(() => {}),
      },
    });

    await drainer.run('chat-1');
    expect(events).toEqual(['lock:enter', 'dequeue:begin', 'admit', 'dequeue:end', 'lock:exit']);
  });
});
