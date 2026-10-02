import type { ChatMessage, ChatStopIntent, ChatStopOutcome } from '../../common/chat-types.js';
import type { ExecutorManager } from './executors/manager.js';
import { effectiveExecutorId } from '../../common/executors.js';
import type { TranscriptSearchStatusV1 } from '../../common/chat-search.js';
import { isChatListInvalidationReason } from '../../common/ws-events.ts';
import { isErrorCode } from '../../common/error-codes.ts';
import { toClientChatExecutionControlState } from './chat-execution/control-state.ts';
import { wireExecutorAvailability } from './executors/availability-wiring.js';
import { createTranscriptEventFanout } from './ledger/event-fanout.js';
import { isLedgerPreambleSelectionChangedNoticeDetail } from './ledger/contracts.js';
import type { TurnEventMetadata } from './agents/event-bus.js';
import type { AgentRegistry } from './agents/registry.js';
import type { ChatRegistry } from './chats/store.js';
import type { AgentOwnershipJournal } from './chats/agent-ownership-journal.js';
import type { AppliedTransientFeedEvent, ChatTransientFeedStore } from './chats/chat-transient-feed.js';
import type { MetadataIndex } from './chats/metadata-store.js';
import type { ShareStore } from './chats/shares/store.js';
import type { SettingsStore } from './settings/store.js';
import type { ChatExecutionCoordinator } from './chat-execution/chat-execution-coordinator.js';
import type { ChatProcessingActivity } from './chats/chat-processing-activity.js';
import { commandLedgerKey, type CommandLedger } from './commands/command-ledger.js';
import type { TelegramNotifier } from './notifications/telegram.js';
import type { TelegramSettingsStore } from './notifications/telegram-settings-store.js';
import type { ScheduledPromptScheduler } from './scheduled-prompts/scheduler.js';
import type { SnippetService } from './snippets/service.js';
import type { PreambleService } from './preambles/service.js';
import type { ChatBoardService } from './chat-boards/service.js';
import { createLogger } from '../common/log.js';
import { errorMessage } from '../common/errors.js';
import { withActivity } from '../common/event-loop-stalls.js';
import { buildRemoteSettingsSnapshot } from './settings/remote-snapshot.js';
import {
  AgentRunFinishedMessage,
  AgentRunFailedMessage,
  ChatOperationalNoticeMessage,
  ChatSessionCreatedMessage,
  ChatProjectPathUpdatedMessage,
  ChatProcessingUpdatedMessage,
  ChatTitleUpdatedMessage,
  ChatSessionDeletedWsMessage,
  ChatReadUpdatedV1Message,
  ChatListRefreshRequestedMessage,
  ChatSessionStoppedMessage,
  ChatExecutionControlUpdatedMessage,
  ChatTransientFeedMutationMessage,
  SettingsChangedMessage,
  ApiProvidersInvalidatedMessage,
  ExecutorsChangedMessage,
  TranscriptSearchStatusMessage,
  ScheduledPromptsInvalidatedMessage,
  SnippetsInvalidatedMessage,
  PreamblesInvalidatedMessage,
  ChatPreamblesInvalidatedMessage,
  ChatBoardsInvalidatedMessage,
  TicketsInvalidatedMessage,
} from '../../common/ws-events.ts';

const logger = createLogger('server-events');

interface WebSocketPublisher {
  publish(topic: string, payload: string): unknown;
}

interface ChatSearchEventIndex {
  catalogMayHaveChanged(chatId: string): void;
  sourceAvailable(chatId: string): Promise<void>;
  deleteChat(chatId: string): void;
}

