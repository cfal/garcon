import { ErrorMessage, parseChatMessages, type ChatMessage } from '../common/chat-types.js';
import { isChatListInvalidationReason } from '../common/ws-events.ts';
import { toClientQueueState } from '../common/queue-state.ts';
import type { TurnEventMetadata } from './agents/event-bus.js';
import type { AgentRegistry } from './agents/registry.js';
import type { ChatRegistry } from './chats/store.js';
import type { MetadataIndex } from './chats/metadata-store.js';
import type { ChatViewStore } from './chats/chat-view-store.js';
import type { ChatNativeReloader } from './chats/chat-native-reload.js';
import type { PendingUserInputService } from './chats/pending-user-input-service.js';
import type { ShareStore } from './chats/share-store.js';
import type { SettingsStore } from './settings/store.js';
import type { QueueManager } from './queue.js';
import type { CommandLedger } from './commands/command-ledger.js';
import type { TelegramNotifier } from './notifications/telegram.js';
import type { TelegramSettingsStore } from './notifications/telegram-settings-store.js';
import type { BrowserPushSettingsStore } from './notifications/browser-push-settings-store.js';
import type { BrowserPushSubscriptionStore } from './notifications/browser-push-subscription-store.js';
import { ExpectedUserAbortTracker } from './lib/expected-user-aborts.js';
import { createLogger } from './lib/log.js';
import { errorMessage } from './lib/errors.js';
import { buildRemoteSettingsSnapshot } from './routes/workspace.js';
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
  QueueStateUpdatedMessage,
  QueueDispatchingMessage,
  PendingUserInputUpdatedMessage,
  PendingUserInputClearedMessage,
  SettingsChangedMessage,
} from '../common/ws-events.ts';

const logger = createLogger('server-events');
const PROCESS_ERROR_RELOAD_FAILED_NOTICE = 'The process died. Reloading chat history failed.';

interface WebSocketPublisher {
  publish(topic: string, payload: string): unknown;
}

