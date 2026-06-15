// Composition root. Instantiates all services and wires them together.
// This is the single place where dependencies are resolved.

import path from 'path';
import { initializeServerConfig } from './config.js';
import { decodeWebSocketMessage, sendWebSocketJson } from './ws/utils.js';
import { wrapRoutes } from './lib/http-route.js';
import { malformedJsonResponse } from './lib/json-route.js';
import { MalformedJsonError } from './lib/http-request.js';
import { jsonError } from './lib/http-error.js';
import { verifyAuthToken } from './auth/token.js';
import { init as initAuthStore } from './auth/store.js';
import { forkChatFileCopy } from './chats/fork-chat.js';
import { parseChatMessages } from '../common/chat-types.js';
import { isChatListInvalidationReason } from '../common/ws-events.ts';

// Classes
import { ChatRegistry } from './chats/store.js';
import { ShareStore } from './chats/share-store.js';
import { SettingsStore } from './settings/store.js';
import { QueueManager, queueDrainOptions } from './queue.js';
import { PathCache } from './chats/path-cache.js';
import { ShellManager } from './ws/shell.js';
import { MetadataIndex } from './chats/metadata-store.js';
import { ChatEventLog } from './chats/chat-event-log.js';
import { ChatNativeReloader } from './chats/chat-native-reload.js';
import { ColdLoadedChatEventLog } from './chats/cold-loaded-chat-event-log.js';
import { ChatStreamFence } from './chats/chat-stream-fence.js';
import { PendingUserInputService } from './chats/pending-user-input-service.js';
import { AgentRegistry, createDefaultAgentSuite } from './agents/index.js';
import type { TurnEventMetadata } from './agents/event-bus.js';
import { ApiProviderStore } from './api-providers/store.js';
import { ApiProviderEndpointResolver } from './api-providers/endpoint-resolver.js';
import { ApiProviderService } from './api-providers/service.js';
import { CommandLedger } from './commands/command-ledger.js';
import { ChatCommandService } from './commands/chat-command-service.js';
import { ChatHandler } from './ws/chat.js';
import { TelegramNotifier } from './notifications/telegram.js';
import { TelegramSettingsStore } from './notifications/telegram-settings-store.js';
import { AttentionTracker } from './notifications/attention-tracker.js';
import { abortRunningSessionsWithTimeout } from './lib/shutdown.js';
import {
  AgentRunFinishedMessage,
  AgentRunFailedMessage,
  ChatEventsMessage,
  ChatGenerationResetMessage,
  ChatSessionCreatedMessage,
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
  WsFaultMessage,
} from '../common/ws-events.ts';

// Route factory
import createAllRoutes from './routes/index.js';
import { buildRemoteSettingsSnapshot } from './routes/workspace.js';
import { ModelCatalogResponseCache } from './routes/model-catalog-cache.js';
import type { ShellWebSocketData } from './ws/shell.js';
import { createLogger } from './lib/log.js';
import { errorMessage } from './lib/errors.js';

const logger = createLogger('server');
const PROCESS_ERROR_RELOAD_FAILED_NOTICE = 'The process died. Reloading chat history failed.';

type WsPath = '/shell' | '/ws';

interface WsConnectionData extends ShellWebSocketData {
  pathname: WsPath;
}

type ServeOptionsWithConnectionLimit = Parameters<typeof Bun.serve<WsConnectionData>>[0] & {
  maxConnections?: number;
};

function isWsPath(value: unknown): value is WsPath {
  return value === '/shell' || value === '/ws';
}

