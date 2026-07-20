import { parseChatMessages, type ChatMessage } from '../common/chat-types.js';
import { isChatListInvalidationReason } from '../common/ws-events.ts';
import { toClientChatExecutionControlState } from './chat-execution/control-state.ts';
import type { TurnEventMetadata } from './agents/event-bus.js';
import type { AgentRegistry } from './agents/registry.js';
import type { ChatRegistry } from './chats/store.js';
import type { MetadataIndex } from './chats/metadata-store.js';
import type { ChatViewStore } from './chats/chat-view-store.js';
import type { ChatNativeReloader } from './chats/chat-native-reload.js';
import type { PendingUserInputService } from './chats/pending-user-input-service.js';
import type { ShareStore } from './chats/share-store.js';
import type { SettingsStore } from './settings/store.js';
import type { ChatExecutionCoordinator } from './chat-execution/chat-execution-coordinator.js';
import { commandLedgerKey, type CommandLedger } from './commands/command-ledger.js';
import type { TelegramNotifier } from './notifications/telegram.js';
import type { TelegramSettingsStore } from './notifications/telegram-settings-store.js';
import type { ScheduledPromptScheduler } from './scheduled-prompts/scheduler.js';
import type { SnippetService } from './snippets/service.js';
import { createLogger } from './lib/log.js';
import { errorMessage } from './lib/errors.js';
import { buildRemoteSettingsSnapshot } from './routes/workspace.js';
import { ChatProcessErrorRecovery } from './chats/chat-process-error-recovery.js';
import { UserAbortLifecycleCoordinator } from './chats/user-abort-lifecycle-coordinator.js';
import type { PendingUserInputRecoveryCoordinator } from './chats/pending-user-input-recovery.js';
import {
  AgentRunFinishedMessage,
  AgentRunFailedMessage,
  ChatMessagesMessage,
  ChatGenerationResetMessage,
  ChatSessionCreatedMessage,
  ChatProjectPathUpdatedMessage,
  ChatProcessingUpdatedMessage,
  ChatTitleUpdatedMessage,
  ChatSessionDeletedWsMessage,
  ChatReadUpdatedV1Message,
  ChatListRefreshRequestedMessage,
  ChatSessionStoppedMessage,
  ChatExecutionControlUpdatedMessage,
  QueueDispatchingMessage,
  PendingUserInputUpdatedMessage,
  PendingUserInputStatusUpdatedMessage,
  PendingUserInputClearedMessage,
  SettingsChangedMessage,
  ScheduledPromptsInvalidatedMessage,
  SnippetsInvalidatedMessage,
} from '../common/ws-events.ts';

const logger = createLogger('server-events');
interface WebSocketPublisher {
  publish(topic: string, payload: string): unknown;
}

interface ChatSearchEventIndex {
  sourceMayHaveChanged(chatId: string): void;
  catalogMayHaveChanged(chatId?: string): void;
  deleteChat(chatId: string): void;
}

type NativeReloaderDep = Pick<ChatNativeReloader, 'reloadFromNative'>;

export interface ServerEventWiringDeps {
  server: WebSocketPublisher;
  agentRegistry: AgentRegistry;
  chatRegistry: ChatRegistry;
  settings: SettingsStore;
  queue: ChatExecutionCoordinator;
  metadata: MetadataIndex;
  chatViews: ChatViewStore;
  chatNativeReloader: NativeReloaderDep;
  pendingInputs: PendingUserInputService;
  pendingRecovery: Pick<PendingUserInputRecoveryCoordinator, 'waitForSettlements'>;
  commandLedger: CommandLedger;
  shareStore: ShareStore;
  telegramNotifier: TelegramNotifier;
  telegramSettings: TelegramSettingsStore;
  scheduledPrompts: ScheduledPromptScheduler;
  snippets: SnippetService;
  loadNativeMessages(chatId: string): Promise<ChatMessage[]>;
  searchIndex?: ChatSearchEventIndex;
}

export interface ServerEventWiring {
  waitForIdle(): Promise<void>;
}