// Subscribes before search initialization so real startup transitions are not lost.
export function wireSearchSourceAvailability(
  executors: Pick<ExecutorManager, 'onAvailabilityChanged'>,
  registry: Pick<ChatRegistry, 'listChatIds' | 'getChat'>,
  search: Pick<ChatSearchEventIndex, 'sourceAvailable'>,
): () => void {
  return executors.onAvailabilityChanged((executorId, availability) => {
    if (availability !== 'ready') return;
    for (const chatId of registry.listChatIds()) {
      if (effectiveExecutorId(registry.getChat(chatId)?.executorId) !== executorId) continue;
      void search.sourceAvailable(chatId).catch((error) => {
        logger.warn('Executor search source refresh failed', { chatId, error });
      });
    }
  });
}

export interface ServerEventWiringDeps {
  executors: Pick<ExecutorManager, 'onAvailabilityChanged' | 'onChanged' | 'list'>;
  ownershipJournal: Pick<AgentOwnershipJournal, 'retryProviderCleanup'>;
  server: WebSocketPublisher;
  agentRegistry: AgentRegistry;
  chatRegistry: ChatRegistry;
  settings: SettingsStore;
  projectBasePath: string;
  queue: ChatExecutionCoordinator;
  processing: ChatProcessingActivity;
  metadata: MetadataIndex;
  currentTranscriptMessagePages(chatId: string): AsyncIterable<readonly ChatMessage[]>;
  transientFeeds: ChatTransientFeedStore;
  commandLedger: CommandLedger;
  shareStore: ShareStore;
  telegramNotifier: TelegramNotifier;
  telegramSettings: TelegramSettingsStore;
  scheduledPrompts: ScheduledPromptScheduler;
  snippets: SnippetService;
  preambles: PreambleService;
  chatBoards: ChatBoardService;
  searchIndex?: ChatSearchEventIndex;
}

export interface ServerEventWiring {
  notifyAgentHandoff(chatId: string): void;
  notifyChatSettingsUpdated(chatId: string): void;
  notifyTranscriptCompositionChanged(chatId: string): void;
  notifyOperationalNotice(
    chatId: string,
    noticeType: ChatOperationalNoticeMessage['noticeType'],
    content: string,
    detail?: ChatOperationalNoticeMessage['detail'],
  ): void;
  // Scheduled through the per-chat task queue so the invalidation follows the
  // committed update notice's own chat-messages fanout.
  notifyChatPreamblesInvalidated(chatId: string, revision: number): void;
  broadcastTranscriptSearchStatus(status: TranscriptSearchStatusV1): void;
  broadcastTicketsInvalidated(revision: number): void;
  broadcastApiProvidersInvalidated(): void;
  waitForIdle(): Promise<void>;
}

