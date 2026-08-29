import { describe, expect, it, mock } from 'bun:test';
import { AssistantMessage } from '../../common/chat-types.js';
import { emptyStoredChatExecutionControl } from '../chat-execution/control-state.ts';
import { ChatTransientFeedStore } from '../chats/chat-transient-feed.js';
import { wireServerEvents } from '../server-event-wiring.js';
import { AgentEventBus } from '../agents/event-bus.js';
import {
  attachNativeMessageSource,
  getNativeMessageRevisionSource,
} from '../agents/shared/native-message-source.ts';

const at = '2026-08-12T00:00:00.000Z';

function createFixture(overrides = {}) {
  const agent = {};
  const queue = {};
  const settings = {};
  const chats = {};
  const scheduled = {};
  const snippets = {};
  const telegram = {};
  const published = [];
  let chatPresent = true;
  const noOp = mock(() => undefined);
  const agentRegistry = {
    onTranscriptCommitted: mock((callback) => { agent.transcript = callback; }),
    onSessionCreated: mock((callback) => { agent.session = callback; }),
    onFinished: mock((callback) => { agent.finished = callback; }),
    onRunActivityCleared: mock((callback) => { agent.activityCleared = callback; }),
    onFailed: mock((callback) => { agent.failed = callback; }),
    resendCandidates: mock(() => []),
    settleTurn: mock(() => undefined),
    discardTurn: mock(() => undefined),
    ...overrides.agentRegistry,
  };
  const queueService = {
    onExecutionControlUpdated: mock((callback) => { queue.control = callback; }),
    onProcessingInvalidated: mock((callback) => { queue.processing = callback; }),
    onSessionStopped: mock((callback) => { queue.stopped = callback; }),
    onTurnFailed: mock((callback) => { queue.failed = callback; }),
    onTurnSettled: mock((callback) => { queue.settled = callback; }),
    getQueuedTurnFinalization: mock(() => null),
    onAgentTurnTerminal: mock(async () => undefined),
    checkChatIdle: mock(async () => undefined),
    ...overrides.queue,
  };
  const chatRegistry = {
    getChat: mock(() => chatPresent ? { chatId: 'chat-1' } : null),
    onChatAdded: mock((callback) => { chats.added = callback; }),
    onChatRemoved: mock((callback) => { chats.removed = callback; }),
    onChatReadUpdated: mock((callback) => { chats.read = callback; }),
    onChatProjectPathUpdated: mock((callback) => { chats.path = callback; }),
    onChatTagsUpdated: mock((callback) => { chats.tags = callback; }),
    ...overrides.chatRegistry,
  };
  const settingsStore = {
    onSessionNameChanged: mock((callback) => { settings.name = callback; }),
    onListChanged: mock((callback) => { settings.list = callback; }),
    onRemoteSettingsChanged: mock((callback) => { settings.remote = callback; }),
    ...overrides.settings,
  };
  const metadata = {
    updateFromAppendedMessages: mock(() => undefined),
    replaceFromTranscriptView: mock(() => undefined),
    ...overrides.metadata,
  };
  const commandLedger = {
    getTurnRecord: mock(async (_chatId, turnId) => (
      turnId === 'turn-1' ? { payload: { clientMessageId: 'message-1' } } : null
    )),
    appendAssistantMessages: mock(async () => undefined),
    settleTerminal: mock(async () => undefined),
    markPublicTerminal: mock(async () => undefined),
    markChatInterrupted: mock(async () => undefined),
    ...overrides.commandLedger,
  };
  const searchIndex = {
    catalogMayHaveChanged: mock(() => undefined),
    deleteChat: mock(() => undefined),
    ...overrides.searchIndex,
  };
  const shareStore = {
    revokeShareByChatId: mock(async () => undefined),
    ...overrides.shareStore,
  };
  const processing = {
    phase: mock(() => null),
    ...overrides.processing,
  };
  const wiring = wireServerEvents({
    server: {
      publish: mock((_topic, payload) => published.push(JSON.parse(payload))),
      ...overrides.server,
    },
    agentRegistry,
    chatRegistry,
    settings: settingsStore,
    queue: queueService,
    processing,
    metadata,
    currentTranscriptMessages: overrides.currentTranscriptMessages ?? (() => []),
    assistantMessagesForSubmission: overrides.assistantMessagesForSubmission ?? (() => []),
    transientFeeds: new ChatTransientFeedStore('server-instance-test'),
    commandLedger,
    shareStore,
    telegramNotifier: { setBotToken: noOp, ...overrides.telegramNotifier },
    telegramSettings: {
      onChanged: mock((callback) => { telegram.changed = callback; }),
      getBotToken: mock(() => null),
      ...overrides.telegramSettings,
    },
    scheduledPrompts: {
      onInvalidated: mock((callback) => { scheduled.invalidated = callback; }),
      ...overrides.scheduledPrompts,
    },
    snippets: {
      onInvalidated: mock((callback) => { snippets.invalidated = callback; }),
      ...overrides.snippets,
    },
    searchIndex,
  });
  return {
    agent,
    agentRegistry,
    chats,
    chatRegistry,
    commandLedger,
    metadata,
    processing,
    published,
    queue,
    queueService,
    scheduled,
    searchIndex,
    settings,
    shareStore,
    snippets,
    wiring,
    removeChat() { chatPresent = false; },
  };
}

