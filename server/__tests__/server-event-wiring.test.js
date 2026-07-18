import { describe, expect, it, mock } from 'bun:test';
import { UserMessage } from '../../common/chat-types.js';
import { PendingUserInputService } from '../chats/pending-user-input-service.js';
import { wireServerEvents } from '../server-event-wiring.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createWiringFixture(overrides = {}) {
  const agentListeners = {};
  const queueListeners = {};
  const noOpSubscription = mock(() => undefined);
  const pendingInputs = overrides.pendingInputs ?? new PendingUserInputService({
    loadNativeMessages: mock(async () => []),
    getRetainedHistoryMessages: mock(() => []),
  });
  const agentRegistry = {
    onMessages: mock((callback) => { agentListeners.messages = callback; }),
    onProcessing: noOpSubscription,
    onSessionCreated: noOpSubscription,
    onFinished: mock((callback) => { agentListeners.finished = callback; }),
    onFailed: mock((callback) => { agentListeners.failed = callback; }),
    discardTurn: mock(() => undefined),
    settleTurn: mock(() => undefined),
  };
  const queue = {
    onQueueUpdated: noOpSubscription,
    onSessionStopRequested: noOpSubscription,
    onDispatching: noOpSubscription,
    onChatMessages: noOpSubscription,
    onSessionStopped: noOpSubscription,
    onTurnFailed: mock((callback) => { queueListeners.failed = callback; }),
    onTurnSettled: noOpSubscription,
    getQueuedTurnFinalization: mock(() => null),
    onAgentTurnTerminal: mock(() => undefined),
    checkChatIdle: mock(async () => undefined),
  };
  const metadata = {
    updateFromAppendedMessages: mock(() => undefined),
  };
  const chatViews = {
    captureFence: mock(() => 0),
    appendAfterEnsuringGeneration: mock(async () => ({
      generationId: 'generation-1',
      messages: [],
      lastSeq: 0,
    })),
    ...overrides.chatViews,
  };
  const commandLedger = {
    settleTerminal: mock(async () => undefined),
    ...overrides.commandLedger,
  };
  const searchIndex = {
    appendMessages: mock(() => undefined),
    markDirty: mock(() => undefined),
    deleteChat: mock(() => undefined),
  };
  const wiring = wireServerEvents({
    server: { publish: mock(() => undefined) },
    agentRegistry,
    chatRegistry: {
      getChat: mock(() => ({})),
      onChatAdded: noOpSubscription,
      onChatRemoved: noOpSubscription,
      onChatReadUpdated: noOpSubscription,
      onChatProjectPathUpdated: noOpSubscription,
    },
    settings: {
      onSessionNameChanged: noOpSubscription,
      onListChanged: noOpSubscription,
      onRemoteSettingsChanged: noOpSubscription,
    },
    queue,
    metadata,
    chatViews,
    chatNativeReloader: {
      reloadFromNative: mock(async () => ({
        generationId: 'generation-2',
        messages: [],
        lastSeq: 0,
      })),
    },
    pendingInputs,
    pendingRecovery: { waitForSettlements: mock(async () => undefined) },
    commandLedger,
    shareStore: { revokeShareByChatId: mock(async () => undefined) },
    telegramNotifier: {},
    telegramSettings: { onChanged: noOpSubscription },
    scheduledPrompts: { onInvalidated: noOpSubscription },
    snippets: { onInvalidated: noOpSubscription },
    loadNativeMessages: mock(async () => []),
    searchIndex,
  });
  return {
    agentListeners,
    queueListeners,
    wiring,
    metadata,
    chatViews,
    commandLedger,
    searchIndex,
  };
}

