import { resolveFileMentionsInCommand } from "../../runtime/projects/file-mentions.ts";
import { describe, expect, it, mock } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AssistantMessage, BashToolUseMessage } from '../../../common/chat-types.js';
import { emptyStoredChatExecutionControl } from '../chat-execution/control-state.ts';
import { ChatTransientFeedStore } from '../chats/chat-transient-feed.js';
import { ProjectUnavailableError } from '../../common/domain-error.ts';
import { wireSearchSourceAvailability, wireServerEvents } from '../server-event-wiring.js';
import { ChatExecutionCoordinator } from '../chat-execution/chat-execution-coordinator.js';
import { InMemoryChatExecutionControlRepository } from '../chat-execution/chat-execution-control-repository.js';
import { CommandLedger } from '../commands/command-ledger.js';
import { ChatCommandSettlement } from '../commands/chat-command-settlement.js';
import { projectAgentTurnReceipt } from '../commands/agent-turn-receipt-projector.js';
import { AgentRegistry } from '../agents/registry.js';
import { createProducerFixture, permissionResponse } from '../agents/__tests__/producer-fixture.ts';
import { TranscriptLedgerService } from '../ledger/service.js';
import { TranscriptLedgerStore } from '../ledger/store.js';
import { KeyedPromiseLock } from '../../common/keyed-lock.js';
import { AttentionTracker } from '../notifications/attention-tracker.js';
import {
  attachNativeMessageSource,
  getNativeMessageRevisionSource,
} from '../../common/native-message-source.ts';

const at = '2026-08-12T00:00:00.000Z';

it('isolates executor loss and queue wake-up, and publishes complete executor snapshots', async () => {
  const remote = '22222222-2222-4222-8222-222222222222';
  const executors = [{ id: 'local', label: 'Local' }, { id: remote, label: 'Worker' }];
  const fixture = createFixture({
    executors,
    chatRegistry: {
      listChatIds: () => ['local-chat', 'remote-chat', 'other-chat'],
      getChat: (id) => ({ executorId: id === 'local-chat' ? undefined : id === 'remote-chat' ? remote : 'other' }),
    },
  });
  fixture.executor.availability(remote, 'offline');
  expect(fixture.agentRegistry.executionSessionLost).toHaveBeenCalledWith(remote);
  expect(fixture.ownershipJournal.retryProviderCleanup).not.toHaveBeenCalled();
  expect(fixture.searchIndex.sourceAvailable).not.toHaveBeenCalled();
  fixture.executor.availability(remote, 'ready');
  await Promise.resolve();
  expect(fixture.ownershipJournal.retryProviderCleanup.mock.calls).toEqual([[remote]]);
  expect(fixture.queueService.triggerDrain.mock.calls).toEqual([['remote-chat']]);
  expect(fixture.searchIndex.sourceAvailable.mock.calls).toEqual([['remote-chat']]);
  fixture.executor.changed();
  expect(fixture.published).toContainEqual({ type: 'executors-changed', executors });
});

it('settles executor loss and drains only when ready', async () => {
  const fixture = createFixture();
  fixture.executor.availability('local', 'offline');
  expect(fixture.agentRegistry.executionSessionLost).toHaveBeenCalledTimes(1);
  fixture.executor.availability('local', 'ready');
  await Promise.resolve();
  expect(fixture.queueService.triggerDrain).toHaveBeenCalledWith('chat-1');
  fixture.executor.availability('local', 'disposed');
  expect(fixture.agentRegistry.executionSessionLost).toHaveBeenCalledTimes(1);
  expect(fixture.queueService.triggerDrain).toHaveBeenCalledTimes(1);
});

it('drains queues even when ready-executor native cleanup fails', async () => {
  const fixture = createFixture({ ownershipJournal: {
    retryProviderCleanup: mock(async () => { throw new Error('Synthetic cleanup failure'); }),
  } });
  fixture.executor.availability('local', 'ready');
  await Promise.resolve();
  expect(fixture.queueService.triggerDrain).toHaveBeenCalledWith('chat-1');
});

