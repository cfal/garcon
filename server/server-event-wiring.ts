import crypto from 'node:crypto';
import {
  isAbortAcknowledged,
  parseChatMessages,
  type ChatStopIntent,
  type ChatMessage,
} from '../common/chat-types.js';
import { isChatListInvalidationReason } from '../common/ws-events.ts';
import { toClientChatExecutionControlState } from './chat-execution/control-state.ts';
import type { TurnEventMetadata } from './agents/event-bus.js';
import type { AgentRegistry } from './agents/registry.js';
import {
  attachNativeMessageSource,
  getNativeMessageRevisionSource,
} from './agents/shared/native-message-source.js';
import type { ChatRegistry } from './chats/store.js';
import type { ChatTransientFeedStore } from './chats/chat-transient-feed.js';
import type { MetadataIndex } from './chats/metadata-store.js';
import type {
  ChatHistoryPage,
  ChatTranscriptSnapshot,
  ChatViewStore,
} from './chats/chat-view-store.js';
import type { IdleNativeReconciler } from './chats/idle-native-reconciler.js';
import type { ChatNativeReloader } from './chats/chat-native-reload.js';
import type { PendingUserInputService } from './chats/pending-user-input-service.js';
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
import { ChatProcessErrorRecovery } from './chats/chat-process-error-recovery.js';
import { UserAbortLifecycleCoordinator } from './chats/user-abort-lifecycle-coordinator.js';
import {
  AgentRunFinishedMessage,
  AgentRunFailedMessage,
  ChatMessagesMessage,
  ChatGenerationResetMessage,
  ChatProjectionGenerationTransitionMessage,
  ChatTransientFeedMutationMessage,
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

function normalizeAgentMessages(messages: readonly ChatMessage[]): ChatMessage[] {
  const normalized: ChatMessage[] = [];
  for (const message of messages) {
    const source = getNativeMessageRevisionSource(message);
    for (const parsed of parseChatMessages([message])) {
      normalized.push(attachNativeMessageSource(parsed, source));
    }
  }
  return normalized;
}

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
  processing: ChatProcessingActivity;
  metadata: MetadataIndex;
  chatViews: ChatViewStore;
  transientFeeds: ChatTransientFeedStore;
  idleReconciler: IdleNativeReconciler;
  chatNativeReloader: NativeReloaderDep;
  pendingInputs: PendingUserInputService;
  commandLedger: CommandLedger;
  shareStore: ShareStore;
  telegramNotifier: TelegramNotifier;
  telegramSettings: TelegramSettingsStore;
  scheduledPrompts: ScheduledPromptScheduler;
  snippets: SnippetService;
  loadChatSnapshot(chatId: string): Promise<ChatTranscriptSnapshot>;
  composeProjectionSnapshot(
    chatId: string,
    messages: readonly ChatMessage[],
    revision: string,
  ): Promise<ChatTranscriptSnapshot>;
  getCarryOverMessageCount(chatId: string): Promise<number>;
  loadChatPage(chatId: string, limit: number, offset: number): Promise<ChatHistoryPage | null>;
  searchIndex?: ChatSearchEventIndex;
}