function providerCommit(content = 'answer') {
  return {
    type: 'rows',
    chatId: 'chat-1',
    viewId: 'view-1',
    rows: [{
      kind: 'provider-row',
      ordinal: 2,
      at,
      providerMeta: null,
      message: new AssistantMessage(at, content),
    }],
  };
}

function terminalCommit(outcome = 'finished') {
  return {
    type: 'run-ended',
    chatId: 'chat-1',
    viewId: 'view-1',
    runId: 'turn-1',
    row: {
      kind: 'run-ended',
      ordinal: 3,
      at,
      providerMeta: null,
      outcome,
      origin: outcome === 'interrupted' ? 'core' : 'provider',
    },
  };
}

const turn = {
  commandType: 'agent-run',
  clientRequestId: 'request-1',
  turnId: 'turn-1',
};

describe('server event wiring', () => {
  it('[TLV5-SEARCH.09-WS-03] broadcasts workspace transcript search status', () => {
    const fixture = createFixture();
    const status = {
      version: 1,
      phase: 'rebuilding',
      chats: { total: 4, indexed: 3, pending: 1, failed: 0, unindexed: 0 },
      queuedJobs: 1,
      resync: { completedChats: 3, totalChats: 4 },
      backlogRows: 12,
      activeChat: { position: 4, total: 10 },
      lastErrorCode: null,
      updatedAt: '2026-08-19T00:00:00.000Z',
    };

    fixture.wiring.broadcastTranscriptSearchStatus(status);

    expect(fixture.published).toEqual([{ type: 'transcript-search-status', status }]);
  });

  it('[TLV5-L03.02-CORE-UNIT-01] broadcasts committed rows before terminal-driven lifecycle state', async () => {
    const fixture = createFixture();

    fixture.agent.transcript(providerCommit());
    fixture.agent.transcript(terminalCommit());
    fixture.agent.finished('chat-1', 0, turn, 'finished');
    await fixture.wiring.waitForIdle();

    expect(fixture.published.map((message) => message.type)).toEqual([
      'chat-messages',
      'chat-messages',
      'chat-processing-updated',
      'agent-run-finished',
    ]);
    expect(fixture.published[0]).toMatchObject({
      transcriptViewId: 'view-1',
      firstOrdinal: 2,
      lastOrdinal: 2,
      messages: [{ ordinal: 2, message: { content: 'answer' } }],
    });
    expect(fixture.queueService.onAgentTurnTerminal).toHaveBeenCalledWith('chat-1', turn, 'finished');
    expect(fixture.commandLedger.settleTerminal).toHaveBeenCalledWith(
      'agent-run:chat-1:request-1',
      'finished',
      {},
    );
  });

  it('checks chat idle without awaiting queue drain when run activity clears', async () => {
    const eventBus = new AgentEventBus();
    let releaseIdleCheck;
    const idleCheck = new Promise((resolve) => {
      releaseIdleCheck = resolve;
    });
    const fixture = createFixture({
      agentRegistry: {
        onFinished: (callback) => eventBus.onFinished(callback),
        onFailed: (callback) => eventBus.onFailed(callback),
        onRunActivityCleared: (callback) => eventBus.onRunActivityCleared(callback),
      },
      queue: {
        checkChatIdle: mock(() => idleCheck),
      },
    });
    eventBus.trackTurn('chat-1', turn);
    eventBus.clearTurn('chat-1');

    const publication = eventBus.publishRunEnded('chat-1', 'turn-1', terminalCommit().row);
    let publicationSettled = false;
    void publication.then(() => {
      publicationSettled = true;
    });
    await Promise.resolve();
    await Promise.resolve();

    try {
      expect(publicationSettled).toBe(true);
      expect(fixture.queueService.checkChatIdle).toHaveBeenCalledWith('chat-1');
      expect(fixture.published).toEqual([]);
    } finally {
      releaseIdleCheck();
      await publication;
    }
  });

  it('captures committed assistant output for the command receipt before terminal settlement', async () => {
    const calls = [];
    const fixture = createFixture({
      assistantMessagesForSubmission: mock((chatId, viewId, clientMessageId, throughOrdinal) => {
        calls.push(['read', chatId, viewId, clientMessageId, throughOrdinal]);
        return ['answer'];
      }),
      commandLedger: {
        appendAssistantMessages: mock(async (chatId, turnId, messages) => {
          calls.push(['append', chatId, turnId, messages]);
        }),
        settleTerminal: mock(async () => {
          calls.push(['settle']);
        }),
      },
    });

    await fixture.agent.transcript(terminalCommit());
    fixture.agent.finished('chat-1', 0, turn, 'finished');
    await fixture.wiring.waitForIdle();

    expect(calls).toEqual([
      ['read', 'chat-1', 'view-1', 'message-1', 3],
      ['append', 'chat-1', 'turn-1', ['answer']],
      ['settle'],
    ]);
  });

  it('broadcasts committed output before a failed run transition', async () => {
    const fixture = createFixture();

    fixture.agent.transcript(providerCommit('partial answer'));
    fixture.agent.transcript(terminalCommit('failed'));
    fixture.agent.failed('chat-1', 'provider failed', 'CARRYOVER_COMPACTION_FAILED', turn);
    await fixture.wiring.waitForIdle();

    const types = fixture.published.map((message) => message.type);
    expect(types.indexOf('chat-messages')).toBeLessThan(types.indexOf('chat-processing-updated'));
    expect(types.indexOf('chat-processing-updated')).toBeLessThan(types.indexOf('agent-run-failed'));
    expect(fixture.commandLedger.settleTerminal).toHaveBeenCalledWith(
      'agent-run:chat-1:request-1',
      'failed',
      { error: 'provider failed', errorCode: 'CARRYOVER_COMPACTION_FAILED' },
    );
  });

  it('updates preview without scheduling a duplicate search rebuild for transcript commits', async () => {
    const fixture = createFixture();

    fixture.agent.transcript(providerCommit());
    fixture.agent.transcript(terminalCommit());
    await fixture.wiring.waitForIdle();

    expect(fixture.metadata.updateFromAppendedMessages).toHaveBeenCalledTimes(1);
    expect(fixture.metadata.updateFromAppendedMessages).toHaveBeenCalledWith('chat-1', [
      expect.objectContaining({ content: 'answer' }),
    ]);
    expect(fixture.searchIndex.catalogMayHaveChanged).not.toHaveBeenCalled();
  });

  it('suppresses resend candidates in commit broadcasts while processing', async () => {
    const fixture = createFixture({
      agentRegistry: {
        resendCandidates: mock(() => [{ ordinal: 1, content: 'prompt', attachmentNames: [] }]),
      },
      processing: { phase: mock(() => 'running') },
    });

    fixture.agent.transcript(providerCommit());
    await fixture.wiring.waitForIdle();

    expect(fixture.published[0]).toMatchObject({
      type: 'chat-messages',
      resendCandidates: [],
    });
    expect(fixture.agentRegistry.resendCandidates).not.toHaveBeenCalled();
  });

  it('rebuilds preview metadata from the complete replacement view', async () => {
    const replacement = [new AssistantMessage(at, 'reloaded answer')];
    const fixture = createFixture({ currentTranscriptMessages: () => replacement });

    fixture.agent.transcript({
      type: 'view-replaced',
      chatId: 'chat-1',
      previousViewId: 'view-1',
      view: {
        viewId: 'view-2',
        status: 'current',
        createdAt: at,
        contentStartOrdinal: 1,
      },
    });
    await fixture.wiring.waitForIdle();

    expect(fixture.metadata.replaceFromTranscriptView)
      .toHaveBeenCalledWith('chat-1', replacement);
    expect(fixture.metadata.updateFromAppendedMessages).not.toHaveBeenCalled();
    expect(fixture.published).toEqual([expect.objectContaining({
      type: 'chat-transcript-replaced',
      previousTranscriptViewId: 'view-1',
      transcriptViewId: 'view-2',
    })]);
  });

  it('broadcasts a view replacement before rows from the replacement producer', async () => {
    const fixture = createFixture();

    fixture.agent.transcript({
      type: 'view-replaced',
      chatId: 'chat-1',
      previousViewId: 'view-1',
      view: {
        viewId: 'view-2',
        status: 'current',
        createdAt: at,
        contentStartOrdinal: 1,
      },
    });
    fixture.agent.transcript({
      ...providerCommit('replacement live row'),
      viewId: 'view-2',
      rows: [{
        kind: 'provider-row',
        ordinal: 1,
        at,
        providerMeta: null,
        message: new AssistantMessage(at, 'replacement live row'),
      }],
    });
    await fixture.wiring.waitForIdle();

    expect(fixture.published).toEqual([
      expect.objectContaining({
        type: 'chat-transcript-replaced',
        previousTranscriptViewId: 'view-1',
        transcriptViewId: 'view-2',
      }),
      expect.objectContaining({
        type: 'chat-messages',
        transcriptViewId: 'view-2',
        firstOrdinal: 1,
        lastOrdinal: 1,
        messages: [{
          ordinal: 1,
          message: expect.objectContaining({ content: 'replacement live row' }),
        }],
      }),
    ]);
  });

  it('broadcasts session facts through the same per-chat task queue', async () => {
    const fixture = createFixture();

    fixture.agent.transcript(providerCommit());
    fixture.agent.session('chat-1');
    await fixture.wiring.waitForIdle();

    expect(fixture.published.map((message) => message.type)).toEqual([
      'chat-messages',
      'chat-session-created',
    ]);
    expect(fixture.searchIndex.catalogMayHaveChanged).toHaveBeenCalledWith('chat-1');
  });

  it('publishes a Stop outcome before the resulting processing phase', async () => {
    const fixture = createFixture({ processing: { phase: mock(() => 'stopping') } });

    fixture.queue.stopped('chat-1', 'interrupt-requested', 'stop');
    await fixture.wiring.waitForIdle();

    expect(fixture.published).toMatchObject([
      {
        type: 'chat-session-stopped',
        chatId: 'chat-1',
        outcome: 'interrupt-requested',
        intent: 'stop',
      },
      { type: 'chat-processing-updated', chatId: 'chat-1', phase: 'stopping' },
    ]);
  });

  it('repairs an idle processing phase before publishing an already-idle Stop', async () => {
    const fixture = createFixture({ processing: { phase: mock(() => null) } });

    fixture.queue.stopped('chat-1', 'already-idle', 'stop');
    await fixture.wiring.waitForIdle();

    expect(fixture.published).toMatchObject([
      { type: 'chat-processing-updated', chatId: 'chat-1', phase: null },
      {
        type: 'chat-session-stopped',
        chatId: 'chat-1',
        outcome: 'already-idle',
        intent: 'stop',
      },
    ]);
  });

  it('broadcasts view-qualified execution control updates', () => {
    const fixture = createFixture();
    const control = emptyStoredChatExecutionControl('server-instance-test');
    control.version = 2;

    fixture.queue.control('chat-1', control);

    expect(fixture.published).toEqual([expect.objectContaining({
      type: 'chat-execution-control-updated',
      chatId: 'chat-1',
      control: expect.objectContaining({ version: 2 }),
    })]);
  });

  it('publishes handoff invalidation without rotating the transcript view', async () => {
    const fixture = createFixture();

    fixture.wiring.notifyAgentHandoff('chat-1');
    await fixture.wiring.waitForIdle();

    expect(fixture.published).toEqual([{
      type: 'chat-list-refresh-requested',
      reason: 'agent-handoff',
      chatId: 'chat-1',
    }]);
    expect(fixture.searchIndex.catalogMayHaveChanged).toHaveBeenCalledWith('chat-1');
  });

  it('deletes derived state and skips queued lifecycle broadcasts after removal', async () => {
    const fixture = createFixture();
    fixture.removeChat();

    fixture.chats.removed('chat-1', 'user-deletion');
    fixture.queue.processing('chat-1');
    fixture.queue.stopped('chat-1', 'already-idle', 'stop');
    await fixture.wiring.waitForIdle();

    expect(fixture.agentRegistry.discardTurn).toHaveBeenCalledWith('chat-1');
    expect(fixture.searchIndex.deleteChat).toHaveBeenCalledWith('chat-1');
    expect(fixture.shareStore.revokeShareByChatId).toHaveBeenCalledWith('chat-1');
    expect(fixture.published).toEqual([{ type: 'chat-session-deleted', chatId: 'chat-1' }]);
    expect(fixture.commandLedger.markChatInterrupted).toHaveBeenCalledWith(
      'chat-1',
      'chat-deleted',
    );
  });

  it('broadcasts operational notices without entering transcript sequence space', () => {
    const fixture = createFixture();

    fixture.wiring.notifyOperationalNotice('chat-1', 'info', 'Carryover is being compacted.');

    expect(fixture.published).toEqual([expect.objectContaining({
      type: 'chat-operational-notice',
      chatId: 'chat-1',
      noticeType: 'info',
      content: 'Carryover is being compacted.',
    })]);
    expect(fixture.metadata.updateFromAppendedMessages).not.toHaveBeenCalled();
  });

  it('reports task failures through the shutdown drain', async () => {
    const failure = new Error('command ledger unavailable');
    const fixture = createFixture({
      commandLedger: { settleTerminal: mock(async () => { throw failure; }) },
    });

    fixture.agent.finished('chat-1', 0, turn, 'finished');

    await expect(fixture.wiring.waitForIdle()).rejects.toBe(failure);
  });
});
