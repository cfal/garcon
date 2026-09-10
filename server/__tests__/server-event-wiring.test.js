import { describe, expect, it, mock } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AssistantMessage } from '../../common/chat-types.js';
import { emptyStoredChatExecutionControl } from '../chat-execution/control-state.ts';
import { ChatTransientFeedStore } from '../chats/chat-transient-feed.js';
import { ProjectUnavailableError } from '../lib/domain-error.ts';
import { wireServerEvents } from '../server-event-wiring.js';
import { ChatExecutionCoordinator } from '../chat-execution/chat-execution-coordinator.js';
import { InMemoryChatExecutionControlRepository } from '../chat-execution/chat-execution-control-repository.js';
import { CommandLedger } from '../commands/command-ledger.js';
import { ChatCommandSettlement } from '../commands/chat-command-settlement.js';
import { projectAgentTurnReceipt } from '../commands/agent-turn-receipt-projector.js';
import { AgentRegistry } from '../agents/registry.js';
import { TranscriptLedgerService } from '../ledger/service.js';
import { TranscriptLedgerStore } from '../ledger/store.js';
import { KeyedPromiseLock } from '../lib/keyed-lock.js';
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
  const preambles = {};
  const chatBoards = {};
  const telegram = {};
  const published = [];
  let chatPresent = true;
  const noOp = mock(() => undefined);
  const agentRegistry = {
    onTranscriptCommitted: mock((callback) => { agent.transcript = callback; }),
    onSessionCreated: mock((callback) => { agent.session = callback; }),
    onFinished: mock((callback) => { agent.finished = callback; }),
    onFailed: mock((callback) => { agent.failed = callback; }),
    resendCandidates: mock(() => []),
    settleTurn: mock(() => undefined),
    discardTurn: mock(() => undefined),
    ...overrides.agentRegistry,
  };
  const queueService = overrides.queueService ?? {
    onExecutionControlUpdated: mock((callback) => { queue.control = callback; }),
    onProcessingInvalidated: mock((callback) => { queue.processing = callback; }),
    onSessionStopped: mock((callback) => { queue.stopped = callback; }),
    onTurnFailed: mock((callback) => { queue.failed = callback; }),
    onProjectUnavailable: mock((callback) => { queue.projectUnavailable = callback; }),
    onTurnSettled: mock((callback) => { queue.settled = callback; }),
    getQueuedTurnFinalization: mock(() => null),
    onAgentTurnTerminal: mock(async () => undefined),
    checkChatIdle: mock(async () => undefined),
    ...overrides.queue,
  };
  const chatRegistry = {
    getChat: mock(() => chatPresent ? { chatId: 'chat-1' } : null),
    hasChat: mock(() => chatPresent),
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
  const commandLedger = overrides.commandLedgerInstance ?? {
    getTurnRecord: mock(async (_chatId, turnId) => (
      turnId === 'turn-1' ? { payload: { clientMessageId: 'message-1' } } : null
    )),
    setTurnResult: mock(async () => undefined),
    settleTerminal: mock(async () => undefined),
    markPublicTerminal: mock(async () => undefined),
    markInterruptedWithoutRunTerminal: mock(async () => undefined),
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
    preambles: {
      onInvalidated: mock((callback) => { preambles.invalidated = callback; }),
      ...overrides.preambles,
    },
    chatBoards: {
      on: mock((_event, callback) => { chatBoards.invalidated = callback; }),
      ...overrides.chatBoards,
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
    preambles,
    chatBoards,
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

function createExecutionFixture(directory, ensureAdopted) {
  const store = new TranscriptLedgerStore(directory);
  const transcripts = new TranscriptLedgerService(store);
  const view = transcripts.initializeChat('chat-1');
  const agentSettings = { ownerId: 'test', schemaVersion: 1, values: {} };
  const entry = {
    id: 'chat-1', agentId: 'test', agentSessionId: null, nativeSession: null,
    nativeSeedReceipt: null, agentOwnershipEpoch: 'epoch-1', projectPath: directory,
    model: 'model-a', apiProviderId: null, modelEndpointId: null, modelProtocol: null,
    permissionMode: 'default', thinkingMode: 'none', tags: [],
    agentSettingsById: { test: agentSettings },
  };
  let sink;
  const integration = {
    descriptor: { id: 'test', supportedPermissionModes: ['default'], supportedThinkingModes: ['none'] },
    settings: { defaults: () => agentSettings, parse: (input) => input },
    execution: {
      start: async (request) => {
        sink = request.sink;
        await request.admission.markStarted();
        return { id: 'synthetic-handle' };
      },
      abort: async () => undefined,
    },
  };
  const agents = new AgentRegistry({
    registry: { getChat: () => entry, updateChat: (_chatId, patch) => Object.assign(entry, patch) },
    integrations: { require: () => integration, get: () => integration, list: () => [integration] },
    endpointResolver: {
      resolveSelection: () => ({ model: 'model-a', apiProviderId: null, endpointId: null, protocol: null, isLocal: false }),
      resolveEndpointReference: () => null,
    },
    getCarryOverRevision: () => '', createCarriedContext: async () => ({ kind: 'no-history' }),
    ledger: transcripts, adoption: { ensure: ensureAdopted ?? (async () => view) },
    hasPendingOwnershipTransfer: () => false, preambles: {}, selectionAdmissionLock: new KeyedPromiseLock(),
  });
  const execution = new ChatExecutionCoordinator(directory, agents, {
    admitInput: async () => ({ inserted: true }), hasMatchingInput: async () => false,
    admitQueuedInput: () => ({ inserted: true }), discardPreparedInput() {},
  }, () => ({}), () => true, new InMemoryChatExecutionControlRepository('synthetic-server'), {
    projectAdmission: { assertAvailable: async () => undefined }, isControlInputViewCurrent: () => true,
  });
  const ledger = new CommandLedger();
  const fixture = createFixture({
    commandLedgerInstance: ledger, queueService: execution,
    agentRegistry: {
      onTranscriptCommitted: (callback) => agents.onTranscriptCommitted(callback),
      onSessionCreated: (callback) => agents.onSessionCreated(callback),
      onFinished: (callback) => agents.onFinished(callback),
      onFailed: (callback) => agents.onFailed(callback),
      settleTurn: (...args) => agents.settleTurn(...args),
    },
  });
  return { ...fixture, store, transcripts, agents, execution, ledger, get sink() { return sink; } };
}

describe('server event wiring', () => {
  for (const method of ['stopActiveTurn', 'interruptActiveTurn']) {
    it(`settles ${method} during pre-run failure settlement and fences its successor`, async () => {
      const directory = await mkdtemp(path.join(tmpdir(), 'prerun-failure-stop-wiring-'));
      const fixture = createExecutionFixture(directory, async () => { throw new Error('Synthetic adoption failure'); });
      const { execution, agents, ledger, transcripts, store } = fixture;
      const failed = Promise.withResolvers();
      const release = Promise.withResolvers();
      const cancellation = new AbortController();
      const settlement = new ChatCommandSettlement(ledger);
      const settleFailure = settlement.settleOperationFailure.bind(settlement);
      settlement.settleOperationFailure = async (...args) => {
        await settleFailure(...args);
        failed.resolve();
        await release.promise;
      };
      const startedTurn = { turnId: 'turn-1', commandType: 'chat-start', clientRequestId: 'request-1' };
      let successor;
      try {
        const accepted = await ledger.accept({ ...startedTurn, chatId: 'chat-1', payload: {} });
        const receipt = ledger.waitForTurnTerminal('chat-1', 'turn-1', cancellation.signal).catch(() => null);
        await execution.scheduleDirectInput({
          command: { key: accepted.record.key, ...startedTurn, chatId: 'chat-1' },
          content: 'Synthetic task', options: startedTurn, settlement,
          dispatch: (executionAdmission) => agents.startSession('chat-1', 'Synthetic task', { ...startedTurn, executionAdmission }),
        });
        await failed.promise;
        expect(await ledger.getTurnRecord('chat-1', 'turn-1')).toMatchObject({
          status: 'failed', turnResult: { availability: 'unavailable', reason: 'no-final-response' },
        });
        expect(transcripts.currentRows('chat-1')).toEqual([]);
        await execution[method]('chat-1');
        await fixture.wiring.waitForIdle();
        expect((await ledger.getTurnRecord('chat-1', 'turn-1')).publicTerminalAt).toEqual(expect.any(String));
        expect(await receipt).toMatchObject({ status: 'finished', interruptionReason: 'user-stop' });

        successor = execution.reserveDirectTurn('chat-1', { turnId: 'successor-turn', clientRequestId: 'successor-request' });
        release.resolve();
        await execution.waitForDispatches();
        await fixture.wiring.waitForIdle();
        expect(execution.ownsExecution('chat-1')).toBe(true);
        expect(successor.executionAdmission.signal.aborted).toBe(false);
        expect(fixture.sink).toBeUndefined();
        expect(transcripts.currentRows('chat-1')).toEqual([]);
        expect(fixture.published.filter((event) => event.type === 'agent-run-failed')).toEqual([]);
      } finally {
        cancellation.abort();
        release.resolve();
        if (successor) await execution.releaseDirectTurn(successor);
        await execution.waitForDispatches();
        await fixture.wiring.waitForIdle();
        store.close();
        await rm(directory, { recursive: true, force: true });
      }
    });

    it.each([
      ['finished', { type: 'text', text: 'Synthetic completed output' }],
      ['finished', null],
      ['failed', null],
    ])(`preserves a committed %s receipt when ${method} precedes terminal publication`, async (outcome, finalResponse) => {
      const directory = await mkdtemp(path.join(tmpdir(), 'terminal-stop-wiring-'));
      const fixture = createExecutionFixture(directory);
      const { store, transcripts, execution, ledger } = fixture;
      const startedTurn = { turnId: 'turn-1', commandType: 'chat-start', clientRequestId: 'request-1' };
      try {
        await ledger.accept({ ...startedTurn, chatId: 'chat-1', payload: {} });
        const receipt = ledger.waitForTurnTerminal('chat-1', 'turn-1', new AbortController().signal);
        const reservation = execution.reserveDirectTurn('chat-1', startedTurn);
        await execution.runReservedTurn(reservation, 'Synthetic task', startedTurn);
        await fixture.wiring.waitForIdle();

        fixture.sink.publish({ type: 'run-ended', runId: 'turn-1', outcome, finalResponse });
        expect(transcripts.currentRows('chat-1').at(-1)).toMatchObject({ kind: 'run-ended', outcome });
        expect(execution.ownsExecution('chat-1')).toBe(true);
        const stopping = execution[method]('chat-1');
        expect((await ledger.getTurnRecord('chat-1', 'turn-1')).publicTerminalAt).toBeUndefined();
        await stopping;
        await fixture.wiring.waitForIdle();

        const record = await receipt;
        expect(record.interruptionReason).toBeUndefined();
        expect(projectAgentTurnReceipt(record)).toMatchObject({ kind: 'found', receipt: {
          state: outcome === 'finished' ? 'completed' : 'failed',
          output: finalResponse
            ? { availability: 'available', text: finalResponse.text }
            : { availability: 'unavailable', reason: 'no-final-response' },
        } });
        expect(execution.ownsExecution('chat-1')).toBe(false);
        expect(transcripts.currentRows('chat-1').filter((row) => row.kind === 'run-ended'))
          .toMatchObject([{ outcome }]);
      } finally {
        await execution.waitForDispatches();
        await fixture.wiring.waitForIdle();
        store.close();
        await rm(directory, { recursive: true, force: true });
      }
    });
  }

  it('settles Stop before a run exists and fences delayed startup from its successor', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'startup-stop-wiring-'));
    const ledger = new CommandLedger();
    const prepared = Promise.withResolvers();
    const release = Promise.withResolvers();
    const delivered = mock();
    const execution = new ChatExecutionCoordinator(directory, {
      runAgentTurn: mock(), captureSteerTarget: () => null,
      abortSession: async () => false, isChatRunning: () => false,
    }, {
      admitInput: async () => ({ inserted: true }),
      hasMatchingInput: async () => false,
      admitQueuedInput: () => ({ inserted: true }), discardPreparedInput() {},
    }, () => ({}), () => true, new InMemoryChatExecutionControlRepository('synthetic-server'), {
      projectAdmission: { assertAvailable: async () => undefined },
      isControlInputViewCurrent: () => true,
    });
    const fixture = createFixture({ queueService: execution, commandLedgerInstance: ledger });
    let successor;
    try {
      const accepted = await ledger.accept({ commandType: 'chat-start', chatId: 'chat-1',
        clientRequestId: 'startup-request', turnId: 'startup-turn', payload: {} });
      const receipt = ledger.waitForTurnTerminal('chat-1', 'startup-turn', new AbortController().signal);
      await execution.scheduleDirectInput({
        command: { key: accepted.record.key, chatId: 'chat-1', clientRequestId: 'startup-request', turnId: 'startup-turn' },
        content: 'Synthetic task', options: { commandType: 'chat-start', clientRequestId: 'startup-request', turnId: 'startup-turn' },
        settlement: new ChatCommandSettlement(ledger),
        dispatch: async (admission) => {
          prepared.resolve();
          await release.promise;
          admission.signal.throwIfAborted();
          delivered();
        },
      });
      await prepared.promise;
      expect(execution.ownsExecution('chat-1')).toBe(true);
      expect(await execution.interruptActiveTurn('chat-1')).toBe('interrupt-requested');
      await fixture.wiring.waitForIdle();
      expect(await receipt).toMatchObject({ turnId: 'startup-turn', interruptionReason: 'user-stop', status: 'finished' });
      successor = execution.reserveDirectTurn('chat-1', { turnId: 'successor-turn', clientRequestId: 'successor-request' });
      release.resolve();
      await execution.waitForDispatches();
      await fixture.wiring.waitForIdle();
      expect(delivered).not.toHaveBeenCalled();
      expect(execution.ownsExecution('chat-1')).toBe(true);
      expect(successor.executionAdmission.signal.aborted).toBe(false);
      expect(await ledger.getTurnRecord('chat-1', 'startup-turn')).toMatchObject({ interruptionReason: 'user-stop', status: 'finished' });
      expect(fixture.published.filter((event) => event.type === 'agent-run-failed')).toEqual([]);
    } finally {
      release.resolve();
      if (successor) await execution.releaseDirectTurn(successor);
      await execution.waitForDispatches();
      await fixture.wiring.waitForIdle();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('broadcasts revisioned Chat Board invalidations without catalog content', () => {
    const fixture = createFixture();

    fixture.chatBoards.invalidated(7, 'reordered');

    expect(fixture.published).toEqual([{
      type: 'chat-boards-invalidated',
      revision: 7,
      reason: 'reordered',
    }]);
  });

  it('broadcasts preamble catalog invalidations without catalog content', () => {
    const fixture = createFixture();

    fixture.preambles.invalidated('updated');

    expect(fixture.published).toEqual([{ type: 'preambles-invalidated', reason: 'updated' }]);
  });

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

  it('broadcasts the selection-change notice before its per-chat invalidation', async () => {
    const fixture = createFixture();
    const selectionChangeRow = {
      kind: 'notice',
      ordinal: 4,
      at,
      providerMeta: null,
      message: 'Preambles updated',
      detail: {
        type: 'preamble-selection-change',
        clientMessageId: 'selection-msg-1',
        requestFingerprint: 'fingerprint-1',
        selectionRevision: 2,
        preambles: [{ id: '3502b645-222b-49d2-ac39-1c91f9fb1174', title: 'Repository conventions' }],
      },
    };

    fixture.agent.transcript({
      type: 'rows',
      chatId: 'chat-1',
      viewId: 'view-1',
      rows: [selectionChangeRow],
    });
    await fixture.wiring.waitForIdle();

    const types = fixture.published.map((message) => message.type);
    expect(types).toContain('chat-messages');
    expect(types).toContain('chat-preambles-invalidated');
    expect(types.indexOf('chat-messages')).toBeLessThan(types.indexOf('chat-preambles-invalidated'));
    expect(fixture.published.at(-1)).toMatchObject({
      type: 'chat-preambles-invalidated',
      chatId: 'chat-1',
      revision: 2,
    });
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
    expect(fixture.published[3]).toMatchObject({
      type: 'agent-run-finished',
      outcome: 'finished',
    });
    expect(fixture.queueService.onAgentTurnTerminal).toHaveBeenCalledWith('chat-1', turn, 'finished');
    expect(fixture.commandLedger.settleTerminal).toHaveBeenCalledWith(
      'agent-run:chat-1:request-1',
      'finished',
      {},
    );
  });

  it('preserves interrupted completion outcomes in the browser contract', async () => {
    const fixture = createFixture();

    fixture.agent.finished('chat-1', 0, turn, 'interrupted');
    await fixture.wiring.waitForIdle();

    expect(fixture.published).toContainEqual(
      expect.objectContaining({
        type: 'agent-run-finished',
        chatId: 'chat-1',
        exitCode: 0,
        outcome: 'interrupted',
      }),
    );
  });

  it('captures only the committed final response before terminal settlement', async () => {
    const calls = [];
    const fixture = createFixture({
      commandLedger: {
        setTurnResult: mock(async (chatId, turnId, response) => {
          calls.push(['capture', chatId, turnId, response]);
        }),
        settleTerminal: mock(async () => {
          calls.push(['settle']);
        }),
      },
    });

    await fixture.agent.transcript({ ...terminalCommit(), finalResponse: { type: 'text', text: 'answer' } });
    fixture.agent.finished('chat-1', 0, turn, 'finished');
    await fixture.wiring.waitForIdle();

    expect(calls).toEqual([
      ['capture', 'chat-1', 'turn-1', { type: 'text', text: 'answer' }],
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

  it('settles the captured reservation-only turn after transcript rows and before Stop publication', async () => {
    const fixture = createFixture();
    fixture.agent.transcript(providerCommit());
    fixture.queue.stopped('chat-1', 'interrupt-requested', 'stop', { turnId: 'reserved-start' });
    await fixture.wiring.waitForIdle();
    expect(fixture.commandLedger.markInterruptedWithoutRunTerminal).toHaveBeenCalledWith('chat-1', 'reserved-start', 'user-stop');
    expect(fixture.published.map((event) => event.type))
      .toEqual(['chat-messages', 'chat-session-stopped', 'chat-processing-updated']);
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

  it('publishes unavailable-project queue warnings as operational notices', async () => {
    const fixture = createFixture();
    const unavailable = new ProjectUnavailableError('/workspace/missing', 'not-found');

    fixture.queue.projectUnavailable('chat-1', unavailable);
    await fixture.wiring.waitForIdle();

    expect(fixture.published).toEqual([expect.objectContaining({
      type: 'chat-operational-notice',
      chatId: 'chat-1',
      noticeType: 'warning',
      content: unavailable.message,
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
