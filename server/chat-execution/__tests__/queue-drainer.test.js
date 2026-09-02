import { describe, expect, it, mock } from 'bun:test';
import { QueueDrainer } from '../queue-drainer.ts';

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
});
