import { describe, expect, it, mock } from 'bun:test';
import { QueueDrainer } from '../queue-drainer.ts';
import { emptyStoredChatExecutionControl } from '../control-state.ts';

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
        dequeueNextTurn: mock(async (chatId, canDispatch, admit) => {
          expect(chatId).toBe('chat-1');
          expect(canDispatch()).toBe(true);
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

  it('rechecks settings suppression inside dequeue before resolving execution options', async () => {
    let settingsHeld = false;
    const getDrainOptions = mock(() => ({}));
    const dequeueNextTurn = mock(async (_chatId, canDispatch) => {
      settingsHeld = true;
      return canDispatch() ? { input: null } : null;
    });
    const drainer = new QueueDrainer({
      ownership: {
        hasSuppression: (_chatId, reason) => reason === 'settings-mutation' && settingsHeld,
        hasDirect: () => false,
        attempt: () => null,
      },
      controls: {
        dequeueNextTurn,
        read: mock(async () => emptyStoredChatExecutionControl('server-test')),
      },
      turnRunner: { isChatRunning: () => false },
      getDrainOptions,
      callbacks: {
        isShuttingDown: () => false,
        registerQueued: mock(() => true),
        appendControlReceipt: mock(() => undefined),
        discardPreparedInput: mock(() => undefined),
        publishIdle: mock(() => undefined),
        publishTurnFailed: mock(() => undefined),
        retireAttempt: mock(() => undefined),
      },
    });

    await drainer.run('chat-1');

    expect(dequeueNextTurn).toHaveBeenCalledTimes(1);
    expect(getDrainOptions).not.toHaveBeenCalled();
  });
});