export async function startServer(): Promise<void> {
  process.on('unhandledRejection', (err: unknown) => {
    logger.error('unhandled rejection (non-fatal):', errorMessage(err));
  });

  try {
    const config = initializeServerConfig();
    const workspaceDir = config.workspaceDir;

    // Leaf modules with no inter-service dependencies.
    const chatRegistry = new ChatRegistry(workspaceDir);
    const settings = new SettingsStore(workspaceDir);
    const pathCache = new PathCache();
    const shellManager = new ShellManager();

    await initAuthStore();
    await chatRegistry.init();
    await settings.init();

    // User-managed API provider store and resolver.
    const apiProviderStore = new ApiProviderStore();
    await apiProviderStore.init();

    const endpointResolver = new ApiProviderEndpointResolver(() => apiProviderStore.list());

    const agentSuite = createDefaultAgentSuite({
      workspaceDir,
      apiProviderReader: apiProviderStore,
    });

    const apiProviders = new ApiProviderService({
      store: apiProviderStore,
      isApiProviderReferenced(apiProviderId) {
        return Object.values(chatRegistry.listAllChats()).some((entry) => entry.apiProviderId === apiProviderId);
      },
    });
    const modelCatalogResponseCache = new ModelCatalogResponseCache();

    // Agent registry wraps runtimes, persisted chat state, and endpoint selection.
    const agentRegistry = new AgentRegistry({
      registry: chatRegistry,
      agents: agentSuite.agents,
      endpointResolver,
    });

    await chatRegistry.reconcileSessions((session) => agentRegistry.resolveNativePath(session));
    await settings.reconcileWithRegistry(chatRegistry);

    // Chat infrastructure uses the agent registry through narrow injected APIs.
    const metadata = new MetadataIndex(chatRegistry, agentRegistry, {
      metadataPath: path.join(workspaceDir, 'chat-metadata.json'),
    });
    await metadata.init();

    const chatEventLog = new ChatEventLog(
      workspaceDir,
      (chatId) => agentRegistry.isChatRunning(chatId),
    );
    const streamFence = new ChatStreamFence();
    const chatNativeReloader = new ChatNativeReloader(
      chatEventLog,
      {
        async loadNativeMessages(chatId) {
          const session = chatRegistry.getChat(chatId);
          if (!session) return [];
          return parseChatMessages(await agentRegistry.loadMessages(session, chatId));
        },
      },
      (chatId) => agentRegistry.isChatRunning(chatId),
    );
    const coldLoadedChatEvents = new ColdLoadedChatEventLog(chatEventLog, chatNativeReloader);
    const chatMessageReader = {
      async ensureLoaded(chatId: string) {
        return coldLoadedChatEvents.getMessages(chatId);
      },
      getMessages(chatId: string) {
        return coldLoadedChatEvents.getLoadedMessages(chatId);
      },
    };
    const chatEventPages = {
      async readPage(chatId: string, limit: number, beforeSeq?: number) {
        return coldLoadedChatEvents.readPage(chatId, limit, beforeSeq);
      },
    };
    const chatEventAppender = {
      async appendMessages(
        chatId: string,
        messages: Parameters<ChatEventLog['appendMessages']>[1],
        origin: 'submit',
      ) {
        return coldLoadedChatEvents.appendMessages(chatId, messages, origin);
      },
      async reviseUserMessageDelivery(
        chatId: string,
        ids: Parameters<ChatEventLog['reviseUserMessageDelivery']>[1],
        deliveryStatus: 'delivered',
      ) {
        return coldLoadedChatEvents.reviseUserMessageDelivery(chatId, ids, deliveryStatus);
      },
    };
    const pendingInputs = new PendingUserInputService(chatMessageReader);

    const shareStore = new ShareStore(workspaceDir);
    await shareStore.init();

    const queue = new QueueManager(
      workspaceDir,
      agentRegistry,
      pendingInputs,
      chatEventAppender,
      (chatId) => queueDrainOptions(chatId, chatRegistry),
    );
    const commandLedger = new CommandLedger(workspaceDir);
    const chatCommands = new ChatCommandService({
      chats: chatRegistry,
      queue,
      ledger: commandLedger,
      settings,
      metadata,
      agents: agentRegistry,
      pendingInputs,
      forkChatFileCopy,
    });

    // Telegram notifications wire themselves to agent and queue events.
    const telegramSettings = new TelegramSettingsStore();
    await telegramSettings.init();
    const telegramNotifier = new TelegramNotifier(telegramSettings.getBotToken());
    // eslint-disable-next-line no-unused-vars
    const _attentionTracker = new AttentionTracker(agentRegistry, queue, settings, chatRegistry, chatMessageReader, telegramNotifier, telegramSettings);

    // Start agent runtime purge timers.
    agentRegistry.startPurgeTimers();

    // Recover stale chat queues from previous server runs.
    try {
      await queue.recoverStaleChatQueues();
    } catch (err) {
      logger.warn('queue: recovery error:', errorMessage(err));
    }

    // Build route and WS handler tables
    const routes = createAllRoutes({
      registry: chatRegistry,
      settings,
      queue,
      pathCache,
      metadata,
      chatEvents: chatEventPages,
      agents: agentRegistry,
      pendingInputs,
      telegramNotifier,
      telegramSettings,
      shareStore,
      apiProviders,
      chatCommands,
      modelCatalogResponseCache,
    });

    const chatHandler = new ChatHandler({
      agents: agentRegistry,
      queue,
      chatEvents: {
        ...chatEventPages,
        readReplay: (chatId, logId, afterAppendSeq) =>
          coldLoadedChatEvents.readReplay(chatId, logId, afterAppendSeq),
      },
      nativeReloader: chatNativeReloader,
      registry: chatRegistry,
      pendingInputs,
      commands: chatCommands,
    });
    const wsHandlers = {
      '/shell': shellManager.createHandler(),
      '/ws': chatHandler.createHandler(),
    };

    const listenPort = config.port;
    const bindAddress = config.bindAddress;
    const authDisabled = config.authDisabled;

    const serveOptions = {
      port: listenPort,
      hostname: bindAddress,
      idleTimeout: config.httpIdleTimeoutSeconds,
      maxConnections: config.maxConnections,
      maxRequestBodySize: config.maxRequestBodySize,
      routes: wrapRoutes(routes),
      error(error) {
        if (error instanceof MalformedJsonError) {
          return malformedJsonResponse();
        }
        logger.error('server: route error:', error);
        return jsonError('Internal server error', 500);
      },
      async fetch(request, server) {
        const url = new URL(request.url);

        if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
          const { pathname } = url;

          if (!isWsPath(pathname)) {
            return new Response('Not found', { status: 404 });
          }

          const token = url.searchParams.get('token') || request.headers.get('authorization')?.split(' ')[1];
          const isAuthorized = authDisabled ? true : await verifyAuthToken(token);
          if (!isAuthorized) {
            return new Response('Unauthorized', { status: 401 });
          }

          const upgraded = server.upgrade(request, {
            data: {
              pathname,
            },
          });
          if (!upgraded) {
            return new Response('WebSocket upgrade failed', { status: 400 });
          }
          return;
        }

        return new Response('Not found', { status: 404 });
      },
      websocket: {
        idleTimeout: config.wsIdleTimeoutSeconds,
        sendPings: true,
        backpressureLimit: config.wsBackpressureLimit,
        closeOnBackpressureLimit: true,
        maxPayloadLength: config.wsMaxPayloadLength,
        perMessageDeflate: true,
        open(ws) {
          if (server.pendingWebSockets > config.maxWsClients) {
            ws.close(1013, 'Server busy');
            return;
          }
          const handler = isWsPath(ws.data?.pathname) ? wsHandlers[ws.data.pathname] : null;
          if (handler) {
            handler.open(ws);
          } else {
            ws.close();
          }
        },
        async message(ws, message) {
          const handler = isWsPath(ws.data?.pathname) ? wsHandlers[ws.data.pathname] : null;
          if (!handler) return;
          const text = decodeWebSocketMessage(message);
          let data;
          try {
            data = JSON.parse(text);
          } catch {
            sendWebSocketJson(ws, new WsFaultMessage('Malformed JSON'));
            return;
          }
          await handler.message(ws, data);
        },
        close(ws, code, reason) {
          const handler = isWsPath(ws.data?.pathname) ? wsHandlers[ws.data.pathname] : null;
          if (!handler) return;
          handler.close(ws, code, reason);
        },
      },
    } satisfies ServeOptionsWithConnectionLimit;

    const server = Bun.serve<WsConnectionData>(serveOptions);

    // Broadcast helper: all event callbacks only fire when sessions are
    // active or routes are called, both of which happen after server is up.
    const broadcast = (payload: unknown) => server.publish('chat', JSON.stringify(payload));

    async function reviseDeliveredFromMetadata(
      chatId: string,
      metadata: { clientRequestId?: string; turnId?: string } | undefined,
    ): Promise<void> {
      const revised = await coldLoadedChatEvents.reviseUserMessageDelivery(
        chatId,
        {
          clientRequestId: metadata?.clientRequestId,
          turnId: metadata?.turnId,
        },
        'delivered',
      );
      if (!revised) return;
      broadcast(new ChatEventsMessage(
        chatId,
        revised.logId,
        [revised.event],
        metadata?.turnId,
        metadata?.clientRequestId,
      ));
    }

    async function reloadAfterProcessError(
      chatId: string,
      message: string,
      turnMetadata?: TurnEventMetadata,
    ): Promise<void> {
      streamFence.invalidate(chatId);
      try {
        const reload = await chatNativeReloader.reloadFromNative(chatId, 'process-error');
        pendingInputs.discardChat(chatId);
        broadcast(new ChatGenerationResetMessage(
          chatId,
          reload.logId,
          reload.events,
          reload.lastAppendSeq,
          reload.localNotice,
        ));
      } catch (err) {
        logger.warn('chat-events: process-error reload failed:', errorMessage(err));
        try {
          const reset = await chatEventLog.replaceGenerationFromCurrent(chatId, {
            localNotice: PROCESS_ERROR_RELOAD_FAILED_NOTICE,
          });
          pendingInputs.discardChat(chatId);
          broadcast(new ChatGenerationResetMessage(
            chatId,
            reset.logId,
            reset.events,
            reset.lastAppendSeq,
            reset.localNotice,
          ));
        } catch (resetErr) {
          logger.warn('chat-events: process-error fallback reset failed:', errorMessage(resetErr));
        }
      }
      broadcast(new AgentRunFailedMessage(
        chatId,
        message,
        turnMetadata?.turnId,
        turnMetadata?.clientRequestId,
        turnMetadata?.upstreamRequestId,
      ));
    }

    // Wire agent events to the event log before broadcasting.
    const chatExists = (chatId: string) => Boolean(chatRegistry.getChat(chatId));
    agentRegistry.onMessages((chatId, messages, turnMetadata) => {
      if (!chatExists(chatId)) return;
      const epoch = streamFence.capture(chatId);
      void (async () => {
        try {
          const parsed = parseChatMessages(messages);
          const appended = await coldLoadedChatEvents.appendMessages(chatId, parsed, 'agent', {
            guard: () => streamFence.isCurrent(chatId, epoch),
          });
          if (appended.skipped) return;
          if (parsed.length > 0) metadata.updateFromAppendedMessages(chatId, parsed);
          broadcast(new ChatEventsMessage(
            chatId,
            appended.logId,
            appended.events,
            turnMetadata?.turnId,
            turnMetadata?.clientRequestId,
            turnMetadata?.upstreamRequestId,
          ));
          await reviseDeliveredFromMetadata(chatId, turnMetadata);
          await pendingInputs.reconcile(chatId);
        } catch (err) {
          logger.warn('chat-events: append failed; reloading from native:', errorMessage(err));
          await reloadAfterProcessError(chatId, errorMessage(err), turnMetadata);
        }
      })();
    });
    agentRegistry.onProcessing((chatId, isProcessing) => {
      if (!chatExists(chatId)) return;
      broadcast(new ChatProcessingUpdatedMessage(chatId, isProcessing));
    });
    agentRegistry.onSessionCreated((chatId) => {
      if (!chatExists(chatId)) return;
      broadcast(new ChatSessionCreatedMessage(chatId));
    });
    agentRegistry.onFinished((chatId, exitCode, turnMetadata) => {
      if (!chatExists(chatId)) return;
      void reviseDeliveredFromMetadata(chatId, turnMetadata).catch((err) => {
        logger.warn('chat-events: delivery revision after finish failed:', errorMessage(err));
      });
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

    // Wire store events to broadcast. SettingsStore and ChatRegistry emit
    // domain events on mutation; server.js translates them to WS messages.
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
        const snapshot = await buildRemoteSettingsSnapshot({ settings, agents: agentRegistry, telegramSettings });
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
    chatRegistry.onChatRemoved((chatId) => {
      streamFence.clear(chatId);
      pendingInputs.clearChat(chatId, 'chat-removed');
      chatEventLog.deleteChatLog(chatId).catch((err) => {
        logger.warn('chat-events: failed to delete log on chat removal:', errorMessage(err));
      });
      broadcast(new ChatSessionDeletedWsMessage(chatId));
      shareStore.revokeShareByChatId(chatId).catch((err) => {
        logger.warn('share-store: failed to revoke share on chat removal:', errorMessage(err));
      });
    });
    chatRegistry.onChatReadUpdated((chatId, lastReadAt) => {
      if (typeof lastReadAt !== 'string') return;
      broadcast(new ChatReadUpdatedV1Message(chatId, lastReadAt));
    });

    // Wire queue events to broadcast.
    queue.onQueueUpdated((chatId, queueState) => {
      broadcast(new QueueStateUpdatedMessage(chatId, queueState));
    });
    queue.onDispatching((chatId, entryId, content) => {
      broadcast(new QueueDispatchingMessage(chatId, entryId, content));
    });
    queue.onChatEvents((chatId, logId, events, eventMetadata = {}) => {
      metadata.updateFromAppendedMessages(chatId, events.map((event) => event.message));
      broadcast(new ChatEventsMessage(
        chatId,
        logId,
        events,
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
      broadcast(new ChatSessionStoppedMessage(chatId, success));
    });
    queue.onTurnFailed((chatId, errorMessage, options = {}) => {
      void reloadAfterProcessError(chatId, errorMessage, options);
    });

    // Graceful shutdown: flush pending writes and clean up timers.
    let shuttingDown = false;
    const shutdown = async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      logger.info('server: shutting down...');
      try {
        const abortResult = await abortRunningSessionsWithTimeout({
          runningSessions: agentRegistry.getRunningSessions(),
          abortSession: (chatId) => agentRegistry.abortSession(chatId),
          onAbortError: (chatId, abortError) => {
            logger.warn(
              `server: abort during shutdown failed for ${chatId}:`,
              errorMessage(abortError),
            );
          },
        });
        if (abortResult.timedOut) {
          logger.warn(`server: shutdown abort wait timed out after ${abortResult.attempted} session(s)`);
        }
        agentRegistry.shutdown();
        shellManager.shutdown();
        await metadata.flush();
        await chatRegistry.flush();
      } catch (err) {
        logger.warn('server: shutdown cleanup error:', errorMessage(err));
      }
      process.exit(0);
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);

    logger.info(`Started at http://${bindAddress}:${server.port ?? listenPort}`);
    logger.info(`Authentication: ${authDisabled ? 'DISABLED' : 'ENABLED'}`);
    if (authDisabled && bindAddress !== '127.0.0.1' && bindAddress !== 'localhost') {
      logger.warn('WARNING: authentication is disabled while bound to a non-localhost address.');
    }
  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
}
