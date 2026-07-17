import { parseChatMessages, type ChatMessage } from '../common/chat-types.js';
import { isChatListInvalidationReason } from '../common/ws-events.ts';
import { toClientQueueState } from './queue-state.ts';
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
import type { ScheduledPromptScheduler } from './scheduled-prompts/scheduler.js';
import type { SnippetService } from './snippets/service.js';
import { ExpectedUserAbortTracker } from './lib/expected-user-aborts.js';
import { createLogger } from './lib/log.js';
import { errorMessage } from './lib/errors.js';
import { buildRemoteSettingsSnapshot } from './routes/workspace.js';
import { ChatProcessErrorRecovery } from './chats/chat-process-error-recovery.js';
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
  appendMessages(chatId: string, messages: ChatMessage[]): void;
  markDirty(chatId: string): void;
  deleteChat(chatId: string): void;
}

type NativeReloaderDep = Pick<ChatNativeReloader, 'reloadFromNative'>;

export interface ServerEventWiringDeps {
  server: WebSocketPublisher;
  agentRegistry: AgentRegistry;
  chatRegistry: ChatRegistry;
  settings: SettingsStore;
  queue: QueueManager;
  metadata: MetadataIndex;
  chatViews: ChatViewStore;
  chatNativeReloader: NativeReloaderDep;
  pendingInputs: PendingUserInputService;
  commandLedger: CommandLedger;
  shareStore: ShareStore;
  telegramNotifier: TelegramNotifier;
  telegramSettings: TelegramSettingsStore;
  scheduledPrompts: ScheduledPromptScheduler;
  snippets: SnippetService;
  loadNativeMessages(chatId: string): Promise<ChatMessage[]>;
  searchIndex?: ChatSearchEventIndex;
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
  scheduledPrompts,
  snippets,
  loadNativeMessages,
  searchIndex,
}: ServerEventWiringDeps): void {
  const broadcast = (payload: unknown) =>
    server.publish('chat', JSON.stringify(payload));
  const recentProcessFailures = new Map<string, number>();
  const processFailureDedupeMs = 30_000;
  const expectedUserAborts = new ExpectedUserAbortTracker();
  const processErrorRecovery = new ChatProcessErrorRecovery(
    chatViews,
    chatNativeReloader,
    pendingInputs,
  );

  scheduledPrompts.onInvalidated((reason) => {
    broadcast(new ScheduledPromptsInvalidatedMessage(reason));
  });

  function appendSearchMessages(chatId: string, messages: ChatMessage[]): void {
    if (!searchIndex || messages.length === 0) return;
    try {
      searchIndex.appendMessages(chatId, messages);
    } catch (err) {
      logger.warn(`search-index: append failed for ${chatId}:`, errorMessage(err));
    }
  }

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
      searchIndex.markDirty(chatId);
    } catch (err) {
      logger.warn(`search-index: mark dirty failed for ${chatId}:`, errorMessage(err));
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
        appendSearchMessages(
          chatId,
          recovery.appended.messages.map((entry) => entry.message),
        );
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
        if (parsed.length > 0) {
          metadata.updateFromAppendedMessages(chatId, parsed);
          appendSearchMessages(chatId, parsed);
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
    broadcast(
      new AgentRunFinishedMessage(
        chatId,
        exitCode,
        turnMetadata?.turnId,
        turnMetadata?.clientRequestId,
        turnMetadata?.upstreamRequestId,
      ),
    );
    pendingInputs.reconcileNativeHistory(chatId).catch((err) => {
      logger.warn(
        'pending-inputs: reconcile after finish failed:',
        errorMessage(err),
      );
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
    if (
      turnMetadata?.commandType === 'chat-start' &&
      turnMetadata.clientRequestId
    ) {
      commandLedger
        .updateCommand('chat-start', chatId, turnMetadata.clientRequestId, {
          status: 'failed',
          error: agentErrorMessage,
        })
        .catch((err) => {
          logger.warn(
            'commands: failed to mark chat-start command failed:',
            errorMessage(err),
          );
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
    if (chatRegistry.getChat(chatId)?.nativePath) markSearchChatDirty(chatId);
  });
  chatRegistry.onChatRemoved((chatId) => {
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

  queue.onQueueUpdated((chatId, queueState) => {
    broadcast(
      new QueueStateUpdatedMessage(chatId, toClientQueueState(queueState)),
    );
  });
  queue.onSessionStopRequested((chatId) => {
    expectedUserAborts.mark(chatId);
  });
  queue.onDispatching((chatId, entryId, content) => {
    broadcast(new QueueDispatchingMessage(chatId, entryId, content));
  });
  queue.onChatMessages((chatId, generationId, messages, eventMetadata = {}) => {
    const parsedMessages = messages.map((entry) => entry.message);
    metadata.updateFromAppendedMessages(chatId, parsedMessages);
    appendSearchMessages(chatId, parsedMessages);
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
    void commandLedger.settleRestartInterruptedUserInput(chatId, clientRequestId).catch((err) => {
      logger.warn(
        'pending-inputs: failed to settle restart recovery:',
        errorMessage(err),
      );
    });
  });
  queue.onSessionStopped((chatId, success) => {
    if (!success) expectedUserAborts.clear(chatId);
    broadcast(new ChatSessionStoppedMessage(chatId, success));
    if (success) {
      void (async () => {
        await pendingInputs.settleAfterStop(chatId);
      })().catch((err) => {
        logger.warn(
          'pending-inputs: reconcile after stop failed:',
          errorMessage(err),
        );
      });
    }
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
