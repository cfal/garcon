import type { ChatMessage, ChatStopIntent, ChatStopOutcome } from '../common/chat-types.js';
import { isChatListInvalidationReason } from '../common/ws-events.ts';
import { toClientChatExecutionControlState } from './chat-execution/control-state.ts';
import { createTranscriptEventFanout } from './ledger/event-fanout.js';
import type { TranscriptViewId } from './ledger/contracts.js';
import type { TurnEventMetadata } from './agents/event-bus.js';
import type { AgentRegistry } from './agents/registry.js';
import type { ChatRegistry } from './chats/store.js';
import type { ChatTransientFeedStore } from './chats/chat-transient-feed.js';
import type { MetadataIndex } from './chats/metadata-store.js';
import type { ShareStore } from './chats/share-store.js';
import type { SettingsStore } from './settings/store.js';
import type { ChatExecutionCoordinator } from './chat-execution/chat-execution-coordinator.js';
import type { ChatProcessingActivity } from './chats/chat-processing-activity.js';
import { commandLedgerKey, type CommandLedger } from './commands/command-ledger.js';
import type { TelegramNotifier } from './notifications/telegram.js';
import type { TelegramSettingsStore } from './notifications/telegram-settings-store.js';
import type { ScheduledPromptScheduler } from './scheduled-prompts/scheduler.js';
import type { SnippetService } from './snippets/service.js';
import { createLogger } from './lib/log.js';
import { errorMessage } from './lib/errors.js';
import { buildRemoteSettingsSnapshot } from './routes/workspace.js';
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
  ScheduledPromptsInvalidatedMessage,
  SnippetsInvalidatedMessage,
} from '../common/ws-events.ts';

const logger = createLogger('server-events');

interface WebSocketPublisher {
  publish(topic: string, payload: string): unknown;
}

interface ChatSearchEventIndex {
  catalogMayHaveChanged(chatId: string): void;
  deleteChat(chatId: string): void;
}

export interface ServerEventWiringDeps {
  server: WebSocketPublisher;
  agentRegistry: AgentRegistry;
  chatRegistry: ChatRegistry;
  settings: SettingsStore;
  queue: ChatExecutionCoordinator;
  processing: ChatProcessingActivity;
  metadata: MetadataIndex;
  currentTranscriptMessages(chatId: string): readonly ChatMessage[];
  assistantMessagesForSubmission(
    chatId: string,
    viewId: TranscriptViewId,
    clientMessageId: string,
    throughOrdinal: number,
  ): readonly string[];
  transientFeeds: ChatTransientFeedStore;
  commandLedger: CommandLedger;
  shareStore: ShareStore;
  telegramNotifier: TelegramNotifier;
  telegramSettings: TelegramSettingsStore;
  scheduledPrompts: ScheduledPromptScheduler;
  snippets: SnippetService;
  searchIndex?: ChatSearchEventIndex;
}

export interface ServerEventWiring {
  notifyAgentHandoff(chatId: string): void;
  notifyTranscriptCompositionChanged(chatId: string): void;
  notifyOperationalNotice(
    chatId: string,
    noticeType: ChatOperationalNoticeMessage['noticeType'],
    content: string,
  ): void;
  waitForIdle(): Promise<void>;
}

