import { describe, expect, it, mock } from 'bun:test';
import {
  AssistantMessage,
  BashToolUseMessage,
  PermissionRequestMessage,
  UserMessage,
} from '../../common/chat-types.js';
import { ChatViewStore } from '../chats/chat-view-store.js';
import { ChatTransientFeedStore } from '../chats/chat-transient-feed.js';
import {
  historyPage,
  transcriptSnapshot,
} from '../chats/__tests__/chat-transcript-test-helpers.js';
import {
  attachNativeMessageSource,
  getNativeMessageRevisionSource,
} from '../agents/shared/native-message-source.js';
import { PendingUserInputService } from '../chats/pending-user-input-service.js';
import { projectAgentTurnReceipt } from '../commands/agent-turn-receipt-projector.ts';
import { CommandLedger } from '../commands/command-ledger.ts';
import { emptyStoredChatExecutionControl } from '../chat-execution/control-state.ts';
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
  const chatRegistryListeners = {};
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
    onProjectionApplied: mock((callback) => { agentListeners.projectionApplied = callback; }),
    onInputSettled: mock((callback) => { agentListeners.inputSettled = callback; }),
    onProjectionFailure: mock((callback) => { agentListeners.projectionFailure = callback; }),
    repairProjection: mock(async () => true),
    discardTurn: mock(() => undefined),
    settleTurn: mock(() => undefined),
  };
  const queue = {
    onExecutionControlUpdated: mock((callback) => { queueListeners.executionControl = callback; }),
    onSessionStopRequested: noOpSubscription,
    onDispatching: noOpSubscription,
    onChatIdle: noOpSubscription,
    onSessionStopped: mock((callback) => { queueListeners.sessionStopped = callback; }),
    onProcessingInvalidated: mock((callback) => { queueListeners.processing = callback; }),
    onTurnFailed: mock((callback) => { queueListeners.failed = callback; }),
    onTurnSettled: noOpSubscription,
    getQueuedTurnFinalization: mock(() => null),
    onAgentTurnTerminal: mock(() => undefined),
    onAcceptedInputSettled: mock(() => undefined),
    replaceTurnWithTranscriptSnapshotReservation: mock(() => null),
    releaseTranscriptSnapshot: mock(async () => undefined),
    checkChatIdle: mock(async () => undefined),
    ...overrides.queue,
  };
  const metadata = {
    updateFromAppendedMessages: mock(() => undefined),
  };
  const chatViews = overrides.chatViewsInstance ?? {
    captureFence: mock(() => 0),
    deleteChatView: mock(() => undefined),
    getCursor: mock(() => ({ generationId: 'generation-1', lastSeq: 0 })),
    getOrCreatePage: mock(async () => ({ generationId: 'generation-1' })),
    replaceFromProjection: mock(async () => ({ generationId: 'generation-2' })),
    appendAfterEnsuringGeneration: mock(async () => ({
      generationId: 'generation-1',
      messages: [],
      lastSeq: 0,
    })),
    ...overrides.chatViews,
  };
  const commandLedger = overrides.commandLedgerInstance ?? {
    settleTerminal: mock(async () => undefined),
    appendAssistantMessages: mock(async () => undefined),
    appendProjectionAssistantMessages: mock(async () => undefined),
    finalizeProjectionOutput: mock(async () => undefined),
    markProjectionOutputUnavailable: mock(async () => undefined),
    markTurnOutputUnavailable: mock(async () => undefined),
    markPublicTerminal: mock(async () => undefined),
    publishDeferredTerminal: mock(async () => undefined),
    markChatInterrupted: mock(async () => undefined),
    ...overrides.commandLedger,
  };
  const searchIndex = {
    sourceMayHaveChanged: mock(() => undefined),
    catalogMayHaveChanged: mock(() => undefined),
    deleteChat: mock(() => undefined),
  };
  const idleReconciler = {
    noteIdle: mock(() => undefined),
    noteHistoryChanged: mock(() => undefined),
    ensureHistoryChangeReconciled: mock(async () => undefined),
    ...overrides.idleReconciler,
  };
  const chatRegistry = {
    getChat: mock(() => ({ agentOwnershipEpoch: 'ownership-1' })),
    onChatAdded: noOpSubscription,
    onChatRemoved: mock((callback) => { chatRegistryListeners.removed = callback; }),
    onChatReadUpdated: noOpSubscription,
    onChatProjectPathUpdated: noOpSubscription,
    onChatTagsUpdated: mock((callback) => { chatRegistryListeners.tagsUpdated = callback; }),
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
    transientFeeds: overrides.transientFeeds
      ?? new ChatTransientFeedStore('server-instance-test'),
    idleReconciler,
    chatNativeReloader: overrides.chatNativeReloader ?? {
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
    loadChatSnapshot: overrides.loadChatSnapshot ?? mock(async () => transcriptSnapshot([])),
    composeProjectionSnapshot: overrides.composeProjectionSnapshot
      ?? mock(async (_chatId, messages) => transcriptSnapshot(messages)),
    getCarryOverMessageCount: overrides.getCarryOverMessageCount ?? mock(async () => 0),
    loadChatPage: overrides.loadChatPage ?? mock(async () => historyPage([], 100, 0)),
    searchIndex,
  });
  return {
    agentListeners,
    queueListeners,
    settingsListeners,
    chatRegistryListeners,
    wiring,
    metadata,
    chatViews,
    commandLedger,
    searchIndex,
    idleReconciler,
  };
}