export interface ServerEventWiringDeps {
  server: WebSocketPublisher;
  agentRegistry: AgentRegistry;
  chatRegistry: ChatRegistry;
  settings: SettingsStore;
  queue: QueueManager;
  metadata: MetadataIndex;
  chatViews: ChatViewStore;
  chatNativeReloader: ChatNativeReloader;
  pendingInputs: PendingUserInputService;
  commandLedger: CommandLedger;
  shareStore: ShareStore;
  telegramNotifier: TelegramNotifier;
  telegramSettings: TelegramSettingsStore;
  browserPushSettings: BrowserPushSettingsStore;
  browserPushSubscriptions: BrowserPushSubscriptionStore;
  loadNativeMessages(chatId: string): Promise<ChatMessage[]>;
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
  commandLedger,
  shareStore,
  telegramNotifier,
  telegramSettings,
  browserPushSettings,
  browserPushSubscriptions,
  loadNativeMessages,
}: ServerEventWiringDeps): void {
  const broadcast = (payload: unknown) => server.publish('chat', JSON.stringify(payload));
  const recentProcessFailures = new Map<string, number>();
  const processFailureDedupeMs = 30_000;
  const expectedUserAborts = new ExpectedUserAbortTracker();

  function turnFailureKey(chatId: string, turnMetadata?: TurnEventMetadata): string {
    return `${chatId}:${turnMetadata?.turnId ?? turnMetadata?.clientRequestId ?? 'chat'}`;
  }

  function pruneRecentProcessFailures(): void {
    const cutoff = Date.now() - processFailureDedupeMs;
    for (const [key, markedAt] of recentProcessFailures) {
      if (markedAt < cutoff) recentProcessFailures.delete(key);
    }
  }

  function markProcessFailure(chatId: string, turnMetadata?: TurnEventMetadata): void {
    pruneRecentProcessFailures();
    recentProcessFailures.set(turnFailureKey(chatId, turnMetadata), Date.now());
  }

  function consumeProcessFailure(chatId: string, turnMetadata?: TurnEventMetadata): boolean {
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
    broadcast(new AgentRunFailedMessage(
      chatId,
      message,
      turnMetadata?.turnId,
      turnMetadata?.clientRequestId,
      turnMetadata?.upstreamRequestId,
    ));
  }

  async function reloadAfterProcessError(
    chatId: string,
    message: string,
    turnMetadata?: TurnEventMetadata,
  ): Promise<void> {
    markProcessFailure(chatId, turnMetadata);
    chatViews.invalidateFence(chatId);
    try {
      const reload = await chatNativeReloader.reloadFromNative(chatId, 'process-error', message);
      pendingInputs.discardChat(chatId);
      broadcast(new ChatGenerationResetMessage(
        chatId,
        reload.generationId,
        'process-error',
        reload.lastSeq,
      ));
    } catch (err) {
      logger.warn('chat-view: process-error reload failed:', errorMessage(err));
      try {
        const reset = await chatViews.appendToCurrentOrEmpty(chatId, [
          new ErrorMessage(new Date().toISOString(), PROCESS_ERROR_RELOAD_FAILED_NOTICE),
        ]);
        pendingInputs.discardChat(chatId);
        if (reset.messages.length > 0) {
          broadcast(new ChatMessagesMessage(
            chatId,
            reset.generationId,
            reset.messages,
            turnMetadata?.turnId,
            turnMetadata?.clientRequestId,
            turnMetadata?.upstreamRequestId,
          ));
        }
      } catch (resetErr) {
        logger.warn('chat-view: process-error fallback append failed:', errorMessage(resetErr));
      }
    }
    broadcastAgentFailure(chatId, message, turnMetadata);
  }

  const chatExists = (chatId: string) => Boolean(chatRegistry.getChat(chatId));
  agentRegistry.onMessages((chatId, messages, turnMetadata) => {
    if (!chatExists(chatId)) return;
    const fence = chatViews.captureFence(chatId);
    void (async () => {
      try {
        const parsed = parseChatMessages(messages);
        const appended = await chatViews.appendAfterEnsuringGeneration(
          chatId,
          () => loadNativeMessages(chatId),
          parsed,
          { fence },
        );
        if (appended.skipped) return;
        if (parsed.length > 0) metadata.updateFromAppendedMessages(chatId, parsed);
        if (appended.messages.length > 0) {
          broadcast(new ChatMessagesMessage(
            chatId,
            appended.generationId,
            appended.messages,
            turnMetadata?.turnId,
            turnMetadata?.clientRequestId,
            turnMetadata?.upstreamRequestId,
          ));
        }
        await pendingInputs.reconcile(chatId);
      } catch (err) {
        logger.warn('chat-view: append failed; reloading from native:', errorMessage(err));
        await reloadAfterProcessError(chatId, errorMessage(err), turnMetadata);
      }
    })();
  });

  agentRegistry.onProcessing((chatId, isProcessing) => {
    if (!chatExists(chatId)) return;
    if (isProcessing) expectedUserAborts.clear(chatId);
    broadcast(new ChatProcessingUpdatedMessage(chatId, isProcessing));
  });
  agentRegistry.onSessionCreated((chatId) => {
    if (!chatExists(chatId)) return;
    broadcast(new ChatSessionCreatedMessage(chatId));
  });
  agentRegistry.onFinished((chatId, exitCode, turnMetadata) => {
    if (!chatExists(chatId)) return;
    expectedUserAborts.clear(chatId);
    broadcast(new AgentRunFinishedMessage(chatId, exitCode, turnMetadata?.turnId, turnMetadata?.clientRequestId, turnMetadata?.upstreamRequestId));
    pendingInputs.reconcile(chatId).catch((err) => {
      logger.warn('pending-inputs: reconcile after finish failed:', errorMessage(err));
    });
    queue.checkChatIdle(chatId).catch((err) => {
      logger.warn('queue: checkChatIdle error:', errorMessage(err));
    });
  });
  agentRegistry.onFailed((chatId, agentErrorMessage, turnMetadata) => {
    if (!chatExists(chatId)) return;
    if (expectedUserAborts.has(chatId)) {
      queue.checkChatIdle(chatId).catch((err) => {
        logger.warn('queue: checkChatIdle error:', errorMessage(err));
      });
      return;
    }
    if (turnMetadata?.commandType === 'chat-start' && turnMetadata.clientRequestId) {
      commandLedger.updateCommand('chat-start', chatId, turnMetadata.clientRequestId, {
        status: 'failed',
        error: agentErrorMessage,
      }).catch((err) => {
        logger.warn('commands: failed to mark chat-start command failed:', errorMessage(err));
      });
    }
    void reloadAfterProcessError(chatId, agentErrorMessage, turnMetadata);
    queue.checkChatIdle(chatId).catch((err) => {
      logger.warn('queue: checkChatIdle error:', errorMessage(err));
    });
  });

  settings.onSessionNameChanged((chatId, title) => {
    broadcast(new ChatTitleUpdatedMessage(chatId, title));
  });
  settings.onListChanged((reason, chatId) => {
    if (!isChatListInvalidationReason(reason)) {
      logger.warn('server: skipped unknown chat list invalidation reason:', reason);
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
        browserPushSettings,
        browserPushSubscriptions,
      });
      broadcast(new SettingsChangedMessage(snapshot));
    } catch (err) {
      logger.warn('server: failed to broadcast settings-changed:', errorMessage(err));
    }
  };
  settings.onRemoteSettingsChanged(broadcastRemoteSettings);
  telegramSettings.onChanged(() => {
    telegramNotifier.setBotToken(telegramSettings.getBotToken());
    void broadcastRemoteSettings();
  });
  browserPushSettings.onChanged(() => {
    void broadcastRemoteSettings();
  });
  browserPushSubscriptions.onChanged(() => {
    void broadcastRemoteSettings();
  });
  chatRegistry.onChatRemoved((chatId) => {
    pendingInputs.clearChat(chatId, 'chat-removed');
    chatViews.deleteChatView(chatId);
    broadcast(new ChatSessionDeletedWsMessage(chatId));
    shareStore.revokeShareByChatId(chatId).catch((err) => {
      logger.warn('share-store: failed to revoke share on chat removal:', errorMessage(err));
    });
  });
  chatRegistry.onChatReadUpdated((chatId, lastReadAt) => {
    if (typeof lastReadAt !== 'string') return;
    broadcast(new ChatReadUpdatedV1Message(chatId, lastReadAt));
  });
  chatRegistry.onChatProjectPathUpdated((chatId, projectPath, previousProjectPath) => {
    broadcast(new ChatProjectPathUpdatedMessage(chatId, projectPath, previousProjectPath));
  });

  queue.onQueueUpdated((chatId, queueState) => {
    broadcast(new QueueStateUpdatedMessage(chatId, toClientQueueState(queueState)));
  });
  queue.onSessionStopRequested((chatId) => {
    expectedUserAborts.mark(chatId);
  });
  queue.onDispatching((chatId, entryId, content) => {
    broadcast(new QueueDispatchingMessage(chatId, entryId, content));
  });
  queue.onChatMessages((chatId, generationId, messages, eventMetadata = {}) => {
    metadata.updateFromAppendedMessages(chatId, messages.map((entry) => entry.message));
    broadcast(new ChatMessagesMessage(
      chatId,
      generationId,
      messages,
      eventMetadata.turnId,
      eventMetadata.clientRequestId,
    ));
  });
  pendingInputs.store.onUpdated((input) => {
    broadcast(new PendingUserInputUpdatedMessage(input));
  });
  pendingInputs.store.onCleared((chatId, clientRequestId, reason) => {
    if (reason !== 'chat-removed') return;
    broadcast(new PendingUserInputClearedMessage(chatId, clientRequestId, reason));
  });
  queue.onSessionStopped((chatId, success) => {
    if (!success) expectedUserAborts.clear(chatId);
    broadcast(new ChatSessionStoppedMessage(chatId, success));
  });
  queue.onTurnFailed((chatId, queueErrorMessage, options = {}) => {
    if (consumeProcessFailure(chatId, options)) return;
    if (expectedUserAborts.has(chatId)) return;
    if (options.clientRequestId) {
      pendingInputs.markFailed(chatId, options.clientRequestId);
    }
    broadcastAgentFailure(chatId, queueErrorMessage, options);
  });
}
