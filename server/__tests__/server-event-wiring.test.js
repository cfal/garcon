import { describe, expect, it, mock } from 'bun:test';
import { AssistantMessage, UserMessage } from '../../common/chat-types.js';
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
  const settingsListeners = {};
  const noOpSubscription = mock(() => undefined);
  const pendingInputs = overrides.pendingInputs ?? new PendingUserInputService({
    loadNativeMessages: mock(async () => []),
    getRetainedHistoryMessages: mock(() => []),
  });
  const agentRegistry = {
    onMessages: mock((callback) => { agentListeners.messages = callback; }),
    onProcessing: mock((callback) => { agentListeners.processing = callback; }),
    onSessionCreated: noOpSubscription,
    onFinished: mock((callback) => { agentListeners.finished = callback; }),
    onFailed: mock((callback) => { agentListeners.failed = callback; }),
    discardTurn: mock(() => undefined),
    settleTurn: mock(() => undefined),
  };
  const queue = {
    onExecutionControlUpdated: noOpSubscription,
    onSessionStopRequested: noOpSubscription,
    onDispatching: noOpSubscription,
    onChatIdle: noOpSubscription,
    onChatMessages: noOpSubscription,
    onSessionStopped: mock((callback) => { queueListeners.sessionStopped = callback; }),
    onProcessingInvalidated: mock((callback) => { queueListeners.processing = callback; }),
    onTurnFailed: mock((callback) => { queueListeners.failed = callback; }),
    onTurnSettled: noOpSubscription,
    getQueuedTurnFinalization: mock(() => null),
    onAgentTurnTerminal: mock(() => undefined),
    checkChatIdle: mock(async () => undefined),
    ...overrides.queue,
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
    sourceMayHaveChanged: mock(() => undefined),
    catalogMayHaveChanged: mock(() => undefined),
    deleteChat: mock(() => undefined),
  };
  const chatRegistry = {
    getChat: mock(() => ({})),
    onChatAdded: noOpSubscription,
    onChatRemoved: noOpSubscription,
    onChatReadUpdated: noOpSubscription,
    onChatProjectPathUpdated: noOpSubscription,
    ...overrides.chatRegistry,
  };
  const wiring = wireServerEvents({
    server: overrides.server ?? { publish: mock(() => undefined) },
    agentRegistry,
    chatRegistry,
    settings: {
      onSessionNameChanged: noOpSubscription,
      onListChanged: mock((callback) => { settingsListeners.listChanged = callback; }),
      onRemoteSettingsChanged: noOpSubscription,
    },
    queue,
    processing: overrides.processing ?? { phase: mock(() => null) },
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
    settingsListeners,
    wiring,
    metadata,
    chatViews,
    commandLedger,
    searchIndex,
  };
}