it('retries native cleanup for executors that became ready before event wiring', () => {
  const fixture = createFixture({ executors: [
    { id: 'ready-executor', availability: 'ready' },
    { id: 'offline-executor', availability: 'offline' },
  ] });
  expect(fixture.ownershipJournal.retryProviderCleanup.mock.calls).toEqual([['ready-executor']]);
  expect(fixture.queueService.readChatExecutionControl).not.toHaveBeenCalled();
  expect(fixture.queueService.triggerDrain).not.toHaveBeenCalled();
  expect(fixture.searchIndex.sourceAvailable).not.toHaveBeenCalled();
});

it.each(['empty', 'user', 'control'])('readiness wakes only pending inputs: %s', async (kind) => {
  const control = emptyStoredChatExecutionControl('test');
  if (kind === 'user') control.entries.push({ id: 'pending-user' });
  if (kind === 'control') control.controlEntries.push({ id: 'pending-control' });
  const fixture = createFixture({ queue: { readChatExecutionControl: mock(async () => control) } });
  fixture.executor.availability('local', 'ready');
  await Promise.resolve();
  expect(fixture.queueService.triggerDrain).toHaveBeenCalledTimes(kind === 'empty' ? 0 : 1);
});

it('observes genuine source readiness before the rest of the server is wired', async () => {
  let listener;
  const remove = mock();
  let failFirst;
  let failed = false;
  let attempts = 1;
  const initialResync = new Promise((resolve) => { failFirst = () => { failed = true; resolve(); }; });
  const unsubscribe = wireSearchSourceAvailability(
    { onAvailabilityChanged(cb) { listener = cb; return remove; } },
    { listChatIds: () => ['remote', 'local'], getChat: (id) => ({ executorId: id === 'remote' ? 'worker' : 'local' }) },
    { async sourceAvailable(chatId) {
      expect(chatId).toBe('remote');
      await initialResync;
      if (failed) attempts++;
    } },
  );
  expect(attempts).toBe(1);
  listener('worker', 'ready');
  failFirst();
  await initialResync;
  expect(attempts).toBe(2);
  unsubscribe();
  expect(remove).toHaveBeenCalledTimes(1);
});