export interface ServerEventWiring {
  notifyAgentHandoff(chatId: string): void;
  notifyTranscriptCompositionChanged(chatId: string): void;
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
  chatViews,
  transientFeeds,
  idleReconciler,
  chatNativeReloader,
  pendingInputs,
  commandLedger,
  shareStore,
  telegramNotifier,
  telegramSettings,
  scheduledPrompts,
  snippets,
  loadChatSnapshot,
  composeProjectionSnapshot,
  getCarryOverMessageCount,
  loadChatPage,
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
      const previousGenerationId = chatViews.getCursor(chatId)?.generationId
        ?? transientFeeds.currentSnapshot(chatId)?.generationId
        ?? crypto.randomUUID();
      const generationId = crypto.randomUUID();
      chatViews.invalidateFence(chatId);
      chatViews.invalidate(chatId);
      markSearchCatalogDirty(chatId);
      broadcast(new ChatListRefreshRequestedMessage('agent-handoff', chatId));
      const transition = transientFeeds.resetEmptyGeneration({
        chatId,
        agentOwnershipEpoch: entry.agentOwnershipEpoch,
        previousGenerationId,
        generationId,
      });
      broadcast(new ChatProjectionGenerationTransitionMessage(
        transition.resetTransactionId,
        transition.serverInstanceId,
        transition.chatId,
        transition.agentOwnershipEpoch,
        transition.previousGenerationId,
        transition.generationId,
        transition.transientRevision,
        transition.stateDigest,
        transition.rows,
      ));
    });
  }

  function notifyTranscriptCompositionChanged(chatId: string): void {
    if (!chatExists(chatId)) return;
    idleReconciler.noteHistoryChanged(chatId);
    markSearchCatalogDirty(chatId);
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

  async function markPublicTurnTerminal(
    chatId: string,
    turnMetadata?: TurnEventMetadata,
    interruptionReason?: 'user-stop' | 'chat-deleted',
  ): Promise<void> {
    if (!turnMetadata?.turnId) return;
    await commandLedger.markPublicTerminal(chatId, turnMetadata.turnId, interruptionReason);
  }

  function interruptionReason(intent: ChatStopIntent): 'user-stop' | 'chat-deleted' {
    return intent === 'chat-deletion' ? 'chat-deleted' : 'user-stop';
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
    await idleReconciler.ensureHistoryChangeReconciled(chatId);
    broadcastAgentFailure(chatId, agentErrorMessage, turnMetadata);
    await markPublicTurnTerminal(chatId, turnMetadata);
  }

  async function handleQueueFailure(
    chatId: string,
    queueErrorMessage: string,
    options: TurnEventMetadata,
  ): Promise<void> {
    // Clears queue-dispatching's optimistic state when launch fails before the provider starts.
    broadcast(new ChatProcessingUpdatedMessage(chatId, processing.phase(chatId)));
    if (consumeProcessFailure(chatId, options)) return;
    await settleExecutionCommand(chatId, options, 'failed', queueErrorMessage);
    if (options.clientRequestId) {
      pendingInputs.markFailed(chatId, options.clientRequestId);
    }
    await pendingInputs.reconcileNativeHistory(chatId);
    await idleReconciler.ensureHistoryChangeReconciled(chatId);
    broadcastAgentFailure(chatId, queueErrorMessage, options);
    await markPublicTurnTerminal(chatId, options);
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

  // A settled view still numbers its messages from the event stream until it is rebuilt from
  // native history, so reconcile once the chat stops working. Chats report idle more than once
  // per settle; the reconciler debounces and re-checks ownership before it acts.
  queue.onChatIdle((chatId) => {
    if (!chatExists(chatId)) return;
    idleReconciler.noteIdle(chatId);
  });

  agentRegistry.onMessages((chatId, messages, turnMetadata) => {
    if (!chatExists(chatId)) return;
    const fence = chatViews.captureFence(chatId);
    return scheduleChatTask(chatId, 'chat-view: message ingestion failed', async () => {
      if (!chatExists(chatId)) return;
      try {
        const parsed = normalizeAgentMessages(messages);
        const appended = await chatViews.appendAfterEnsuringGeneration(
          chatId,
          {
            loadAll: () => loadChatSnapshot(chatId),
            loadPage: (limit, offset) => loadChatPage(chatId, limit, offset),
          },
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
          if (turnMetadata?.turnOwner) {
            await commandLedger.appendProjectionAssistantMessages(
              chatId,
              turnMetadata.turnOwner,
              committedMessages.flatMap((message) => (
                message.type === 'assistant-message' && message.content.length > 0
                  ? [message.content]
                  : []
              )),
            );
          }
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
        if (turnMetadata?.turnId) {
          await commandLedger.markTurnOutputUnavailable(
            chatId,
            turnMetadata.turnId,
            'recovery',
          );
        }
        await reloadAfterProcessError(chatId, errorMessage(err), turnMetadata);
      }
    });
  });
  agentRegistry.onProjectionApplied((applied) => {
    const event = applied.event;
    if (event.kind === 'commit' || event.kind === 'session' || !chatExists(event.chatId)) {
      return;
    }
    return scheduleChatTask(event.chatId, 'transient-feed: projection failed', async () => {
      if (!chatExists(event.chatId)) return;
      let cursor = chatViews.getCursor(event.chatId);
      if (!cursor) {
        await chatViews.getOrCreatePage(
          event.chatId,
          {
            loadAll: () => loadChatSnapshot(event.chatId),
            loadPage: (limit, offset) => loadChatPage(event.chatId, limit, offset),
          },
          1,
        );
        cursor = chatViews.getCursor(event.chatId);
      }
      if (!cursor) throw new Error('TRANSIENT_FEED_GENERATION_UNAVAILABLE');

      const carryOverMessageCount = await getCarryOverMessageCount(event.chatId);
      if (event.kind === 'reset') {
        const registered = chatRegistry.getChat(event.chatId);
        if (!registered || registered.agentOwnershipEpoch !== event.agentOwnershipEpoch) {
          throw new Error('PROJECTION_RESET_STALE_OWNER');
        }
        if (registered.transcriptContentEpoch !== event.checkpoint.projection.contentEpoch) {
          await chatRegistry.updateChat(
            event.chatId,
            { transcriptContentEpoch: event.checkpoint.projection.contentEpoch },
            { flush: true },
          );
        }
        const snapshot = await composeProjectionSnapshot(
          event.chatId,
          applied.current.entries.map((entry) => entry.message),
          event.checkpoint.projection.stateRevision,
        );
        const page = await chatViews.replaceFromProjection(event.chatId, snapshot);
        const projected = transientFeeds.apply(applied, {
          previousGenerationId: cursor.generationId,
          generationId: page.generationId,
          carryOverMessageCount,
        });
        if (projected.kind !== 'generation-transition') {
          throw new TypeError('Projection reset did not produce a compound transition');
        }
        const value = projected.value;
        broadcast(new ChatProjectionGenerationTransitionMessage(
          value.resetTransactionId,
          value.serverInstanceId,
          value.chatId,
          value.agentOwnershipEpoch,
          value.previousGenerationId,
          value.generationId,
          value.transientRevision,
          value.stateDigest,
          value.rows,
        ));
        markSearchCatalogDirty(event.chatId);
        return;
      }

      const projected = transientFeeds.apply(applied, {
        generationId: cursor.generationId,
        carryOverMessageCount,
      });
      if (projected.kind === 'generation-transition') {
        const value = projected.value;
        broadcast(new ChatProjectionGenerationTransitionMessage(
          value.resetTransactionId,
          value.serverInstanceId,
          value.chatId,
          value.agentOwnershipEpoch,
          value.previousGenerationId,
          value.generationId,
          value.transientRevision,
          value.stateDigest,
          value.rows,
        ));
        return;
      }
      if (projected.kind !== 'mutation') return;
      const value = projected.value;
      broadcast(new ChatTransientFeedMutationMessage(
        value.serverInstanceId,
        value.chatId,
        value.agentOwnershipEpoch,
        value.generationId,
        value.transientRevision,
        value.stateDigest,
        value.mutation,
      ));
    });
  });
  agentRegistry.onInputSettled((chatId, clientRequestId) => {
    queue.onAcceptedInputSettled(chatId, clientRequestId);
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
  agentRegistry.onProcessing((chatId) => {
    publishProcessing(chatId);
  });
  queue.onProcessingInvalidated((chatId) => {
    if (inlineTerminalReleases.has(chatId)) return;
    publishProcessing(chatId);
  });
  const releaseTerminalOwnership = (
    chatId: string,
    turnMetadata: TurnEventMetadata | undefined,
  ) => {
    inlineTerminalReleases.add(chatId);
    try {
      queue.onAgentTurnTerminal(chatId, turnMetadata);
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
  agentRegistry.onFinished((chatId, exitCode, turnMetadata) => {
    if (!chatExists(chatId)) return;
    const queuedFinalization = queue.getQueuedTurnFinalization(chatId, turnMetadata?.turnId);
    const expectedAbort = userAbortLifecycle.onTurnTerminal(chatId, turnMetadata);
    return scheduleChatTask(chatId, 'server-events: turn completion failed', async () => {
      let released = false;
      try {
        if (!chatExists(chatId)) return;
        if (queuedFinalization && await queuedFinalization !== 'committed') return;
        releaseTerminalOwnership(chatId, turnMetadata);
        released = true;
        if (turnMetadata?.turnOwner) {
          await commandLedger.finalizeProjectionOutput(chatId, turnMetadata.turnOwner);
        }
        await settleExecutionCommand(chatId, turnMetadata, 'finished');
        if (!expectedAbort) await pendingInputs.reconcileNativeHistory(chatId);
        await idleReconciler.ensureHistoryChangeReconciled(chatId);
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
        if (!expectedAbort) await markPublicTurnTerminal(chatId, turnMetadata);
      } finally {
        if (!released) releaseTerminalOwnership(chatId, turnMetadata);
        void queue.checkChatIdle(chatId).catch((err) => {
          logger.warn('queue: checkChatIdle error:', errorMessage(err));
        });
      }
    });
  });
  agentRegistry.onFailed((chatId, agentErrorMessage, turnMetadata) => {
    if (!chatExists(chatId)) return;
    const queuedFinalization = queue.getQueuedTurnFinalization(chatId, turnMetadata?.turnId);
    const expectedAbort = userAbortLifecycle.onTurnTerminal(chatId, turnMetadata);
    if (expectedAbort === 'deferred') {
      deferTerminalFailure({
        source: 'agent',
        chatId,
        message: agentErrorMessage,
        ...(turnMetadata ? { turnMetadata } : {}),
      });
      releaseTerminalOwnership(chatId, turnMetadata);
      return queue.checkChatIdle(chatId).catch((err) => {
        logger.warn('queue: checkChatIdle error:', errorMessage(err));
      });
      return;
    }
    if (expectedAbort) {
      return scheduleChatTask(chatId, 'server-events: interrupted command settlement failed', async () => {
        let released = false;
        try {
          releaseTerminalOwnership(chatId, turnMetadata);
          released = true;
          await settleExecutionCommand(chatId, turnMetadata, 'finished');
          await idleReconciler.ensureHistoryChangeReconciled(chatId);
        } finally {
          if (!released) releaseTerminalOwnership(chatId, turnMetadata);
        }
      });
      queue.checkChatIdle(chatId).catch((err) => {
        logger.warn('queue: checkChatIdle error:', errorMessage(err));
      });
      return;
    }
    return scheduleChatTask(chatId, 'server-events: turn failure handling failed', async () => {
      let released = false;
      try {
        if (!chatExists(chatId)) return;
        if (queuedFinalization && await queuedFinalization !== 'committed') return;
        releaseTerminalOwnership(chatId, turnMetadata);
        released = true;
        if (turnMetadata?.turnOwner) {
          await commandLedger.finalizeProjectionOutput(chatId, turnMetadata.turnOwner);
        }
        await handleAgentFailure(chatId, agentErrorMessage, turnMetadata);
      } finally {
        if (!released) releaseTerminalOwnership(chatId, turnMetadata);
        void queue.checkChatIdle(chatId).catch((err) => {
          logger.warn('queue: checkChatIdle error:', errorMessage(err));
        });
      }
    });
  });

  agentRegistry.onProjectionFailure((chatId, failure, turnMetadata) => {
    if (!chatExists(chatId) || !turnMetadata) return;
    const reservation = queue.replaceTurnWithTranscriptSnapshotReservation(
      chatId,
      turnMetadata,
    );
    return scheduleChatTask(chatId, 'server-events: projection failure handling failed', async () => {
      let released = false;
      try {
        releaseTerminalOwnership(chatId, turnMetadata);
        released = true;
        if (turnMetadata.turnOwner) {
          await commandLedger.markProjectionOutputUnavailable(
            chatId,
            turnMetadata.turnOwner,
            'transcript-barrier',
          );
        }
        const message = errorMessage(failure);
        await settleExecutionCommand(chatId, turnMetadata, 'failed', message);
        if (turnMetadata.clientRequestId) {
          pendingInputs.markFailed(chatId, turnMetadata.clientRequestId);
        }
        broadcastAgentFailure(chatId, message, turnMetadata);
        await markPublicTurnTerminal(chatId, turnMetadata);
      } finally {
        if (!released) releaseTerminalOwnership(chatId, turnMetadata);
        if (reservation) {
          const repaired = await agentRegistry.repairProjection(
            chatId,
            AbortSignal.timeout(10_000),
          ).catch(() => false);
          if (repaired) await queue.releaseTranscriptSnapshot(reservation);
        }
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
  });
  chatRegistry.onChatRemoved((chatId, removalReason) => {
    agentRegistry.discardTurn(chatId);
    userAbortLifecycle.discard(chatId);
    for (const key of deferredTerminalFailures.keys()) {
      if (key.startsWith(`${chatId}:`)) deferredTerminalFailures.delete(key);
    }
    pendingInputs.clearChat(chatId, 'chat-removed');
    transientFeeds.deleteChat(chatId);
    chatViews.deleteChatView(chatId);
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
  queue.onSessionStopRequested((chatId, stopId, preparingTurn, intent) => {
    userAbortLifecycle.onStopRequested(chatId, stopId, preparingTurn);
  });
  queue.onDispatching((chatId, entryId, content) => {
    broadcast(new QueueDispatchingMessage(chatId, entryId, content));
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
  queue.onSessionStopped((chatId, outcome, intent, stopId, waitMs) => {
    logger.info('queue: Stop resolved', {
      chatId,
      stopId,
      intent,
      outcome,
      phase: processing.phase(chatId),
      waitMs,
    });
    const abortAcknowledged = isAbortAcknowledged(outcome);
    const acknowledgement = userAbortLifecycle.onSessionStopped(
      chatId,
      stopId,
      abortAcknowledged,
    );
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
    publishProcessing(chatId);
    scheduleChatTask(chatId, 'server-events: session-stopped broadcast failed', () => {
      if (!chatExists(chatId)) return;
      broadcast(new ChatSessionStoppedMessage(chatId, outcome, intent));
    });
    if (acknowledgement.turn?.turnId) {
      scheduleChatTask(chatId, 'server-events: interrupted receipt settlement failed', async () => {
        if (abortAcknowledged) {
          await markPublicTurnTerminal(chatId, acknowledgement.turn, interruptionReason(intent));
        } else {
          await commandLedger.publishDeferredTerminal(chatId, acknowledgement.turn!.turnId!);
        }
      });
    }
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

  return { notifyAgentHandoff, notifyTranscriptCompositionChanged, waitForIdle };
}