describe('server event wiring', () => {
  it('publishes ahead-imported rows with their original turn metadata before reconciliation', async () => {
    const history = [
      new AssistantMessage('2026-06-01T00:00:00.000Z', 'older one'),
      new AssistantMessage('2026-06-01T00:00:01.000Z', 'older two'),
    ];
    const chatViews = new ChatViewStore(() => false);
    await chatViews.getOrCreatePage('chat-1', {
      loadAll: async () => transcriptSnapshot(history),
      loadPage: async (limit, offset) => historyPage(history, limit, offset),
    }, 1);
    const firstSource = {
      entryId: 'turn:turn-1:item:message-1',
      withinSourceOrdinal: 0,
    };
    const secondSource = {
      entryId: 'turn:turn-2:item:message-2',
      withinSourceOrdinal: 0,
    };
    const firstNative = attachNativeMessageSource(
      new AssistantMessage('2026-06-01T00:00:02.000Z', 'persisted first'),
      firstSource,
    );
    const secondNative = attachNativeMessageSource(
      new AssistantMessage('2026-06-01T00:00:03.000Z', 'persisted second'),
      secondSource,
    );
    const firstLive = attachNativeMessageSource(
      new AssistantMessage('2026-06-01T00:00:02.000Z', 'persisted first'),
      firstSource,
    );
    const secondLive = attachNativeMessageSource(
      new AssistantMessage('2026-06-01T00:00:03.000Z', 'persisted second'),
      secondSource,
    );
    history.push(firstNative, secondNative);
    const published = [];
    const fixture = createWiringFixture({
      chatViewsInstance: chatViews,
      loadChatSnapshot: async () => transcriptSnapshot(history),
      loadChatPage: async (_chatId, limit, offset) => historyPage(history, limit, offset),
      server: {
        publish: mock((_topic, payload) => published.push(JSON.parse(payload))),
      },
    });

    const firstOwner = {
      agentOwnershipEpoch: 'ownership-1',
      commandType: 'agent-run',
      clientRequestId: 'request-1',
      turnId: 'turn-1',
    };
    const secondOwner = {
      agentOwnershipEpoch: 'ownership-1',
      commandType: 'agent-run',
      clientRequestId: 'request-2',
      turnId: 'turn-2',
    };
    fixture.agentListeners.messages('chat-1', [firstLive], { turnId: 'turn-1', turnOwner: firstOwner });
    fixture.agentListeners.messages('chat-1', [secondLive], { turnId: 'turn-2', turnOwner: secondOwner });
    fixture.agentListeners.messages('chat-1', [secondLive], { turnId: 'turn-2', turnOwner: secondOwner });
    await fixture.wiring.waitForIdle();

    const emitted = published.filter((message) => message.type === 'chat-messages');
    expect(emitted).toHaveLength(2);
    expect(emitted.map((message) => ({
      turnId: message.turnId,
      contents: message.messages.map((entry) => entry.message.content),
    }))).toEqual([
      { turnId: 'turn-1', contents: ['persisted first'] },
      { turnId: 'turn-2', contents: ['persisted second'] },
    ]);
    expect(fixture.commandLedger.appendProjectionAssistantMessages.mock.calls).toEqual([
      ['chat-1', firstOwner, ['persisted first']],
      ['chat-1', secondOwner, ['persisted second']],
    ]);
    expect(chatViews.readPage('chat-1', 20).messages.map((entry) => entry.message.content)).toEqual([
      'older one',
      'older two',
      'persisted first',
      'persisted second',
    ]);
    expect(chatViews.readPage('chat-1', 20).messages.slice(-2).map((entry) => (
      getNativeMessageRevisionSource(entry.message)
    ))).toEqual([firstSource, secondSource]);
  });

  it('broadcasts the server instance with execution control updates', () => {
    const published = [];
    const fixture = createWiringFixture({
      server: {
        publish: mock((_topic, payload) => published.push(JSON.parse(payload))),
      },
    });
    const control = emptyStoredChatExecutionControl('server-instance-a');
    control.version = 3;

    fixture.queueListeners.executionControl('chat-1', control);

    expect(published).toEqual([{
      type: 'chat-execution-control-updated',
      chatId: 'chat-1',
      control: {
        serverInstanceId: 'server-instance-a',
        queue: {
          entries: [],
          dispatchingEntryId: null,
          steeringEntryId: null,
          recentlyDispatched: [],
          pause: null,
          reorderRevision: 0,
        },
        version: 3,
        updatedAt: null,
      },
    }]);
  });

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

  it('publishes handoff invalidation in one ordered per-chat task', async () => {
    const published = [];
    const invalidateFence = mock(() => undefined);
    const invalidate = mock(() => undefined);
    const fixture = createWiringFixture({
      server: {
        publish: mock((_topic, payload) => published.push(JSON.parse(payload))),
      },
      chatViews: { invalidateFence, invalidate },
    });

    fixture.wiring.notifyAgentHandoff('chat-1');
    expect(published).toEqual([]);
    await fixture.wiring.waitForIdle();

    expect(invalidateFence).toHaveBeenCalledWith('chat-1');
    expect(invalidate).toHaveBeenCalledWith('chat-1');
    expect(fixture.searchIndex.catalogMayHaveChanged).toHaveBeenCalledWith('chat-1');
    expect(published).toEqual([
      {
        type: 'chat-list-refresh-requested',
        reason: 'agent-handoff',
        chatId: 'chat-1',
      },
      {
        type: 'chat-projection-generation-transition',
        chatId: 'chat-1',
        serverInstanceId: 'server-instance-test',
        agentOwnershipEpoch: 'ownership-1',
        previousGenerationId: 'generation-1',
        generationId: expect.any(String),
        resetTransactionId: expect.any(String),
        transientRevision: 1,
        stateDigest: expect.stringMatching(/^transient-v1:/),
        rows: [],
      },
    ]);
  });

  it('defers transcript composition changes to settled-history reconciliation', () => {
    const fixture = createWiringFixture();

    fixture.wiring.notifyTranscriptCompositionChanged('chat-1');

    expect(fixture.idleReconciler.noteHistoryChanged).toHaveBeenCalledWith('chat-1');
    expect(fixture.searchIndex.catalogMayHaveChanged).toHaveBeenCalledWith('chat-1');
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

    const owner = {
      agentOwnershipEpoch: 'ownership-1',
      commandType: 'agent-run',
      clientRequestId: 'request-1',
      turnId: 'turn-1',
    };
    fixture.agentListeners.messages('chat-1', [finalReply], { turnId: 'turn-1', turnOwner: owner });
    fixture.agentListeners.finished('chat-1', 0, { turnId: 'turn-1', turnOwner: owner });
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
    expect(fixture.commandLedger.appendProjectionAssistantMessages).toHaveBeenCalledWith(
      'chat-1',
      owner,
      ['final reply'],
    );
    expect(fixture.commandLedger.markPublicTerminal).toHaveBeenCalledWith(
      'chat-1',
      'turn-1',
      undefined,
    );
  });

  it('broadcasts transient control clearing before terminal lifecycle state', async () => {
    const published = [];
    const fixture = createWiringFixture({
      server: {
        publish: mock((_topic, payload) => published.push(JSON.parse(payload))),
      },
    });
    const turnOwner = {
      agentOwnershipEpoch: 'ownership-1',
      commandType: 'agent-run',
      clientRequestId: 'request-1',
      turnId: 'turn-1',
    };
    const operation = {
      ...turnOwner,
      clientMessageId: 'message-1',
      turnOwner,
    };
    const controlRow = {
      id: 'permission-1',
      incarnation: 'incarnation-1',
      operation,
      anchorEntryId: null,
      displayOrder: 0,
      message: new PermissionRequestMessage(
        '2026-08-11T00:00:00.000Z',
        'permission-1',
        new BashToolUseMessage('2026-08-11T00:00:00.000Z', 'tool-1', 'true'),
      ),
    };
    const materialization = (controls) => ({
      entries: [],
      controls,
      checkpoint: { projection: { durableCount: 0 } },
    });
    const controlCurrent = materialization(new Map([['permission-1', controlRow]]));
    await fixture.agentListeners.projectionApplied({
      event: {
        kind: 'control',
        chatId: 'chat-1',
        agentOwnershipEpoch: 'ownership-1',
        operation,
        mutation: { kind: 'upsert', row: controlRow },
      },
      previous: materialization(new Map()),
      current: controlCurrent,
    });
    await fixture.agentListeners.projectionApplied({
      event: {
        kind: 'terminal',
        chatId: 'chat-1',
        agentOwnershipEpoch: 'ownership-1',
        operation,
        outcome: { kind: 'finished', exitCode: 0 },
      },
      previous: controlCurrent,
      current: materialization(new Map()),
    });
    fixture.agentListeners.finished('chat-1', 0, {
      clientRequestId: 'request-1',
      turnId: 'turn-1',
      turnOwner,
    });
    await fixture.wiring.waitForIdle();

    const types = published.map((message) => message.type);
    const clearIndex = published.findIndex((message) => (
      message.type === 'chat-transient-feed-mutation'
      && message.mutation.kind === 'clear-operation'
    ));
    expect(clearIndex).toBeGreaterThan(-1);
    expect(clearIndex).toBeLessThan(types.indexOf('agent-run-finished'));
    expect(clearIndex).toBeLessThan(types.lastIndexOf('chat-processing-updated'));
  });

  it('settles a pending transcript composition change before publishing turn completion', async () => {
    const published = [];
    const reconciliation = deferred();
    const fixture = createWiringFixture({
      server: {
        publish: mock((_topic, payload) => published.push(JSON.parse(payload))),
      },
      idleReconciler: {
        ensureHistoryChangeReconciled: mock(() => reconciliation.promise),
      },
    });

    fixture.agentListeners.finished('chat-1', 0, { turnId: 'turn-1' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(published.some((message) => message.type === 'agent-run-finished')).toBe(false);

    reconciliation.resolve();
    await fixture.wiring.waitForIdle();
    expect(published).toContainEqual(expect.objectContaining({
      type: 'agent-run-finished',
      chatId: 'chat-1',
      turnId: 'turn-1',
    }));
  });

  it('makes recovered native output unavailable instead of reporting an empty success', async () => {
    const ledger = new CommandLedger();
    await ledger.accept({
      commandType: 'agent-run',
      chatId: 'chat-1',
      clientRequestId: 'req-1',
      turnId: 'turn-1',
      payload: { command: 'work' },
    });
    const fixture = createWiringFixture({
      commandLedgerInstance: ledger,
      chatViews: {
        appendAfterEnsuringGeneration: mock(async () => {
          throw new Error('view append failed');
        }),
      },
      chatNativeReloader: {
        reloadFromNative: mock(async () => ({
          mode: 'process-error',
          generationId: 'generation-2',
          messages: [{ seq: 1, message: new AssistantMessage(
            '2026-06-01T00:00:00.000Z',
            'recovered result',
          ) }],
          lastSeq: 1,
          pageOldestSeq: 1,
          hasMore: false,
        })),
      },
    });
    const turn = {
      commandType: 'agent-run',
      clientRequestId: 'req-1',
      turnId: 'turn-1',
    };

    fixture.agentListeners.messages('chat-1', [
      new AssistantMessage('2026-06-01T00:00:00.000Z', 'recovered result'),
    ], turn);
    fixture.agentListeners.finished('chat-1', 0, turn);
    await fixture.wiring.waitForIdle();

    const record = await ledger.getTurnRecord('chat-1', 'turn-1');
    expect(projectAgentTurnReceipt(record)).toMatchObject({
      kind: 'found',
      receipt: {
        state: 'completed',
        output: { availability: 'unavailable', reason: 'recovery' },
      },
    });
  });

  it('publishes the Stop outcome before making an interrupted receipt public', async () => {
    const timeline = [];
    let stopRequested;
    const fixture = createWiringFixture({
      server: {
        publish: mock((_topic, payload) => timeline.push(JSON.parse(payload).type)),
      },
      queue: {
        onSessionStopRequested: mock((callback) => { stopRequested = callback; }),
      },
      commandLedger: {
        markPublicTerminal: mock(async (_chatId, _turnId, reason) => {
          timeline.push(`receipt:${reason}`);
        }),
      },
    });
    const turn = { clientRequestId: 'req-1', turnId: 'turn-1' };

    stopRequested('chat-1', 'stop-1', turn, 'stop');
    fixture.queueListeners.sessionStopped(
      'chat-1',
      'interrupt-requested',
      'stop',
      'stop-1',
      5,
    );
    await fixture.wiring.waitForIdle();

    expect(timeline.indexOf('chat-session-stopped'))
      .toBeLessThan(timeline.indexOf('receipt:user-stop'));
  });

  it('settles a deletion stop receipt with the chat-deleted reason', async () => {
    let stopRequested;
    const fixture = createWiringFixture({
      queue: {
        onSessionStopRequested: mock((callback) => { stopRequested = callback; }),
      },
    });
    const turn = { clientRequestId: 'req-1', turnId: 'turn-1' };

    stopRequested('chat-1', 'stop-1', turn, 'chat-deletion');
    fixture.queueListeners.sessionStopped(
      'chat-1',
      'interrupt-requested',
      'chat-deletion',
      'stop-1',
      5,
    );
    await fixture.wiring.waitForIdle();

    expect(fixture.commandLedger.markPublicTerminal).toHaveBeenCalledWith(
      'chat-1',
      'turn-1',
      'chat-deleted',
    );
  });

  it('does not publish a deletion receipt before the chat removal event', async () => {
    const ledger = new CommandLedger();
    await ledger.accept({
      commandType: 'agent-run',
      chatId: 'chat-1',
      clientRequestId: 'req-1',
      turnId: 'turn-1',
      payload: { command: 'work' },
    });
    ledger.beginChatDeletion('chat-1');
    let stopRequested;
    let chatExists = true;
    const published = [];
    const fixture = createWiringFixture({
      commandLedgerInstance: ledger,
      chatRegistry: { getChat: mock(() => (chatExists ? {} : null)) },
      queue: {
        onSessionStopRequested: mock((callback) => { stopRequested = callback; }),
      },
      server: {
        publish: mock((_topic, payload) => published.push(JSON.parse(payload).type)),
      },
    });
    const turn = {
      commandType: 'agent-run',
      clientRequestId: 'req-1',
      turnId: 'turn-1',
    };

    stopRequested('chat-1', 'stop-1', turn, 'chat-deletion');
    fixture.queueListeners.sessionStopped(
      'chat-1',
      'interrupt-requested',
      'chat-deletion',
      'stop-1',
      5,
    );
    fixture.agentListeners.finished('chat-1', 0, turn);
    await fixture.wiring.waitForIdle();

    expect(projectAgentTurnReceipt(await ledger.getTurnRecord('chat-1', 'turn-1')))
      .toMatchObject({ receipt: { state: 'pending' } });

    chatExists = false;
    fixture.chatRegistryListeners.removed('chat-1', 'user-deletion');
    await fixture.wiring.waitForIdle();

    expect(published).toContain('chat-session-deleted');
    expect(projectAgentTurnReceipt(await ledger.getTurnRecord('chat-1', 'turn-1')))
      .toMatchObject({
        receipt: { state: 'interrupted', reason: 'chat-deleted' },
      });
  });

  it('broadcasts chat deletion before publishing outstanding receipts', async () => {
    const timeline = [];
    const fixture = createWiringFixture({
      server: {
        publish: mock((_topic, payload) => timeline.push(JSON.parse(payload).type)),
      },
      commandLedger: {
        markChatInterrupted: mock(async () => { timeline.push('receipts-settled'); }),
      },
    });

    fixture.chatRegistryListeners.removed('chat-1', 'user-deletion');
    await fixture.wiring.waitForIdle();

    expect(fixture.commandLedger.markChatInterrupted).toHaveBeenCalledWith(
      'chat-1',
      'chat-deleted',
    );
    expect(timeline).toEqual(['chat-session-deleted', 'receipts-settled']);
  });

  it('does not classify failed-start compensation as chat deletion', async () => {
    const published = [];
    const fixture = createWiringFixture({
      server: {
        publish: mock((_topic, payload) => published.push(JSON.parse(payload))),
      },
    });

    fixture.chatRegistryListeners.removed('chat-1', 'start-compensation');
    await fixture.wiring.waitForIdle();

    expect(fixture.commandLedger.markChatInterrupted).not.toHaveBeenCalled();
    expect(published).toContainEqual({ type: 'chat-session-deleted', chatId: 'chat-1' });
  });

  it('publishes a deferred natural completion when Stop finds the chat idle', async () => {
    const ledger = new CommandLedger();
    const accepted = await ledger.accept({
      commandType: 'agent-run',
      chatId: 'chat-1',
      clientRequestId: 'req-1',
      turnId: 'turn-1',
      payload: { command: 'work' },
    });
    let stopRequested;
    const fixture = createWiringFixture({
      commandLedgerInstance: ledger,
      queue: {
        onSessionStopRequested: mock((callback) => { stopRequested = callback; }),
      },
    });
    const turn = {
      commandType: 'agent-run',
      clientRequestId: 'req-1',
      turnId: 'turn-1',
    };

    stopRequested('chat-1', 'stop-1', turn, 'stop');
    fixture.agentListeners.finished('chat-1', 0, turn);
    await fixture.wiring.waitForIdle();
    expect((await ledger.getRecord(accepted.record.key)).publicTerminalAt).toBeUndefined();

    fixture.queueListeners.sessionStopped('chat-1', 'already-idle', 'stop', 'stop-1', 1);
    await fixture.wiring.waitForIdle();

    const record = await ledger.getTurnRecord('chat-1', 'turn-1');
    expect(record.publicTerminalAt).toEqual(expect.any(String));
    expect(projectAgentTurnReceipt(record)).toMatchObject({
      kind: 'found',
      receipt: { state: 'completed' },
    });
  });

  it('broadcasts tag changes through the per-chat event queue', async () => {
    const published = [];
    const fixture = createWiringFixture({
      server: {
        publish: mock((_topic, payload) => published.push(JSON.parse(payload))),
      },
    });

    fixture.chatRegistryListeners.tagsUpdated('chat-1');
    await fixture.wiring.waitForIdle();

    expect(published).toContainEqual({
      type: 'chat-list-refresh-requested',
      reason: 'tags-updated',
      chatId: 'chat-1',
    });
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
      onProjectionApplied: mock(() => undefined),
      onInputSettled: mock(() => undefined),
      onProjectionFailure: mock(() => undefined),
      repairProjection: mock(async () => true),
      discardTurn: mock(() => undefined),
      settleTurn: mock(() => undefined),
    };
    const queue = {
      onExecutionControlUpdated: mock(() => undefined),
      onSessionStopRequested: mock((callback) => { queueListeners.stopRequested = callback; }),
      onDispatching: mock(() => undefined),
      onChatIdle: mock(() => undefined),
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
      onAcceptedInputSettled: mock(() => undefined),
      replaceTurnWithTranscriptSnapshotReservation: mock(() => null),
      releaseTranscriptSnapshot: mock(async () => undefined),
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
        onChatTagsUpdated: noOpSubscription,
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
      idleReconciler: {
        noteIdle: () => undefined,
        noteHistoryChanged: () => undefined,
        ensureReconciled: async () => undefined,
        ensureHistoryChangeReconciled: async () => undefined,
      },
      chatNativeReloader: {},
      pendingInputs,
      pendingRecovery: { waitForSettlements: mock(async () => undefined) },
      commandLedger: {
        settleTerminal: mock(async () => undefined),
        appendAssistantMessages: mock(async () => undefined),
        appendProjectionAssistantMessages: mock(async () => undefined),
        finalizeProjectionOutput: mock(async () => undefined),
        markProjectionOutputUnavailable: mock(async () => undefined),
        markPublicTerminal: mock(async () => undefined),
        publishDeferredTerminal: mock(async () => undefined),
        markChatInterrupted: mock(async () => undefined),
      },
      shareStore: {},
      telegramNotifier: {},
      telegramSettings: { onChanged: noOpSubscription },
      scheduledPrompts: { onInvalidated: noOpSubscription },
      snippets: { onInvalidated: noOpSubscription },
      loadNativeMessages: mock(async () => []),
    });

    queueListeners.stopRequested(chatId, 'stop-a', turn, 'stop');
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
      onProjectionApplied: mock(() => undefined),
      onInputSettled: mock(() => undefined),
      onProjectionFailure: mock(() => undefined),
      repairProjection: mock(async () => true),
      discardTurn: mock(() => undefined),
      settleTurn: mock(() => undefined),
    };
    const queue = {
      onExecutionControlUpdated: mock(() => undefined),
      onSessionStopRequested: mock((callback) => { queueListeners.stopRequested = callback; }),
      onDispatching: mock(() => undefined),
      onChatIdle: mock(() => undefined),
      onSessionStopped: mock((callback) => { queueListeners.sessionStopped = callback; }),
      onProcessingInvalidated: mock(() => undefined),
      onTurnFailed: mock(() => undefined),
      onTurnSettled: mock((callback) => { queueListeners.turnSettled = callback; }),
      getQueuedTurnFinalization: mock(() => null),
      onAgentTurnTerminal: mock((terminalChatId, terminalTurn) => {
        queueListeners.turnSettled(terminalChatId, terminalTurn);
      }),
      onAcceptedInputSettled: mock(() => undefined),
      replaceTurnWithTranscriptSnapshotReservation: mock(() => null),
      releaseTranscriptSnapshot: mock(async () => undefined),
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
        onChatTagsUpdated: noOpSubscription,
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
      idleReconciler: {
        noteIdle: () => undefined,
        noteHistoryChanged: () => undefined,
        ensureReconciled: async () => undefined,
        ensureHistoryChangeReconciled: async () => undefined,
      },
      chatNativeReloader: { reloadFromNative },
      pendingInputs,
      pendingRecovery: { waitForSettlements: mock(async () => undefined) },
      commandLedger: {
        settleTerminal: mock(async () => undefined),
        appendAssistantMessages: mock(async () => undefined),
        appendProjectionAssistantMessages: mock(async () => undefined),
        finalizeProjectionOutput: mock(async () => undefined),
        markProjectionOutputUnavailable: mock(async () => undefined),
        markPublicTerminal: mock(async () => undefined),
        publishDeferredTerminal: mock(async () => undefined),
        markChatInterrupted: mock(async () => undefined),
      },
      shareStore: {},
      telegramNotifier: {},
      telegramSettings: { onChanged: noOpSubscription },
      scheduledPrompts: { onInvalidated: noOpSubscription },
      snippets: { onInvalidated: noOpSubscription },
      loadNativeMessages: mock(async () => []),
    });

    queueListeners.stopRequested(chatId, 'stop-a', turn, 'stop');
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