function createFixture(overrides = {}) {
  const executor = {};
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
    onPermissionRetired: mock((callback) => { agent.permissionRetired = callback; }),
    onSessionCreated: mock((callback) => { agent.session = callback; }),
    onFinished: mock((callback) => { agent.finished = callback; }),
    onFailed: mock((callback) => { agent.failed = callback; }),
    resendCandidates: mock(() => []),
    settleTurn: mock(() => undefined),
    discardTurn: mock(() => undefined),
    executionSessionLost: mock(() => undefined),
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
    triggerDrain: mock(async () => undefined),
    readChatExecutionControl: mock(async () => ({
      ...emptyStoredChatExecutionControl('test'), entries: [{ id: 'pending-input' }],
    })),
    ...overrides.queue,
  };
  const chatRegistry = {
    listChatIds: () => ['chat-1'],
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
    sourceAvailable: mock(async () => undefined),
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
  const ownershipJournal = {
    retryProviderCleanup: mock(async () => undefined),
    ...overrides.ownershipJournal,
  };
  const transientFeeds = new ChatTransientFeedStore('server-instance-test');
  const availabilityListeners = [];
  executor.availability = (id, availability) => availabilityListeners.forEach((cb) => cb(id, availability));
  const executorManager = {
      onAvailabilityChanged: (listener) => { availabilityListeners.push(listener); return () => {}; },
      onChanged: (listener) => { executor.changed = listener; return () => {}; },
      list: () => overrides.executors ?? [],
  };
  wireSearchSourceAvailability(executorManager, chatRegistry, searchIndex);
  const wiring = wireServerEvents({
    ownershipJournal,
    executors: executorManager,
    projectBasePath: '/worker/projects',
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
    transientFeeds,
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
    ownershipJournal,
    executor,
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
    transientFeeds,
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

function createExecutionFixture(directory, ensureAdopted, beforeWiringCommitListener, options = {}) {
  const store = new TranscriptLedgerStore(directory);
  const transcripts = new TranscriptLedgerService(store, { serverInstanceId: 'server-instance-test' });
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
  const producer = createProducerFixture();
  const integration = {
    descriptor: { id: 'test', supportedPermissionModes: ['default'], supportedThinkingModes: ['none'] },
    settings: { defaults: () => agentSettings, parse: (input) => input },
    producers: producer.producers,
    execution: {
      start: async (request) => {
        sink = { publish: (event) => producer.emit(request.producerBinding, event) };
        sink.publish({ type: 'started', runId: request.runId });
        if (options.onStart) await options.onStart(request);
        return producer.reference('execution');
      },
      abort: async () => true,
    },
  };
  const agents = new AgentRegistry({
    resolveFileMentions: resolveFileMentionsInCommand,
    registry: { getChat: () => entry, updateChat: (_chatId, patch) => Object.assign(entry, patch) },
    integrations: { require: () => integration, get: () => integration, list: () => [integration] },
    endpointResolver: {
      describePrevious(input) { return this.resolveSelection(input); },
      resolveSelection: () => ({ model: 'model-a', apiProviderId: null, endpointId: null, protocol: null, isLocal: false }),
      resolveEndpointReference: () => null,
    },
    getCarryOverRevision: () => '', createCarriedContext: async () => ({ kind: 'no-history' }),
    ledger: transcripts, adoption: { ensure: ensureAdopted ?? (async () => view) },
    hasPendingOwnershipTransfer: () => false, preambles: {}, selectionAdmissionLock: new KeyedPromiseLock(),
  });
  const execution = new ChatExecutionCoordinator(directory, agents, options.inputTranscript?.(agents) ?? {
    admitInput: async () => ({ inserted: true }), hasMatchingInput: async () => false,
    admitQueuedInput: () => ({ inserted: true }), discardPreparedInput() {},
  }, () => ({}), () => true, new InMemoryChatExecutionControlRepository('synthetic-server'), {
    projectAdmission: { assertAvailable: async () => undefined }, isControlInputViewCurrent: () => true,
    ...options.coordinator,
  });
  const ledger = new CommandLedger();
  if (beforeWiringCommitListener) agents.onTranscriptCommitted(beforeWiringCommitListener);
  options.beforeWiring?.({ agents, execution, transcripts });
  const fixture = createFixture({
    ...options.wiring,
    commandLedgerInstance: ledger, queueService: execution,
    agentRegistry: {
      onTranscriptCommitted: (callback) => agents.onTranscriptCommitted(callback),
      onPermissionRetired: (callback) => agents.onPermissionRetired(callback),
      onSessionCreated: (callback) => agents.onSessionCreated(callback),
      onFinished: (callback) => agents.onFinished(callback),
      onFailed: (callback) => agents.onFailed(callback),
      settleTurn: (...args) => agents.settleTurn(...args),
    },
  });
  return { ...fixture, store, transcripts, agents, execution, ledger, get sink() { return sink; } };
}

function observeTelegram({ agents, execution }, directory, send, enabled = true) {
  new AttentionTracker(agents, execution,
    { getUiSettings: () => ({ notifications: { telegram: { enabled } } }), getChatName: () => null },
    { getChat: () => ({ agentId: 'test', projectPath: directory }) },
    { getChatMetadata: () => ({ firstMessage: 'Cached title' }) },
    { isConfigured: true, send }, { getRecipientChatId: () => 'recipient' },
  );
}

describe('server event wiring', () => {
  it.each([false, true])('startup does not drain empty queues or read transcripts for Telegram: enabled=%p', async (enabled) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'startup-attention-'));
    const send = mock(async () => true);
    const idle = mock();
    const readHistory = mock(() => { throw new Error('Startup must not load transcript history'); });
    const fixture = createExecutionFixture(directory, undefined, undefined, {
      wiring: { executors: [{ id: 'local', availability: 'ready' }] },
      beforeWiring({ agents, execution, transcripts }) {
        transcripts.currentRows = readHistory;
        transcripts.conversationMessages = readHistory;
        execution.onChatIdle(idle);
        observeTelegram({ agents, execution }, directory, send, enabled);
      },
    });
    try {
      await Bun.sleep(0);
      expect(idle).not.toHaveBeenCalled();
      expect(readHistory).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
      // A genuine empty drain is still harmless; idle alone is not a completion.
      await fixture.execution.triggerDrain('chat-1');
      expect(idle).toHaveBeenCalledTimes(1);
      expect(send).not.toHaveBeenCalled();
      expect(readHistory).not.toHaveBeenCalled();
    } finally {
      fixture.transcripts.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('notifies once after a direct turn and its queued follow-up using committed live context', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'queued-attention-wiring-'));
    const delivered = Promise.withResolvers();
    const followUpStarted = Promise.withResolvers();
    const send = mock(async () => { delivered.resolve(); return true; });
    const fixture = createExecutionFixture(directory, undefined, undefined, {
      inputTranscript: (agents) => agents,
      beforeWiring: (ports) => observeTelegram(ports, directory, send),
      onStart: (request) => { if (request.runId !== turn.turnId) followUpStarted.resolve(request.runId); },
    });
    const { execution, ledger, transcripts } = fixture;
    const startedTurn = { ...turn, clientMessageId: 'input-1' };
    try {
      const accepted = await ledger.accept({ ...startedTurn, chatId: 'chat-1', payload: {} });
      await execution.scheduleDirectInput({
        command: { key: accepted.record.key, ...startedTurn, chatId: 'chat-1' },
        content: 'Initial input', options: startedTurn, settlement: new ChatCommandSettlement(ledger),
      });
      await execution.waitForDispatches();
      await execution.createChatQueueEntry('chat-1', 'Queued follow-up');
      fixture.sink.publish({ type: 'run-ended', runId: startedTurn.turnId, outcome: 'finished',
        finalResponse: { type: 'text', text: 'Initial result' } });
      const followUpRunId = await followUpStarted.promise;
      await fixture.wiring.waitForIdle();
      expect(send).not.toHaveBeenCalled();
      expect(transcripts.activeRunId('chat-1')).toBe(followUpRunId);
      expect(followUpRunId).not.toBe(startedTurn.turnId);

      fixture.sink.publish({ type: 'rows', rows: [{ message: new AssistantMessage(at, 'Intermediate output') }] });
      fixture.sink.publish({ type: 'run-ended', runId: followUpRunId, outcome: 'finished',
        finalResponse: { type: 'text', text: 'Final queued result' } });
      await delivered.promise;
      await execution.waitForExecutionOwners();
      await fixture.wiring.waitForIdle();
      expect(execution.ownsExecution('chat-1')).toBe(false);
      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0]).toEqual(['recipient', expect.stringContaining('Queued follow-up'), 'HTML']);
      expect(send.mock.calls[0][1]).toContain('Final queued result');
      expect(send.mock.calls[0][1]).not.toContain('Initial input');
      expect(send.mock.calls[0][1]).not.toContain('Intermediate output');
      await execution.triggerDrain('chat-1');
      expect(send).toHaveBeenCalledTimes(1);
    } finally {
      await execution.waitForDispatches();
      await fixture.wiring.waitForIdle();
      transcripts.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(['direct', 'queued', 'offline direct'])('notifies after a %s dispatch fails before a ledger run begins', async (kind) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'failed-attention-wiring-'));
    const send = mock(async () => true);
    const direct = kind !== 'queued';
    let adoptionCalls = 0;
    const fixture = createExecutionFixture(directory, async () => {
      // Direct input admission succeeds; runtime preparation fails before beginRun.
      if (++adoptionCalls === 1 && direct) return fixture.transcripts.currentView('chat-1');
      throw new Error('Synthetic source unavailable');
    }, undefined, {
      inputTranscript: (agents) => agents,
      beforeWiring: (ports) => observeTelegram(ports, directory, send),
      coordinator: { canDispatch: () => kind !== 'offline direct' },
    });
    const { execution, ledger, transcripts } = fixture;
    try {
      if (direct) {
        const startedTurn = { ...turn, clientMessageId: 'input-1' };
        const accepted = await ledger.accept({ ...startedTurn, chatId: 'chat-1', payload: {} });
        await execution.scheduleDirectInput({
          command: { key: accepted.record.key, ...startedTurn, chatId: 'chat-1' },
          content: 'Failed input', options: startedTurn, settlement: new ChatCommandSettlement(ledger),
        });
        await execution.waitForDispatches();
      } else {
        await execution.createChatQueueEntry('chat-1', 'Failed input');
        await execution.triggerDrain('chat-1');
      }
      await fixture.wiring.waitForIdle();
      expect(fixture.sink).toBeUndefined();
      expect(transcripts.currentRows('chat-1').map((row) => row.kind)).toEqual(['user-input']);
      expect(execution.ownsExecution('chat-1')).toBe(false);
      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0][1]).toContain('Failed input');
      expect(send.mock.calls[0][1]).toContain('Failed: Synthetic source unavailable');
      expect(adoptionCalls).toBe(direct ? 2 : 1);
    } finally {
      await execution.waitForDispatches();
      await fixture.wiring.waitForIdle();
      transcripts.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    ['pre-run', true],
    ['pre-run', false],
    ['terminal-during-drain', true],
    ['terminal-during-drain', false],
    ['terminal-after-drain', true],
  ])('notifies on %s failure with executor ready=%p without dispatching a paused queue tail', async (phase, readyOnFailure) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'paused-attention-wiring-'));
    const delivered = Promise.withResolvers();
    const send = mock(async () => { delivered.resolve(); return true; });
    const fail = (runId) => fixture.sink.publish({ type: 'run-ended', runId, outcome: 'failed',
      error: { code: 'PROVIDER_FAILURE', message: 'Synthetic source unavailable' } });
    const started = mock((request) => {
      if (phase === 'terminal-during-drain') {
        available = readyOnFailure;
        fail(request.runId);
      }
    });
    const preRun = phase === 'pre-run';
    let available = true;
    const failAdoption = async () => {
      available = readyOnFailure;
      throw new Error('Synthetic source unavailable');
    };
    const fixture = createExecutionFixture(directory, preRun ? failAdoption : undefined, undefined, {
      inputTranscript: (agents) => agents,
      beforeWiring: (ports) => observeTelegram(ports, directory, send),
      onStart: started,
      coordinator: { canDispatch: () => available },
    });
    const { execution, transcripts } = fixture;
    try {
      await execution.createChatQueueEntry('chat-1', 'Failed input');
      await execution.createChatQueueEntry('chat-1', 'Retained input');
      await execution.triggerDrain('chat-1');
      if (phase === 'terminal-after-drain') fail(transcripts.activeRunId('chat-1'));
      await delivered.promise;
      await execution.waitForExecutionOwners();
      await fixture.wiring.waitForIdle();
      const control = await execution.readChatExecutionControl('chat-1');
      expect(control.pause).toMatchObject({ kind: 'queued-turn-failed' });
      expect(control.entries.map((entry) => entry.content)).toEqual(['Retained input']);
      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0][1]).toContain('Failed input');
      expect(send.mock.calls[0][1]).toContain('Failed: Synthetic source unavailable');
      await execution.triggerDrain('chat-1');
      expect(send).toHaveBeenCalledTimes(1);
      expect(started).toHaveBeenCalledTimes(preRun ? 0 : 1);
    } finally {
      await execution.waitForDispatches();
      await fixture.wiring.waitForIdle();
      transcripts.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('notifies on direct failure while an unpaused follow-up waits for its offline executor', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'offline-tail-attention-wiring-'));
    const send = mock(async () => true);
    let available = true;
    let adoptionCalls = 0;
    const fixture = createExecutionFixture(directory, async () => {
      if (++adoptionCalls === 1) return fixture.transcripts.currentView('chat-1');
      await fixture.execution.createChatQueueEntry('chat-1', 'Waiting follow-up');
      available = false;
      throw new Error('Executor unavailable');
    }, undefined, {
      inputTranscript: (agents) => agents,
      beforeWiring: (ports) => observeTelegram(ports, directory, send),
      coordinator: { canDispatch: () => available },
    });
    const { execution, ledger, transcripts } = fixture;
    const startedTurn = { ...turn, clientMessageId: 'input-1' };
    try {
      const accepted = await ledger.accept({ ...startedTurn, chatId: 'chat-1', payload: {} });
      await execution.scheduleDirectInput({
        command: { key: accepted.record.key, ...startedTurn, chatId: 'chat-1' },
        content: 'Failed input', options: startedTurn, settlement: new ChatCommandSettlement(ledger),
      });
      await execution.waitForDispatches();
      await fixture.wiring.waitForIdle();
      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0][1]).toContain('Failed: Executor unavailable');
      const control = await execution.readChatExecutionControl('chat-1');
      expect(control.pause).toBeNull();
      expect(control.entries.map((entry) => entry.content)).toEqual(['Waiting follow-up']);
      await execution.triggerDrain('chat-1');
      expect(send).toHaveBeenCalledTimes(1);
      expect(adoptionCalls).toBe(2);
      expect(fixture.sink).toBeUndefined();
      expect(execution.ownsExecution('chat-1')).toBe(false);
    } finally {
      await execution.waitForDispatches();
      await fixture.wiring.waitForIdle();
      transcripts.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('preserves a committed completion when the launch reply subsequently fails', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'late-launch-attention-wiring-'));
    const started = Promise.withResolvers();
    const launchReply = Promise.withResolvers();
    const send = mock(async () => true);
    const fixture = createExecutionFixture(directory, undefined, undefined, {
      inputTranscript: (agents) => agents,
      beforeWiring: (ports) => observeTelegram(ports, directory, send),
      onStart() { started.resolve(); return launchReply.promise; },
    });
    const { execution, ledger, transcripts } = fixture;
    const startedTurn = { ...turn, clientMessageId: 'input-1' };
    try {
      const accepted = await ledger.accept({ ...startedTurn, chatId: 'chat-1', payload: {} });
      await execution.scheduleDirectInput({
        command: { key: accepted.record.key, ...startedTurn, chatId: 'chat-1' },
        content: 'Initial input', options: startedTurn, settlement: new ChatCommandSettlement(ledger),
      });
      await started.promise;
      fixture.sink.publish({ type: 'run-ended', runId: turn.turnId, outcome: 'finished',
        finalResponse: { type: 'text', text: 'Committed result' } });
      launchReply.reject(new Error('Synthetic late launch failure'));
      await execution.waitForDispatches();
      await fixture.wiring.waitForIdle();
      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0][1]).toContain('Committed result');
      expect(send.mock.calls[0][1]).not.toContain('Failed');
      expect(execution.ownsExecution('chat-1')).toBe(false);
      expect(transcripts.currentRows('chat-1').at(-1)).toMatchObject({ kind: 'run-ended', outcome: 'finished' });
    } finally {
      launchReply.resolve();
      await execution.waitForDispatches();
      await fixture.wiring.waitForIdle();
      transcripts.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

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

  it('removes a validated permission through the production registry listener chain without a terminal fact', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'garcon-permission-retirement-wiring-'));
    const attention = mock(() => undefined);
    const fixture = createExecutionFixture(root, undefined, attention);
    const ledger = fixture.transcripts;
    try {
      const requestApplied = Promise.withResolvers();
      fixture.agents.onTranscriptCommitted(() => requestApplied.resolve());
      const view = ledger.currentView('chat-1');
      const producer = ledger.openProducer('chat-1', 'test');
      ledger.beginRun('chat-1', 'run-1');
      const occurrence = '11111111-1111-4111-8111-111111111111';
      producer.sink.publish({
        type: 'permission', runId: 'run-1',
        lifecycle: {
          kind: 'requested', permissionOccurrenceId: occurrence,
          requestedTool: new BashToolUseMessage(at, 'synthetic-tool', 'pwd'), options: [],
        },
        decision: { permissionOccurrenceId: occurrence, response: permissionResponse(occurrence) },
      });
      const control = {
        serverInstanceId: 'server-instance-test', chatId: 'chat-1', runId: 'run-1', permissionOccurrenceId: occurrence,
      };
      expect(() => fixture.transientFeeds.validateAction(control)).toThrow();
      await requestApplied.promise;
      expect(attention).toHaveBeenCalledTimes(1);
      fixture.transientFeeds.validateAction(control);
      const claim = ledger.claimPermissionResolution(control);
      ledger.retirePermissionResolution(claim);
      await Promise.resolve();
      await fixture.wiring.waitForIdle();
      expect(fixture.published.map(message => message.type)).toEqual([
        'chat-messages', 'chat-transient-feed-mutation', 'chat-transient-feed-mutation',
      ]);
      expect(fixture.published[1]).toMatchObject({ transientRevision: 1, mutation: { kind: 'upsert' } });
      expect(fixture.published[2]).toMatchObject({
        serverInstanceId: 'server-instance-test', chatId: 'chat-1', transcriptViewId: view.viewId,
        transientRevision: 2, mutation: { kind: 'remove', permissionOccurrenceId: occurrence },
      });
      expect(ledger.currentRows('chat-1').map(row => row.kind)).toEqual(['permission-requested']);
      expect(ledger.isRunActive('chat-1', 'run-1')).toBe(true);
      expect(fixture.transientFeeds.currentSnapshot('chat-1').rows).toEqual([]);
    } finally {
      ledger.close();
      await rm(root, { recursive: true, force: true });
    }
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

  it.each(['agent', 'queue'])('publishes a dispatch failure once when %s reports first', async first => {
    const fixture = createFixture();
    const report = (source, chatId = 'chat-1', metadata = turn) => source === 'agent'
      ? fixture.agent.failed(chatId, 'Synthetic dispatch failure', 'SESSION_BUSY', metadata)
      : fixture.queue.failed(chatId, 'Synthetic dispatch failure', metadata);
    fixture.agent.transcript(providerCommit('partial answer'));
    fixture.agent.transcript(terminalCommit('failed'));
    report(first);
    report(first === 'agent' ? 'queue' : 'agent');
    await fixture.wiring.waitForIdle();
    report(first);
    await fixture.wiring.waitForIdle();

    const terminals = () => fixture.published.filter(message =>
      message.type === 'agent-run-failed' || message.type === 'agent-run-finished');
    expect(terminals()).toEqual([expect.objectContaining({
      type: 'agent-run-failed', chatId: 'chat-1', turnId: turn.turnId,
    })]);
    expect(fixture.commandLedger.settleTerminal).toHaveBeenCalledTimes(1);
    expect(fixture.commandLedger.markPublicTerminal).toHaveBeenCalledTimes(1);
    const types = fixture.published.map(message => message.type);
    expect(types.lastIndexOf('chat-messages')).toBeLessThan(types.indexOf('agent-run-failed'));

    report(first, 'chat-1', { ...turn, turnId: 'turn-2', clientRequestId: 'request-2' });
    report(first, 'chat-2');
    await fixture.wiring.waitForIdle();
    expect(terminals()).toHaveLength(3);
  });

  it('does not deduplicate failures without a turn or request identity', async () => {
    const fixture = createFixture();
    fixture.agent.failed('chat-1', 'Synthetic first failure', 'INTERNAL_ERROR');
    fixture.agent.failed('chat-1', 'Synthetic second failure', 'INTERNAL_ERROR');
    await fixture.wiring.waitForIdle();
    expect(fixture.published.filter(message => message.type === 'agent-run-failed')).toHaveLength(2);
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

  it('orders settings invalidation after pending transcript publication and skips deleted chats', async () => {
    const fixture = createFixture();
    fixture.agent.transcript(providerCommit());
    fixture.wiring.notifyChatSettingsUpdated('chat-1');
    await fixture.wiring.waitForIdle();
    expect(fixture.published.map((event) => event.type)).toEqual([
      'chat-messages', 'chat-list-refresh-requested',
    ]);
    expect(fixture.published.at(-1)).toMatchObject({
      reason: 'execution-settings-updated', chatId: 'chat-1',
    });
    expect(fixture.searchIndex.catalogMayHaveChanged).toHaveBeenCalledWith('chat-1');
    fixture.removeChat();
    fixture.wiring.notifyChatSettingsUpdated('chat-1');
    await fixture.wiring.waitForIdle();
    expect(fixture.published).toHaveLength(2);
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

    fixture.wiring.notifyOperationalNotice(
      'chat-1',
      'info',
      'Carryover is being compacted.',
      { type: 'carryover-compaction-started' },
    );

    expect(fixture.published).toEqual([expect.objectContaining({
      type: 'chat-operational-notice',
      chatId: 'chat-1',
      noticeType: 'info',
      content: 'Carryover is being compacted.',
      detail: { type: 'carryover-compaction-started' },
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
      detail: {
        type: 'project-unavailable',
        projectPath: '/workspace/missing',
        reason: 'not-found',
      },
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