describe('server event wiring', () => {
  it('settles every direct execution command only at its exact terminal event', async () => {
    const fixture = createWiringFixture();

    fixture.agentListeners.finished('chat-1', 0, {
      clientRequestId: 'req-run',
      commandType: 'agent-run',
      turnId: 'turn-run',
    });
    fixture.agentListeners.finished('chat-2', 0, {
      clientRequestId: 'req-compact',
      commandType: 'agent-compact',
      turnId: 'turn-compact',
    });
    await fixture.wiring.waitForIdle();

    expect(fixture.commandLedger.settleTerminal).toHaveBeenCalledWith(
      'agent-run:chat-1:req-run',
      'finished',
      {},
    );
    expect(fixture.commandLedger.settleTerminal).toHaveBeenCalledWith(
      'agent-compact:chat-2:req-compact',
      'finished',
      {},
    );
  });

  it('indexes only messages committed by transcript deduplication', async () => {
    const fixture = createWiringFixture();

    fixture.agentListeners.messages('chat-1', [new UserMessage(
      '2026-06-01T00:00:00.000Z',
      'duplicate',
      undefined,
      { clientRequestId: 'req-duplicate' },
    )]);
    await fixture.wiring.waitForIdle();

    expect(fixture.metadata.updateFromAppendedMessages).not.toHaveBeenCalled();
    expect(fixture.searchIndex.appendMessages).not.toHaveBeenCalled();
  });

  it('reports terminal settlement failures to the shutdown drain', async () => {
    const settlementError = new Error('ledger unavailable');
    const fixture = createWiringFixture({
      commandLedger: {
        settleTerminal: mock(async () => { throw settlementError; }),
      },
    });

    fixture.agentListeners.finished('chat-1', 0, {
      clientRequestId: 'req-run',
      commandType: 'agent-run',
      turnId: 'turn-run',
    });

    await expect(fixture.wiring.waitForIdle()).rejects.toBe(settlementError);
  });

  it('classifies an expected terminal before queue settlement can retire its identity', async () => {
    const chatId = 'chat-1';
    const turn = { clientRequestId: 'req-a', turnId: 'turn-a' };
    const timestamp = '2026-06-01T00:00:00.000Z';
    const nativeLoadStarted = deferred();
    const releaseNativeLoad = deferred();
    const loadNativeMessages = mock(async () => {
      nativeLoadStarted.resolve();
      return releaseNativeLoad.promise;
    });
    const pendingInputs = new PendingUserInputService({
      loadNativeMessages,
      getRetainedHistoryMessages: mock(() => []),
    });
    await pendingInputs.register(chatId, 'interrupted', {
      ...turn,
      createdAt: timestamp,
    });

    const agentListeners = {};
    const queueListeners = {};
    const agentRegistry = {
      onMessages: mock(() => undefined),
      onProcessing: mock(() => undefined),
      onSessionCreated: mock(() => undefined),
      onFinished: mock((callback) => { agentListeners.finished = callback; }),
      onFailed: mock(() => undefined),
      discardTurn: mock(() => undefined),
      settleTurn: mock(() => undefined),
    };
    const queue = {
      onQueueUpdated: mock(() => undefined),
      onSessionStopRequested: mock((callback) => { queueListeners.stopRequested = callback; }),
      onDispatching: mock(() => undefined),
      onChatMessages: mock(() => undefined),
      onSessionStopped: mock((callback) => { queueListeners.sessionStopped = callback; }),
      onTurnFailed: mock(() => undefined),
      onTurnSettled: mock((callback) => { queueListeners.turnSettled = callback; }),
      getQueuedTurnFinalization: mock(() => null),
      onAgentTurnTerminal: mock((terminalChatId, terminalTurn) => {
        pendingInputs.store.upsert({
          chatId: terminalChatId,
          clientRequestId: 'req-b',
          turnId: 'turn-b',
          content: 'successor',
          createdAt: timestamp,
          deliveryStatus: 'accepted',
        });
        queueListeners.turnSettled(terminalChatId, terminalTurn);
      }),
      checkChatIdle: mock(async () => undefined),
    };
    const noOpSubscription = mock(() => undefined);

    wireServerEvents({
      server: { publish: mock(() => undefined) },
      agentRegistry,
      chatRegistry: {
        getChat: mock(() => ({})),
        onChatAdded: noOpSubscription,
        onChatRemoved: noOpSubscription,
        onChatReadUpdated: noOpSubscription,
        onChatProjectPathUpdated: noOpSubscription,
      },
      settings: {
        onSessionNameChanged: noOpSubscription,
        onListChanged: noOpSubscription,
        onRemoteSettingsChanged: noOpSubscription,
      },
      queue,
      metadata: {},
      chatViews: {},
      chatNativeReloader: {},
      pendingInputs,
      pendingRecovery: { waitForSettlements: mock(async () => undefined) },
      commandLedger: {},
      shareStore: {},
      telegramNotifier: {},
      telegramSettings: { onChanged: noOpSubscription },
      scheduledPrompts: { onInvalidated: noOpSubscription },
      snippets: { onInvalidated: noOpSubscription },
      loadNativeMessages: mock(async () => []),
    });

    queueListeners.stopRequested(chatId, 'stop-a', turn);
    queueListeners.sessionStopped(chatId, true, 'interrupt-and-send', 'stop-a');
    agentListeners.finished(chatId, 0, turn);
    await nativeLoadStarted.promise;
    releaseNativeLoad.resolve([new UserMessage(timestamp, 'successor')]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(loadNativeMessages).toHaveBeenCalledTimes(1);
    expect(pendingInputs.listForChat(chatId)).toMatchObject([
      { clientRequestId: 'req-a', deliveryStatus: 'unconfirmed' },
      { clientRequestId: 'req-b', deliveryStatus: 'accepted' },
    ]);
    expect(agentRegistry.settleTurn).toHaveBeenCalledWith(chatId, turn);
  });

  it('releases a provider failure when the pending stop acknowledgement is rejected', async () => {
    const chatId = 'chat-1';
    const turn = { clientRequestId: 'req-a', turnId: 'turn-a' };
    const pendingInputs = new PendingUserInputService({
      loadNativeMessages: mock(async () => []),
      getRetainedHistoryMessages: mock(() => []),
    });
    await pendingInputs.register(chatId, 'still running', {
      ...turn,
      createdAt: '2026-06-01T00:00:00.000Z',
    });

    const published = [];
    const agentListeners = {};
    const queueListeners = {};
    const reloadFromNative = mock(async () => ({
      mode: 'process-error',
      generationId: 'generation-2',
      messages: [],
      lastSeq: 0,
      pageOldestSeq: 1,
      hasMore: false,
    }));
    const agentRegistry = {
      onMessages: mock(() => undefined),
      onProcessing: mock(() => undefined),
      onSessionCreated: mock(() => undefined),
      onFinished: mock(() => undefined),
      onFailed: mock((callback) => { agentListeners.failed = callback; }),
      discardTurn: mock(() => undefined),
      settleTurn: mock(() => undefined),
    };
    const queue = {
      onQueueUpdated: mock(() => undefined),
      onSessionStopRequested: mock((callback) => { queueListeners.stopRequested = callback; }),
      onDispatching: mock(() => undefined),
      onChatMessages: mock(() => undefined),
      onSessionStopped: mock((callback) => { queueListeners.sessionStopped = callback; }),
      onTurnFailed: mock(() => undefined),
      onTurnSettled: mock((callback) => { queueListeners.turnSettled = callback; }),
      getQueuedTurnFinalization: mock(() => null),
      onAgentTurnTerminal: mock((terminalChatId, terminalTurn) => {
        queueListeners.turnSettled(terminalChatId, terminalTurn);
      }),
      checkChatIdle: mock(async () => undefined),
    };
    const noOpSubscription = mock(() => undefined);

    wireServerEvents({
      server: {
        publish: mock((_topic, payload) => {
          published.push(JSON.parse(payload));
        }),
      },
      agentRegistry,
      chatRegistry: {
        getChat: mock(() => ({})),
        onChatAdded: noOpSubscription,
        onChatRemoved: noOpSubscription,
        onChatReadUpdated: noOpSubscription,
        onChatProjectPathUpdated: noOpSubscription,
      },
      settings: {
        onSessionNameChanged: noOpSubscription,
        onListChanged: noOpSubscription,
        onRemoteSettingsChanged: noOpSubscription,
      },
      queue,
      metadata: {},
      chatViews: { appendToCurrentOrProvisional: mock(async () => ({ messages: [] })) },
      chatNativeReloader: { reloadFromNative },
      pendingInputs,
      pendingRecovery: { waitForSettlements: mock(async () => undefined) },
      commandLedger: {},
      shareStore: {},
      telegramNotifier: {},
      telegramSettings: { onChanged: noOpSubscription },
      scheduledPrompts: { onInvalidated: noOpSubscription },
      snippets: { onInvalidated: noOpSubscription },
      loadNativeMessages: mock(async () => []),
    });

    queueListeners.stopRequested(chatId, 'stop-a', turn);
    agentListeners.failed(chatId, 'provider failed independently', turn);
    await Promise.resolve();

    expect(reloadFromNative).not.toHaveBeenCalled();
    expect(published.some((message) => message.type === 'agent-run-failed')).toBe(false);

    queueListeners.sessionStopped(chatId, false, 'stop', 'stop-a');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(reloadFromNative).toHaveBeenCalledWith(
      chatId,
      'process-error',
      'provider failed independently',
    );
    expect(published).toContainEqual(expect.objectContaining({
      type: 'agent-run-failed',
      chatId,
      error: 'provider failed independently',
      turnId: 'turn-a',
      clientRequestId: 'req-a',
    }));
  });
});