export function wireServerEvents({
  server,
  agentRegistry,
  chatRegistry,
  settings,
  queue,
  metadata,
  chatViews,
  chatNativeReloader,
  pendingInputs,
  pendingRecovery,
  commandLedger,
  shareStore,
  telegramNotifier,
  telegramSettings,
  scheduledPrompts,
  snippets,
  loadNativeMessages,
  searchIndex,
}: ServerEventWiringDeps): ServerEventWiring {
  const broadcast = (payload: unknown) =>
    server.publish('chat', JSON.stringify(payload));
  const recentProcessFailures = new Map<string, number>();
  const chatTaskTails = new Map<string, Promise<void>>();
  const activeChatTasks = new Set<Promise<void>>();
  let firstChatTaskError: unknown;
  let hasChatTaskError = false;
  type DeferredTerminalFailure =
    | {
        source: 'agent';
        chatId: string;
        message: string;
        turnMetadata?: TurnEventMetadata;
      }
    | {
        source: 'queue';
        chatId: string;
        message: string;
        turnMetadata: TurnEventMetadata;
      };
  const deferredTerminalFailures = new Map<string, DeferredTerminalFailure>();
  const processFailureDedupeMs = 30_000;
  const processErrorRecovery = new ChatProcessErrorRecovery(
    chatViews,
    chatNativeReloader,
    pendingInputs,
  );
  const userAbortLifecycle = new UserAbortLifecycleCoordinator(pendingInputs, {
    onSettlementError: (err) => {
      logger.warn('pending-inputs: reconcile after stop failed:', errorMessage(err));
    },
  });

  function scheduleChatTask(
    chatId: string,
    label: string,
    task: () => Promise<void> | void,
  ): void {
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

  function markSearchChatDirty(chatId: string): void {
    if (!searchIndex) return;
    try {
      searchIndex.sourceMayHaveChanged(chatId);
    } catch (err) {
      logger.warn(`search-index: mark dirty failed for ${chatId}:`, errorMessage(err));
    }
  }

  function markSearchCatalogDirty(chatId?: string): void {
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

  function deferTerminalFailure(failure: DeferredTerminalFailure): void {
    const key = turnFailureKey(failure.chatId, failure.turnMetadata);
    const existing = deferredTerminalFailures.get(key);
    // Preserves the first provider failure and lets it supersede a queue wrapper.
    if (existing?.source === 'agent' || (existing && failure.source === 'queue')) return;
    deferredTerminalFailures.set(key, failure);
  }

  function takeDeferredTerminalFailure(
    chatId: string,
    turnMetadata?: TurnEventMetadata,
  ): DeferredTerminalFailure | undefined {
    const key = turnFailureKey(chatId, turnMetadata);
    const failure = deferredTerminalFailures.get(key);
    deferredTerminalFailures.delete(key);
    return failure;
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

  function reconcilePendingAfterTerminal(chatId: string, context: string): void {
    pendingInputs.reconcileNativeHistory(chatId).catch((err) => {
      logger.warn(`pending-inputs: reconcile after ${context} failed:`, errorMessage(err));
    });
  }

  async function reloadAfterProcessError(
    chatId: string,
    message: string,
    turnMetadata?: TurnEventMetadata,
  ): Promise<void> {
    markProcessFailure(chatId, turnMetadata);
    const recovery = await processErrorRecovery.recover(chatId, message);
    if (recovery.settlementError !== undefined) {
      logger.warn(
        'pending-inputs: process-error settlement failed:',
        errorMessage(recovery.settlementError),
      );
    }
    if (recovery.kind === 'generation-reset') {
      broadcast(
        new ChatGenerationResetMessage(
          chatId,
          recovery.reload.generationId,
          'process-error',
          recovery.reload.lastSeq,
        ),
      );
    } else if (recovery.kind === 'fallback-appended') {
      logger.warn(
        'chat-view: process-error reload failed:',
        errorMessage(recovery.reloadError),
      );
      if (recovery.appended.messages.length > 0) {
        markSearchChatDirty(chatId);
        broadcast(
          new ChatMessagesMessage(
            chatId,
            recovery.appended.generationId,
            recovery.appended.messages,
            turnMetadata?.turnId,
            turnMetadata?.clientRequestId,
            turnMetadata?.upstreamRequestId,
          ),
        );
      }
    } else {
      logger.warn(
        'chat-view: process-error reload and fallback failed:',
        errorMessage(recovery.reloadError),
        errorMessage(recovery.fallbackError),
      );
    }
  }

  async function handleAgentFailure(
    chatId: string,
    agentErrorMessage: string,
    turnMetadata?: TurnEventMetadata,
  ): Promise<void> {
    await settleExecutionCommand(chatId, turnMetadata, 'failed', agentErrorMessage);
    await reloadAfterProcessError(chatId, agentErrorMessage, turnMetadata);
    await pendingRecovery.waitForSettlements(chatId);
    broadcastAgentFailure(chatId, agentErrorMessage, turnMetadata);
  }

  async function handleQueueFailure(
    chatId: string,
    queueErrorMessage: string,
    options: TurnEventMetadata,
  ): Promise<void> {
    if (consumeProcessFailure(chatId, options)) return;
    await settleExecutionCommand(chatId, options, 'failed', queueErrorMessage);
    if (options.clientRequestId) {
      pendingInputs.markFailed(chatId, options.clientRequestId);
    }
    await pendingInputs.reconcileNativeHistory(chatId);
    await pendingRecovery.waitForSettlements(chatId);
    broadcastAgentFailure(chatId, queueErrorMessage, options);
  }

  function releaseDeferredTerminalFailure(
    failure: DeferredTerminalFailure,
  ): void {
    if (failure.source === 'agent') {
      scheduleChatTask(failure.chatId, 'server-events: deferred agent failure failed', () =>
        handleAgentFailure(failure.chatId, failure.message, failure.turnMetadata));
      return;
    }
    scheduleChatTask(failure.chatId, 'server-events: deferred queue failure failed', () =>
      handleQueueFailure(failure.chatId, failure.message, failure.turnMetadata));
  }

  const chatExists = (chatId: string) => Boolean(chatRegistry.getChat(chatId));
  agentRegistry.onMessages((chatId, messages, turnMetadata) => {
    if (!chatExists(chatId)) return;
    const fence = chatViews.captureFence(chatId);
    scheduleChatTask(chatId, 'chat-view: message ingestion failed', async () => {
      if (!chatExists(chatId)) return;
      try {
        const parsed = parseChatMessages(messages);
        const appended = await chatViews.appendAfterEnsuringGeneration(
          chatId,
          () => loadNativeMessages(chatId),
          parsed,
          { fence },
        );
        if (appended.skipped) return;
        const committedMessages = appended.messages.map((entry) => entry.message);
        if (committedMessages.length > 0) {
          metadata.updateFromAppendedMessages(chatId, committedMessages);
          markSearchChatDirty(chatId);
        }
        if (appended.messages.length > 0) {
          broadcast(
            new ChatMessagesMessage(
              chatId,
              appended.generationId,
              appended.messages,
              turnMetadata?.turnId,
              turnMetadata?.clientRequestId,
              turnMetadata?.upstreamRequestId,
            ),
          );
        }
        await pendingInputs.reconcileRetainedHistory(chatId);
      } catch (err) {
        logger.warn(
          'chat-view: append failed; reloading from native:',
          errorMessage(err),
        );
        await reloadAfterProcessError(chatId, errorMessage(err), turnMetadata);
      }
    });
  });

  agentRegistry.onProcessing((chatId, isProcessing) => {
    if (!chatExists(chatId)) return;
    broadcast(new ChatProcessingUpdatedMessage(chatId, isProcessing));
  });
  agentRegistry.onSessionCreated((chatId) => {
    if (!chatExists(chatId)) return;
    markSearchCatalogDirty(chatId);
    broadcast(new ChatSessionCreatedMessage(chatId));
  });
  agentRegistry.onFinished((chatId, exitCode, turnMetadata) => {
    if (!chatExists(chatId)) return;
    const queuedFinalization = queue.getQueuedTurnFinalization(chatId, turnMetadata?.turnId);
    const expectedAbort = userAbortLifecycle.onTurnTerminal(chatId, turnMetadata);
    queue.onAgentTurnTerminal(chatId, turnMetadata);
    scheduleChatTask(chatId, 'server-events: turn completion failed', async () => {
      if (!chatExists(chatId)) return;
      if (queuedFinalization && await queuedFinalization !== 'committed') return;
      await settleExecutionCommand(chatId, turnMetadata, 'finished');
      if (!expectedAbort) await pendingInputs.reconcileNativeHistory(chatId);
      await pendingRecovery.waitForSettlements(chatId);
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
      void queue.checkChatIdle(chatId).catch((err) => {
        logger.warn('queue: checkChatIdle error:', errorMessage(err));
      });
    });
  });
  agentRegistry.onFailed((chatId, agentErrorMessage, turnMetadata) => {
    if (!chatExists(chatId)) return;
    const queuedFinalization = queue.getQueuedTurnFinalization(chatId, turnMetadata?.turnId);
    const expectedAbort = userAbortLifecycle.onTurnTerminal(chatId, turnMetadata);
    queue.onAgentTurnTerminal(chatId, turnMetadata);
    if (expectedAbort === 'deferred') {
      deferTerminalFailure({
        source: 'agent',
        chatId,
        message: agentErrorMessage,
        ...(turnMetadata ? { turnMetadata } : {}),
      });
      queue.checkChatIdle(chatId).catch((err) => {
        logger.warn('queue: checkChatIdle error:', errorMessage(err));
      });
      return;
    }
    if (expectedAbort) {
      scheduleChatTask(chatId, 'server-events: interrupted command settlement failed', () =>
        settleExecutionCommand(chatId, turnMetadata, 'finished'));
      queue.checkChatIdle(chatId).catch((err) => {
        logger.warn('queue: checkChatIdle error:', errorMessage(err));
      });
      return;
    }
    scheduleChatTask(chatId, 'server-events: turn failure handling failed', async () => {
      if (!chatExists(chatId)) return;
      if (queuedFinalization && await queuedFinalization !== 'committed') return;
      await handleAgentFailure(chatId, agentErrorMessage, turnMetadata);
      void queue.checkChatIdle(chatId).catch((err) => {
        logger.warn('queue: checkChatIdle error:', errorMessage(err));
      });
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
  });
  chatRegistry.onChatRemoved((chatId) => {
    agentRegistry.discardTurn(chatId);
    userAbortLifecycle.discard(chatId);
    for (const key of deferredTerminalFailures.keys()) {
      if (key.startsWith(`${chatId}:`)) deferredTerminalFailures.delete(key);
    }
    pendingInputs.clearChat(chatId, 'chat-removed');
    chatViews.deleteChatView(chatId);
    deleteSearchChat(chatId);
    broadcast(new ChatSessionDeletedWsMessage(chatId));
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

  queue.onExecutionControlUpdated((chatId, controlState) => {
    broadcast(
      new ChatExecutionControlUpdatedMessage(
        chatId,
        toClientChatExecutionControlState(controlState),
      ),
    );
  });
  queue.onSessionStopRequested((chatId, stopId, preparingTurn) => {
    userAbortLifecycle.onStopRequested(chatId, stopId, preparingTurn);
  });
  queue.onDispatching((chatId, entryId, content) => {
    broadcast(new QueueDispatchingMessage(chatId, entryId, content));
  });
  queue.onChatMessages((chatId, generationId, messages, eventMetadata = {}) => {
    scheduleChatTask(chatId, 'server-events: queued chat message update failed', () => {
      if (!chatExists(chatId)) return;
      const parsedMessages = messages.map((entry) => entry.message);
      metadata.updateFromAppendedMessages(chatId, parsedMessages);
      if (parsedMessages.length > 0) markSearchChatDirty(chatId);
      broadcast(
        new ChatMessagesMessage(
          chatId,
          generationId,
          messages,
          eventMetadata.turnId,
          eventMetadata.clientRequestId,
        ),
      );
    });
  });
  pendingInputs.store.onUpdated((input) => {
    broadcast(new PendingUserInputUpdatedMessage(input));
  });
  pendingInputs.store.onStatusUpdated((chatId, clientRequestId, deliveryStatus) => {
    broadcast(new PendingUserInputStatusUpdatedMessage(chatId, clientRequestId, deliveryStatus));
  });
  pendingInputs.store.onCleared((chatId, clientRequestId, reason) => {
    broadcast(
      new PendingUserInputClearedMessage(chatId, clientRequestId, reason),
    );
  });
  queue.onSessionStopped((chatId, success, intent, stopId) => {
    const acknowledgement = userAbortLifecycle.onSessionStopped(chatId, stopId, success);
    if (acknowledgement.terminalDisposition === 'suppress') {
      const failure = takeDeferredTerminalFailure(chatId, acknowledgement.turn);
      if (failure) {
        scheduleChatTask(chatId, 'server-events: interrupted command settlement failed', () =>
          settleExecutionCommand(chatId, failure.turnMetadata, 'finished'));
      }
    } else if (acknowledgement.terminalDisposition === 'release') {
      const failure = takeDeferredTerminalFailure(chatId, acknowledgement.turn);
      if (failure) releaseDeferredTerminalFailure(failure);
      else reconcilePendingAfterTerminal(chatId, 'rejected stop');
    }
    broadcast(new ChatSessionStoppedMessage(chatId, success, intent));
  });
  queue.onTurnFailed((chatId, queueErrorMessage, options = {}) => {
    const expectedAbort = userAbortLifecycle.onTurnTerminal(chatId, options);
    if (expectedAbort === 'deferred') {
      deferTerminalFailure({
        source: 'queue',
        chatId,
        message: queueErrorMessage,
        turnMetadata: options,
      });
      return;
    }
    if (expectedAbort) return;
    scheduleChatTask(chatId, 'server-events: queued turn failure handling failed', () =>
      handleQueueFailure(chatId, queueErrorMessage, options));
  });
  queue.onTurnSettled((chatId, turn) => {
    userAbortLifecycle.onTurnSettled(chatId, turn);
    if (turn) agentRegistry.settleTurn(chatId, turn);
  });

  return { waitForIdle };
}