export function wireServerEvents({
  executors,
  ownershipJournal,
  projectBasePath,
  server,
  agentRegistry,
  chatRegistry,
  settings,
  queue,
  processing,
  metadata,
  currentTranscriptMessagePages,
  transientFeeds,
  commandLedger,
  shareStore,
  telegramNotifier,
  telegramSettings,
  scheduledPrompts,
  snippets,
  preambles,
  chatBoards,
  searchIndex,
}: ServerEventWiringDeps): ServerEventWiring {
  const broadcast = (payload: unknown) =>
    server.publish('chat', JSON.stringify(payload));
  const recentTurnFailures = new Map<string, number>();
  const inlineTerminalReleases = new Set<string>();
  const chatTaskTails = new Map<string, Promise<void>>();
  const activeChatTasks = new Set<Promise<void>>();
  let firstChatTaskError: unknown;
  let hasChatTaskError = false;
  const turnFailureDedupeMs = 30_000;

  chatBoards.on('invalidated', (revision, reason) => {
    broadcast(new ChatBoardsInvalidatedMessage(revision, reason));
  });

  // Serializes per-chat view work and lifecycle broadcasts so turn messages precede
  // terminal-driven processing, stop, and run-terminal events. Synchronous lifecycle
  // broadcasts would reintroduce the spinner-before-message race.
  function scheduleChatTask(
    chatId: string,
    activity: string,
    task: () => Promise<void> | void,
  ): Promise<void> {
    const previous = chatTaskTails.get(chatId) ?? Promise.resolve();
    const current = previous.then(() => withActivity(`chat task ${activity}`, task)).catch((error) => {
      logger.warn(`server-events: ${activity} failed:`, errorMessage(error));
      if (!hasChatTaskError) {
        hasChatTaskError = true;
        firstChatTaskError = error;
      }
    });
    chatTaskTails.set(chatId, current);
    activeChatTasks.add(current);
    void current.then(() => {
      activeChatTasks.delete(current);
      if (chatTaskTails.get(chatId) === current) chatTaskTails.delete(chatId);
    });
    return current;
  }

  async function waitForIdle(): Promise<void> {
    while (activeChatTasks.size > 0) {
      await Promise.all([...activeChatTasks]);
    }
    if (hasChatTaskError) {
      const error = firstChatTaskError;
      firstChatTaskError = undefined;
      hasChatTaskError = false;
      throw error;
    }
  }

  function notifyAgentHandoff(chatId: string): void {
    scheduleChatTask(chatId, 'agent handoff invalidation', () => {
      const entry = chatRegistry.getChat(chatId);
      if (!entry) return;
      markSearchCatalogDirty(chatId);
      broadcast(new ChatListRefreshRequestedMessage('agent-handoff', chatId));
    });
  }

  function notifyTranscriptCompositionChanged(chatId: string): void {
    if (!chatExists(chatId)) return;
    markSearchCatalogDirty(chatId);
  }

  function notifyChatSettingsUpdated(chatId: string): void {
    scheduleChatTask(chatId, 'chat settings invalidation', () => {
      if (!chatExists(chatId)) return;
      markSearchCatalogDirty(chatId);
      broadcast(new ChatListRefreshRequestedMessage('execution-settings-updated', chatId));
    });
  }

  // Notices are process-only feed overlays; they never enter the transcript
  // sequence space and are not replayed to late subscribers.
  function notifyOperationalNotice(
    chatId: string,
    noticeType: ChatOperationalNoticeMessage['noticeType'],
    content: string,
    detail?: ChatOperationalNoticeMessage['detail'],
  ): void {
    if (!chatExists(chatId)) return;
    broadcast(new ChatOperationalNoticeMessage(
      chatId,
      noticeType,
      content,
      new Date().toISOString(),
      detail,
    ));
  }

  // Body-free per-chat invalidation; a lost event is recoverable through a
  // reconnect refresh of the already-loaded selection.
  function notifyChatPreamblesInvalidated(chatId: string, revision: number): void {
    if (!chatExists(chatId)) return;
    scheduleChatTask(chatId, 'chat preambles invalidation', () => {
      if (!chatExists(chatId)) return;
      broadcast(new ChatPreamblesInvalidatedMessage(chatId, revision));
    });
  }

  scheduledPrompts.onInvalidated((reason) => {
    broadcast(new ScheduledPromptsInvalidatedMessage(reason));
  });

  function deleteSearchChat(chatId: string): void {
    if (!searchIndex) return;
    try {
      searchIndex.deleteChat(chatId);
    } catch (err) {
      logger.warn(`search-index: delete failed for ${chatId}:`, errorMessage(err));
    }
  }

  function markSearchCatalogDirty(chatId: string): void {
    if (!searchIndex) return;
    try {
      searchIndex.catalogMayHaveChanged(chatId);
    } catch (err) {
      logger.warn('search-index: catalog refresh failed:', errorMessage(err));
    }
  }

  snippets.onInvalidated((reason) => {
    broadcast(new SnippetsInvalidatedMessage(reason));
  });

  preambles.onInvalidated((reason) => {
    broadcast(new PreamblesInvalidatedMessage(reason));
  });

  function markTurnFailure(
    chatId: string,
    turnMetadata?: TurnEventMetadata,
  ): boolean {
    const identity = turnMetadata?.turnId ?? turnMetadata?.clientRequestId;
    if (!identity) return true;
    const now = Date.now();
    for (const [key, markedAt] of recentTurnFailures) {
      if (markedAt < now - turnFailureDedupeMs) recentTurnFailures.delete(key);
    }
    const key = `${chatId}:${identity}`;
    if (recentTurnFailures.has(key)) return false;
    recentTurnFailures.set(key, now);
    return true;
  }

  function broadcastAgentFailure(
    chatId: string,
    message: string,
    turnMetadata?: TurnEventMetadata,
  ): void {
    broadcast(
      new AgentRunFailedMessage(
        chatId,
        message,
        turnMetadata?.turnId,
        turnMetadata?.clientRequestId,
        turnMetadata?.upstreamRequestId,
      ),
    );
  }

  async function settleExecutionCommand(
    chatId: string,
    turnMetadata: TurnEventMetadata | undefined,
    status: 'finished' | 'failed',
    error?: string,
    errorCode?: string,
  ): Promise<void> {
    if (!turnMetadata?.commandType || !turnMetadata.clientRequestId) return;
    await commandLedger.settleTerminal(
      commandLedgerKey(turnMetadata.commandType, chatId, turnMetadata.clientRequestId),
      status,
      error
        ? { error, errorCode: isErrorCode(errorCode) ? errorCode : 'INTERNAL_ERROR' }
        : {},
    );
  }

  async function markPublicTurnTerminal(
    chatId: string,
    turnMetadata?: TurnEventMetadata,
    interruptionReason?: 'user-stop' | 'chat-deleted',
  ): Promise<void> {
    if (!turnMetadata?.turnId) return;
    await commandLedger.markPublicTerminal(chatId, turnMetadata.turnId, interruptionReason);
  }

  // A provider failure is a terminal outcome, not a transcript invalidation.
  // The ledger already holds every committed row, so the view is left intact
  // and only command and lifecycle state settle.
  async function handleAgentFailure(
    chatId: string,
    agentErrorMessage: string,
    agentErrorCode: string,
    turnMetadata?: TurnEventMetadata,
  ): Promise<void> {
    if (!markTurnFailure(chatId, turnMetadata)) return;
    await settleExecutionCommand(
      chatId,
      turnMetadata,
      'failed',
      agentErrorMessage,
      agentErrorCode,
    );
    broadcastAgentFailure(chatId, agentErrorMessage, turnMetadata);
    await markPublicTurnTerminal(chatId, turnMetadata);
  }

  async function handleQueueFailure(
    chatId: string,
    queueErrorMessage: string,
    options: TurnEventMetadata,
  ): Promise<void> {
    broadcast(new ChatProcessingUpdatedMessage(chatId, processing.phase(chatId)));
    if (!markTurnFailure(chatId, options)) return;
    await settleExecutionCommand(chatId, options, 'failed', queueErrorMessage);
    broadcastAgentFailure(chatId, queueErrorMessage, options);
    await markPublicTurnTerminal(chatId, options);
  }

  const chatExists = (chatId: string) => chatRegistry.hasChat(chatId);

  const transcriptFanout = createTranscriptEventFanout({
    chatExists,
    schedule: (chatId, task) => {
      void scheduleChatTask(chatId, 'transcript commit fanout', task);
    },
    broadcast,
    updateMetadata: (chatId, messages) => {
      metadata.updateFromAppendedMessages(chatId, [...messages]);
    },
    replaceMetadata: async (chatId) => {
      await metadata.replaceFromTranscriptView(chatId, currentTranscriptMessagePages(chatId));
    },
    resendCandidates: (chatId) => processing.phase(chatId) === null
      ? agentRegistry.resendCandidates(chatId)
      : [],
  });
  const publishTransientFeedMutation = (applied: AppliedTransientFeedEvent) => {
    if (applied.kind === 'unchanged') return;
    const mutation = applied.value;
    void scheduleChatTask(mutation.chatId, 'transient feed mutation', () => {
      broadcast(new ChatTransientFeedMutationMessage(
        mutation.serverInstanceId,
        mutation.chatId,
        mutation.transcriptViewId,
        mutation.transientRevision,
        mutation.mutation,
      ));
    });
  };
  agentRegistry.onPermissionRetired(control => {
    publishTransientFeedMutation(transientFeeds.retirePermission(control));
  });
  agentRegistry.onTranscriptCommitted(async (event) => {
    transcriptFanout(event);
    // A committed Preambles-updated notice invalidates the per-chat selection
    // cache. Scheduling here, immediately after the fanout has enqueued the
    // notice's chat-messages task on the per-chat queue, fixes the broadcast
    // order deterministically: messages first, invalidation second.
    if (event.type === 'rows') {
      for (const row of event.rows) {
        if (
          row.kind === 'notice'
          && isLedgerPreambleSelectionChangedNoticeDetail(row.detail)
          && row.detail.selectionRevision >= 0
        ) {
          const revision = row.detail.selectionRevision;
          scheduleChatTask(event.chatId, 'chat preambles invalidation', () => {
            if (!chatExists(event.chatId)) return;
            broadcast(new ChatPreamblesInvalidatedMessage(event.chatId, revision));
          });
        }
      }
    }
    publishTransientFeedMutation(transientFeeds.apply(event));
    if (event.type !== 'run-ended') return;
    await commandLedger.setTurnResult(event.chatId, event.runId, event.finalResponse);
  });
  const publishProcessing = (chatId: string) => {
    if (!chatExists(chatId)) return;
    // Captures the phase before scheduling so rapid stop and terminal transitions
    // preserve the intermediate stopping state.
    const phase = processing.phase(chatId);
    scheduleChatTask(chatId, 'processing broadcast', () => {
      if (!chatExists(chatId)) return;
      broadcast(new ChatProcessingUpdatedMessage(chatId, phase));
    });
  };
  queue.onProcessingInvalidated((chatId) => {
    if (inlineTerminalReleases.has(chatId)) return;
    publishProcessing(chatId);
  });
  const broadcastSessionStopped = (
    chatId: string,
    outcome: ChatStopOutcome,
    intent: ChatStopIntent,
    interruptedTurn?: { readonly turnId?: string },
  ) => {
    scheduleChatTask(chatId, 'session-stopped broadcast', async () => {
      if (outcome === 'interrupt-requested' && interruptedTurn?.turnId) {
        await commandLedger.markInterruptedWithoutRunTerminal(chatId, interruptedTurn.turnId,
          intent === 'chat-deletion' ? 'chat-deleted' : 'user-stop');
      }
      if (!chatExists(chatId)) return;
      broadcast(new ChatSessionStoppedMessage(chatId, outcome, intent));
    });
  };
  const releaseTerminalOwnership = async (
    chatId: string,
    turnMetadata: TurnEventMetadata | undefined,
    outcome: 'finished' | 'failed',
  ): Promise<void> => {
    inlineTerminalReleases.add(chatId);
    try {
      await queue.onAgentTurnTerminal(chatId, turnMetadata, outcome);
    } finally {
      inlineTerminalReleases.delete(chatId);
    }
    if (chatExists(chatId)) {
      broadcast(new ChatProcessingUpdatedMessage(chatId, processing.phase(chatId)));
    }
  };
  agentRegistry.onRunSteerable((chatId) => { queue.retryQueuedSteers(chatId); });
  agentRegistry.onSessionCreated((chatId) => {
    if (!chatExists(chatId)) return;
    return scheduleChatTask(chatId, 'session publication', () => {
      markSearchCatalogDirty(chatId);
      broadcast(new ChatSessionCreatedMessage(chatId));
    });
  });
  agentRegistry.onFinished((chatId, exitCode, turnMetadata, outcome) => {
    if (!chatExists(chatId)) return;
    const queuedFinalization = queue.getQueuedTurnFinalization(chatId, turnMetadata?.turnId);
    return scheduleChatTask(chatId, 'turn completion', async () => {
      let released = false;
      try {
        if (!chatExists(chatId)) return;
        if (queuedFinalization && await queuedFinalization !== 'committed') return;
        await releaseTerminalOwnership(chatId, turnMetadata, 'finished');
        released = true;
        await settleExecutionCommand(chatId, turnMetadata, 'finished');
        if (!chatExists(chatId)) return;
        broadcast(
          new AgentRunFinishedMessage(
            chatId,
            exitCode,
            turnMetadata?.turnId,
            turnMetadata?.clientRequestId,
            turnMetadata?.upstreamRequestId,
            outcome,
          ),
        );
        await markPublicTurnTerminal(
          chatId,
          turnMetadata,
          outcome === 'interrupted' ? 'user-stop' : undefined,
        );
      } finally {
        if (!released) await releaseTerminalOwnership(chatId, turnMetadata, 'finished');
        void queue.checkChatIdle(chatId).catch((err) => {
          logger.warn('queue: checkChatIdle error:', errorMessage(err));
        });
      }
    });
  });
  agentRegistry.onFailed(async (chatId, agentErrorMessage, agentErrorCode, turnMetadata) => {
    if (!chatExists(chatId)) return;
    const queuedFinalization = queue.getQueuedTurnFinalization(chatId, turnMetadata?.turnId);
    return scheduleChatTask(chatId, 'turn failure handling', async () => {
      let released = false;
      try {
        if (!chatExists(chatId)) return;
        if (queuedFinalization && await queuedFinalization !== 'committed') return;
        await releaseTerminalOwnership(chatId, turnMetadata, 'failed');
        released = true;
        await handleAgentFailure(chatId, agentErrorMessage, agentErrorCode, turnMetadata);
      } finally {
        if (!released) await releaseTerminalOwnership(chatId, turnMetadata, 'failed');
        void queue.checkChatIdle(chatId).catch((err) => {
          logger.warn('queue: checkChatIdle error:', errorMessage(err));
        });
      }
    });
  });

  settings.onSessionNameChanged((chatId, title) => {
    broadcast(new ChatTitleUpdatedMessage(chatId, title));
  });
  settings.onListChanged((reason, chatId) => {
    if (!isChatListInvalidationReason(reason)) {
      logger.warn(
        'server: skipped unknown chat list invalidation reason:',
        reason,
      );
      return;
    }
    broadcast(new ChatListRefreshRequestedMessage(reason, chatId));
  });
  const broadcastRemoteSettings = async () => {
    try {
      const snapshot = await buildRemoteSettingsSnapshot({
        projectBasePath,
        settings,
        agents: agentRegistry,
        telegramSettings,
      });
      broadcast(new SettingsChangedMessage(snapshot));
    } catch (err) {
      logger.warn(
        'server: failed to broadcast settings-changed:',
        errorMessage(err),
      );
    }
  };
  settings.onRemoteSettingsChanged(broadcastRemoteSettings);
  telegramSettings.onChanged(() => {
    telegramNotifier.setBotToken(telegramSettings.getBotToken());
    void broadcastRemoteSettings();
  });
  chatRegistry.onChatAdded((chatId) => {
    markSearchCatalogDirty(chatId);
    // A first-turn chat reserves execution before its registry entry exists,
    // so the reservation's processing invalidation was dropped by the
    // existence guard. Republish at the moment the chat becomes broadcastable.
    if (processing.phase(chatId) !== null) publishProcessing(chatId);
  });
  chatRegistry.onChatRemoved((chatId, removalReason) => {
    agentRegistry.discardTurn(chatId);
    transientFeeds.deleteChat(chatId);
    deleteSearchChat(chatId);
    scheduleChatTask(chatId, 'chat removal settlement', async () => {
      broadcast(new ChatSessionDeletedWsMessage(chatId));
      if (removalReason === 'user-deletion') {
        await commandLedger.markChatInterrupted(chatId, 'chat-deleted');
      }
    });
    shareStore.revokeShareByChatId(chatId).catch((err) => {
      logger.warn(
        'share-store: failed to revoke share on chat removal:',
        errorMessage(err),
      );
    });
  });
  chatRegistry.onChatReadUpdated((chatId, lastReadAt) => {
    if (typeof lastReadAt !== 'string') return;
    broadcast(new ChatReadUpdatedV1Message(chatId, lastReadAt));
  });
  chatRegistry.onChatProjectPathUpdated((payload) => {
    markSearchCatalogDirty(payload.chatId);
    broadcast(
      new ChatProjectPathUpdatedMessage(
        payload.chatId,
        payload.projectPath,
        payload.effectiveProjectKey,
        payload.previousProjectPath,
      ),
    );
  });
  chatRegistry.onChatTagsUpdated((chatId) => {
    scheduleChatTask(chatId, 'chat tag invalidation', () => {
      if (!chatExists(chatId)) return;
      broadcast(new ChatListRefreshRequestedMessage('tags-updated', chatId));
    });
  });

  queue.onExecutionControlUpdated((chatId, controlState) => {
    broadcast(
      new ChatExecutionControlUpdatedMessage(
        chatId,
        toClientChatExecutionControlState(controlState),
      ),
    );
  });
  queue.onSessionStopped((chatId, outcome, intent, interruptedTurn) => {
    logger.info('queue: Stop resolved', {
      chatId,
      intent,
      outcome,
      phase: processing.phase(chatId),
    });
    if (outcome === 'already-idle') {
      publishProcessing(chatId);
      broadcastSessionStopped(chatId, outcome, intent);
      return;
    }
    broadcastSessionStopped(chatId, outcome, intent, interruptedTurn);
    publishProcessing(chatId);
  });
  queue.onTurnFailed((chatId, queueErrorMessage, options = {}) => {
    scheduleChatTask(chatId, 'queued turn failure handling', () =>
      handleQueueFailure(chatId, queueErrorMessage, options));
  });
  queue.onProjectUnavailable((chatId, error) => {
    scheduleChatTask(chatId, 'project unavailable notice', () => {
      notifyOperationalNotice(chatId, 'warning', error.message, {
        type: 'project-unavailable',
        projectPath: error.projectPath,
        reason: error.reason,
      });
    });
  });
  queue.onTurnSettled((chatId, turn) => {
    if (turn) agentRegistry.settleTurn(chatId, turn);
  });
  executors.onChanged(() => broadcast(new ExecutorsChangedMessage(executors.list())));
  // Running turns on an executor show whether its link is reconnecting.
  const publishExecutorProcessing = (executorId: string) => {
    for (const { chatId } of processing.snapshot()) {
      if (effectiveExecutorId(chatRegistry.getChat(chatId)?.executorId) === executorId) publishProcessing(chatId);
    }
  };
  wireExecutorAvailability({
    executors, agentRegistry, chatRegistry, ownershipJournal, queue,
    publishProcessing: publishExecutorProcessing,
  });

  return {
    notifyAgentHandoff,
    notifyChatSettingsUpdated,
    notifyTranscriptCompositionChanged,
    notifyOperationalNotice,
    notifyChatPreamblesInvalidated,
    broadcastTranscriptSearchStatus(status: TranscriptSearchStatusV1): void {
      broadcast(new TranscriptSearchStatusMessage(status));
    },
    broadcastTicketsInvalidated(revision: number): void {
      broadcast(new TicketsInvalidatedMessage(revision));
    },
    broadcastApiProvidersInvalidated(): void {
      broadcast(new ApiProvidersInvalidatedMessage());
    },
    waitForIdle,
  };
}