export function wireServerEvents({
  server,
  agentRegistry,
  chatRegistry,
  settings,
  queue,
  processing,
  metadata,
  currentTranscriptMessages,
  assistantMessagesForSubmission,
  transientFeeds,
  commandLedger,
  shareStore,
  telegramNotifier,
  telegramSettings,
  scheduledPrompts,
  snippets,
  searchIndex,
}: ServerEventWiringDeps): ServerEventWiring {
  const broadcast = (payload: unknown) =>
    server.publish('chat', JSON.stringify(payload));
  const recentProcessFailures = new Map<string, number>();
  const inlineTerminalReleases = new Set<string>();
  const chatTaskTails = new Map<string, Promise<void>>();
  const activeChatTasks = new Set<Promise<void>>();
  let firstChatTaskError: unknown;
  let hasChatTaskError = false;
  const processFailureDedupeMs = 30_000;

  // Serializes per-chat view work and lifecycle broadcasts so turn messages precede
  // terminal-driven processing, stop, and run-terminal events. Synchronous lifecycle
  // broadcasts would reintroduce the spinner-before-message race.
  function scheduleChatTask(
    chatId: string,
    label: string,
    task: () => Promise<void> | void,
  ): Promise<void> {
    const previous = chatTaskTails.get(chatId) ?? Promise.resolve();
    const current = previous.then(task).catch((error) => {
      logger.warn(`${label}:`, errorMessage(error));
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
    scheduleChatTask(chatId, 'server-events: agent handoff invalidation failed', () => {
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

  // Notices are process-only feed overlays; they never enter the transcript
  // sequence space and are not replayed to late subscribers.
  function notifyOperationalNotice(
    chatId: string,
    noticeType: ChatOperationalNoticeMessage['noticeType'],
    content: string,
  ): void {
    if (!chatExists(chatId)) return;
    broadcast(new ChatOperationalNoticeMessage(
      chatId,
      noticeType,
      content,
      new Date().toISOString(),
    ));
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

  function turnFailureKey(
    chatId: string,
    turnMetadata?: TurnEventMetadata,
  ): string {
    return `${chatId}:${turnMetadata?.turnId ?? turnMetadata?.clientRequestId ?? 'chat'}`;
  }

  function pruneRecentProcessFailures(): void {
    const cutoff = Date.now() - processFailureDedupeMs;
    for (const [key, markedAt] of recentProcessFailures) {
      if (markedAt < cutoff) recentProcessFailures.delete(key);
    }
  }

  function markProcessFailure(
    chatId: string,
    turnMetadata?: TurnEventMetadata,
  ): void {
    pruneRecentProcessFailures();
    recentProcessFailures.set(turnFailureKey(chatId, turnMetadata), Date.now());
  }

  function consumeProcessFailure(
    chatId: string,
    turnMetadata?: TurnEventMetadata,
  ): boolean {
    pruneRecentProcessFailures();
    const key = turnFailureKey(chatId, turnMetadata);
    const wasProcessFailure = recentProcessFailures.has(key);
    if (wasProcessFailure) recentProcessFailures.delete(key);
    return wasProcessFailure;
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
  ): Promise<void> {
    if (!turnMetadata?.commandType || !turnMetadata.clientRequestId) return;
    await commandLedger.settleTerminal(
      commandLedgerKey(turnMetadata.commandType, chatId, turnMetadata.clientRequestId),
      status,
      error ? { error } : {},
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
    turnMetadata?: TurnEventMetadata,
  ): Promise<void> {
    markProcessFailure(chatId, turnMetadata);
    await settleExecutionCommand(chatId, turnMetadata, 'failed', agentErrorMessage);
    broadcastAgentFailure(chatId, agentErrorMessage, turnMetadata);
    await markPublicTurnTerminal(chatId, turnMetadata);
  }

  async function handleQueueFailure(
    chatId: string,
    queueErrorMessage: string,
    options: TurnEventMetadata,
  ): Promise<void> {
    broadcast(new ChatProcessingUpdatedMessage(chatId, processing.phase(chatId)));
    if (consumeProcessFailure(chatId, options)) return;
    await settleExecutionCommand(chatId, options, 'failed', queueErrorMessage);
    broadcastAgentFailure(chatId, queueErrorMessage, options);
    await markPublicTurnTerminal(chatId, options);
  }

  const chatExists = (chatId: string) => Boolean(chatRegistry.getChat(chatId));

  const transcriptFanout = createTranscriptEventFanout({
    chatExists,
    schedule: (chatId, task) => {
      void scheduleChatTask(chatId, 'server-events: transcript commit fanout failed', task);
    },
    broadcast,
    updateMetadata: (chatId, messages) => {
      metadata.updateFromAppendedMessages(chatId, [...messages]);
    },
    replaceMetadata: (chatId) => {
      metadata.replaceFromTranscriptView(chatId, currentTranscriptMessages(chatId));
    },
    resendCandidates: (chatId) => processing.phase(chatId) === null
      ? agentRegistry.resendCandidates(chatId)
      : [],
  });
  agentRegistry.onTranscriptCommitted(async (event) => {
    transcriptFanout(event);
    const applied = transientFeeds.apply(event);
    if (applied.kind !== 'unchanged') {
      const mutation = applied.value;
      void scheduleChatTask(event.chatId, 'server-events: transient feed mutation failed', () => {
        broadcast(new ChatTransientFeedMutationMessage(
          mutation.serverInstanceId,
          mutation.chatId,
          mutation.transcriptViewId,
          mutation.transientRevision,
          mutation.mutation,
        ));
      });
    }
    if (event.type !== 'run-ended') return;
    const record = await commandLedger.getTurnRecord(event.chatId, event.runId);
    const clientMessageId = record?.payload.clientMessageId;
    if (typeof clientMessageId !== 'string') return;
    await commandLedger.appendAssistantMessages(
      event.chatId,
      event.runId,
      assistantMessagesForSubmission(
        event.chatId,
        event.viewId,
        clientMessageId,
        event.row.ordinal,
      ),
    );
  });
  const publishProcessing = (chatId: string) => {
    if (!chatExists(chatId)) return;
    // Captures the phase before scheduling so rapid stop and terminal transitions
    // preserve the intermediate stopping state.
    const phase = processing.phase(chatId);
    scheduleChatTask(chatId, 'server-events: processing broadcast failed', () => {
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
  ) => {
    scheduleChatTask(chatId, 'server-events: session-stopped broadcast failed', () => {
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
  agentRegistry.onSessionCreated((chatId) => {
    if (!chatExists(chatId)) return;
    return scheduleChatTask(chatId, 'server-events: session publication failed', () => {
      markSearchCatalogDirty(chatId);
      broadcast(new ChatSessionCreatedMessage(chatId));
    });
  });
  agentRegistry.onFinished((chatId, exitCode, turnMetadata, outcome) => {
    if (!chatExists(chatId)) return;
    const queuedFinalization = queue.getQueuedTurnFinalization(chatId, turnMetadata?.turnId);
    return scheduleChatTask(chatId, 'server-events: turn completion failed', async () => {
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
  agentRegistry.onFailed(async (chatId, agentErrorMessage, turnMetadata) => {
    if (!chatExists(chatId)) return;
    const queuedFinalization = queue.getQueuedTurnFinalization(chatId, turnMetadata?.turnId);
    return scheduleChatTask(chatId, 'server-events: turn failure handling failed', async () => {
      let released = false;
      try {
        if (!chatExists(chatId)) return;
        if (queuedFinalization && await queuedFinalization !== 'committed') return;
        await releaseTerminalOwnership(chatId, turnMetadata, 'failed');
        released = true;
        await handleAgentFailure(chatId, agentErrorMessage, turnMetadata);
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
    scheduleChatTask(chatId, 'server-events: chat removal settlement failed', async () => {
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
        payload.previousEffectiveProjectKey,
      ),
    );
  });
  chatRegistry.onChatTagsUpdated((chatId) => {
    scheduleChatTask(chatId, 'server-events: chat tag invalidation failed', () => {
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
  queue.onSessionStopped((chatId, outcome, intent) => {
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
    broadcastSessionStopped(chatId, outcome, intent);
    publishProcessing(chatId);
  });
  queue.onTurnFailed((chatId, queueErrorMessage, options = {}) => {
    scheduleChatTask(chatId, 'server-events: queued turn failure handling failed', () =>
      handleQueueFailure(chatId, queueErrorMessage, options));
  });
  queue.onTurnSettled((chatId, turn) => {
    if (turn) agentRegistry.settleTurn(chatId, turn);
  });

  return {
    notifyAgentHandoff,
    notifyTranscriptCompositionChanged,
    notifyOperationalNotice,
    waitForIdle,
  };
}