describe('server event wiring', () => {
  it('broadcasts the generic chat reorder invalidation', () => {
    const published = [];
    const fixture = createWiringFixture({
      server: {
        publish: mock((_topic, payload) => published.push(JSON.parse(payload))),
      },
    });

    fixture.settingsListeners.listChanged('chats-reordered', 'chat-1');

    expect(published).toEqual([{
      type: 'chat-list-refresh-requested',
      reason: 'chats-reordered',
      chatId: 'chat-1',
    }]);
  });

  it('publishes canonical processing phases before the Stop outcome', async () => {
    let phase = 'running';
    const published = [];
    const fixture = createWiringFixture({
      processing: { phase: mock(() => phase) },
      server: {
        publish: mock((_topic, payload) => published.push(JSON.parse(payload))),
      },
    });

    phase = 'stopping';
    fixture.queueListeners.sessionStopped(
      'chat-1',
      'interrupt-requested',
      'stop',
      'stop-1',
      12,
    );
    await fixture.wiring.waitForIdle();

    expect(published).toMatchObject([
      { type: 'chat-processing-updated', chatId: 'chat-1', phase: 'stopping' },
      {
        type: 'chat-session-stopped',
        chatId: 'chat-1',
        outcome: 'interrupt-requested',
        intent: 'stop',
      },
    ]);
  });

  it('publishes an idle repair before an already-idle Stop outcome', async () => {
    const published = [];
    const fixture = createWiringFixture({
      server: {
        publish: mock((_topic, payload) => published.push(JSON.parse(payload))),
      },
    });

    fixture.queueListeners.sessionStopped('chat-1', 'already-idle', 'stop', 'stop-1', 3);
    await fixture.wiring.waitForIdle();

    expect(published).toMatchObject([
      { type: 'chat-processing-updated', chatId: 'chat-1', phase: null },
      {
        type: 'chat-session-stopped',
        chatId: 'chat-1',
        outcome: 'already-idle',
        intent: 'stop',
      },
    ]);
  });

  it('publishes running before a rejected active Stop outcome', async () => {
    const published = [];
    const fixture = createWiringFixture({
      processing: { phase: mock(() => 'running') },
      server: {
        publish: mock((_topic, payload) => published.push(JSON.parse(payload))),
      },
    });

    fixture.queueListeners.sessionStopped('chat-1', 'failed', 'stop', 'stop-1', 8);
    await fixture.wiring.waitForIdle();

    expect(published).toMatchObject([
      { type: 'chat-processing-updated', chatId: 'chat-1', phase: 'running' },
      {
        type: 'chat-session-stopped',
        chatId: 'chat-1',
        outcome: 'failed',
        intent: 'stop',
      },
    ]);
  });

  it('recomputes processing phases for terminal, successor, and provider transitions', async () => {
    let phase = null;
    const published = [];
    const fixture = createWiringFixture({
      processing: { phase: mock(() => phase) },
      server: {
        publish: mock((_topic, payload) => published.push(JSON.parse(payload))),
      },
    });

    fixture.queueListeners.processing('chat-1');
    phase = 'running';
    fixture.queueListeners.processing('chat-1');
    fixture.agentListeners.processing('chat-1', false);
    await fixture.wiring.waitForIdle();

    expect(published).toEqual([
      { type: 'chat-processing-updated', chatId: 'chat-1', phase: null },
      { type: 'chat-processing-updated', chatId: 'chat-1', phase: 'running' },
      { type: 'chat-processing-updated', chatId: 'chat-1', phase: 'running' },
    ]);
  });

  it('broadcasts a turn\'s final message before its terminal processing transition', async () => {
    const published = [];
    const append = deferred();
    const finalReply = new AssistantMessage('2026-06-01T00:00:00.000Z', 'final reply');
    let phase = 'running';
    let invalidate;
    const fixture = createWiringFixture({
      server: {
        publish: mock((_topic, payload) => published.push(JSON.parse(payload))),
      },
      processing: { phase: mock(() => phase) },
      chatViews: {
        appendAfterEnsuringGeneration: mock(() => append.promise),
      },
      queue: {
        onProcessingInvalidated: mock((callback) => { invalidate = callback; }),
        onAgentTurnTerminal: mock(() => {
          phase = null;
          invalidate('chat-1');
        }),
      },
    });

    fixture.agentListeners.messages('chat-1', [finalReply], { turnId: 'turn-1' });
    fixture.agentListeners.finished('chat-1', 0, { turnId: 'turn-1' });
    append.resolve({
      generationId: 'generation-1',
      messages: [{ seq: 1, message: finalReply }],
      lastSeq: 1,
    });
    await fixture.wiring.waitForIdle();

    const types = published.map((message) => message.type);
    expect(types.indexOf('chat-messages')).toBeGreaterThanOrEqual(0);
    expect(types.indexOf('chat-messages'))
      .toBeLessThan(types.indexOf('chat-processing-updated'));
    expect(types.indexOf('chat-processing-updated'))
      .toBeLessThan(types.indexOf('agent-run-finished'));
  });

  it('preserves stop transitions after a pending turn message', async () => {
    const published = [];
    const append = deferred();
    const finalReply = new AssistantMessage('2026-06-01T00:00:00.000Z', 'final reply');
    let phase = 'stopping';
    let invalidate;
    const fixture = createWiringFixture({
      server: {
        publish: mock((_topic, payload) => published.push(JSON.parse(payload))),
      },
      processing: { phase: mock(() => phase) },
      chatViews: {
        appendAfterEnsuringGeneration: mock(() => append.promise),
      },
      queue: {
        onProcessingInvalidated: mock((callback) => { invalidate = callback; }),
        onAgentTurnTerminal: mock(() => {
          phase = null;
          invalidate('chat-1');
        }),
      },
    });

    fixture.agentListeners.messages('chat-1', [finalReply], { turnId: 'turn-1' });
    invalidate('chat-1');
    fixture.queueListeners.sessionStopped(
      'chat-1',
      'interrupt-requested',
      'stop',
      'stop-1',
      12,
    );
    fixture.agentListeners.finished('chat-1', 0, { turnId: 'turn-1' });
    append.resolve({
      generationId: 'generation-1',
      messages: [{ seq: 1, message: finalReply }],
      lastSeq: 1,
    });
    await fixture.wiring.waitForIdle();

    expect(published.map((message) => ({
      type: message.type,
      ...(message.type === 'chat-processing-updated' ? { phase: message.phase } : {}),
    }))).toEqual([
      { type: 'chat-messages' },
      { type: 'chat-processing-updated', phase: 'stopping' },
      { type: 'chat-processing-updated', phase: 'stopping' },
      { type: 'chat-session-stopped' },
      { type: 'chat-processing-updated', phase: null },
      { type: 'agent-run-finished' },
    ]);
  });

  it('broadcasts a turn\'s final message before its failure transition', async () => {
    const published = [];
    const append = deferred();
    const finalReply = new AssistantMessage('2026-06-01T00:00:00.000Z', 'final reply');
    let phase = 'running';
    let invalidate;
    const fixture = createWiringFixture({
      server: {
        publish: mock((_topic, payload) => published.push(JSON.parse(payload))),
      },
      processing: { phase: mock(() => phase) },
      chatViews: {
        appendAfterEnsuringGeneration: mock(() => append.promise),
      },
      queue: {
        onProcessingInvalidated: mock((callback) => { invalidate = callback; }),
        onAgentTurnTerminal: mock(() => {
          phase = null;
          invalidate('chat-1');
        }),
      },
    });

    fixture.agentListeners.messages('chat-1', [finalReply], { turnId: 'turn-1' });
    fixture.agentListeners.failed('chat-1', 'provider failed', { turnId: 'turn-1' });
    append.resolve({
      generationId: 'generation-1',
      messages: [{ seq: 1, message: finalReply }],
      lastSeq: 1,
    });
    await fixture.wiring.waitForIdle();

    const types = published.map((message) => message.type);
    expect(types.indexOf('chat-messages')).toBeGreaterThanOrEqual(0);
    expect(types.indexOf('chat-messages'))
      .toBeLessThan(types.indexOf('chat-processing-updated'));
    expect(types.indexOf('chat-processing-updated'))
      .toBeLessThan(types.indexOf('agent-run-failed'));
  });

  it('skips queued lifecycle broadcasts after the chat is removed', async () => {
    const published = [];
    const appendStarted = deferred();
    const append = deferred();
    let chatExists = true;
    const fixture = createWiringFixture({
      server: {
        publish: mock((_topic, payload) => published.push(JSON.parse(payload))),
      },
      processing: { phase: mock(() => 'stopping') },
      chatRegistry: {
        getChat: mock(() => chatExists ? {} : null),
      },
      chatViews: {
        appendAfterEnsuringGeneration: mock(() => {
          appendStarted.resolve();
          return append.promise;
        }),
      },
    });

    fixture.agentListeners.messages(
      'chat-1',
      [new AssistantMessage('2026-06-01T00:00:00.000Z', 'final reply')],
      { turnId: 'turn-1' },
    );
    await appendStarted.promise;
    fixture.queueListeners.processing('chat-1');
    fixture.queueListeners.sessionStopped(
      'chat-1',
      'interrupt-requested',
      'stop',
      'stop-1',
      12,
    );
    chatExists = false;
    append.resolve({
      generationId: 'generation-1',
      messages: [],
      lastSeq: 0,
    });
    await fixture.wiring.waitForIdle();

    expect(published.filter((message) =>
      message.type === 'chat-processing-updated'
      || message.type === 'chat-session-stopped')).toEqual([]);
  });

  it('clears optimistic processing before publishing a queued launch failure', async () => {
    const published = [];
    const fixture = createWiringFixture({
      server: {
        publish: mock((_topic, payload) => published.push(JSON.parse(payload))),
      },
    });

    fixture.queueListeners.failed('chat-1', 'launch failed', { turnId: 'turn-1' });
    await fixture.wiring.waitForIdle();

    expect(published.map((message) => message.type)).toEqual([
      'chat-processing-updated',
      'agent-run-failed',
    ]);
    expect(published[0]).toMatchObject({
      chatId: 'chat-1',
      phase: null,
    });
  });

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
    expect(fixture.searchIndex.sourceMayHaveChanged).not.toHaveBeenCalled();
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
      onExecutionControlUpdated: mock(() => undefined),
      onSessionStopRequested: mock((callback) => { queueListeners.stopRequested = callback; }),
      onDispatching: mock(() => undefined),
      onChatIdle: mock(() => undefined),
      onChatMessages: mock(() => undefined),
      onSessionStopped: mock((callback) => { queueListeners.sessionStopped = callback; }),
      onProcessingInvalidated: mock(() => undefined),
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
      processing: { phase: mock(() => null) },
      metadata: {},
      chatViews: {},
      idleReconciler: { noteIdle: () => undefined, ensureReconciled: async () => undefined },
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
    queueListeners.sessionStopped(chatId, 'interrupt-requested', 'interrupt-and-send', 'stop-a', 5);
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
      onExecutionControlUpdated: mock(() => undefined),
      onSessionStopRequested: mock((callback) => { queueListeners.stopRequested = callback; }),
      onDispatching: mock(() => undefined),
      onChatIdle: mock(() => undefined),
      onChatMessages: mock(() => undefined),
      onSessionStopped: mock((callback) => { queueListeners.sessionStopped = callback; }),
      onProcessingInvalidated: mock(() => undefined),
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
      processing: { phase: mock(() => null) },
      metadata: {},
      chatViews: { appendToCurrentOrProvisional: mock(async () => ({ messages: [] })) },
      idleReconciler: { noteIdle: () => undefined, ensureReconciled: async () => undefined },
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

    queueListeners.sessionStopped(chatId, 'failed', 'stop', 'stop-a', 7);
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
