// Composition root. Instantiates all services and wires them together.
// This is the single place where dependencies are resolved.

import path from 'path';
import {
  getPort,
  getBindAddress,
  getMaxRequestBodySize,
  getMaxConnections,
  getMaxWsClients,
  getWsIdleTimeoutSeconds,
  getWsBackpressureLimit,
  getWsMaxPayloadLength,
  getHttpIdleTimeoutSeconds,
  getWorkspaceDir,
  isAuthDisabled,
} from './config.js';
import { decodeWebSocketMessage, sendWebSocketJson } from './ws/utils.js';
import { wrapRoutes } from './lib/http-route.js';
import { MalformedJsonError } from './lib/http-request.js';
import { verifyAuthToken } from './auth/token.js';
import { init as initAuthStore } from './auth/store.js';
import { forkChatFileCopy } from './chats/fork-chat.js';

// Classes
import { ChatRegistry } from './chats/store.js';
import { ShareStore } from './chats/share-store.js';
import { SettingsStore } from './settings/store.js';
import { QueueManager, queueDrainOptions } from './queue.js';
import { PathCache } from './chats/path-cache.js';
import { ShellManager } from './ws/shell.js';
import { MetadataIndex } from './chats/metadata-store.js';
import { HistoryCache } from './chats/history-cache.js';
import { PendingUserInputService } from './chats/pending-user-input-service.js';
import { AgentRegistry, createDefaultAgentSuite } from './agents/index.js';
import { ApiProviderStore } from './api-providers/store.js';
import { ApiProviderEndpointResolver } from './api-providers/endpoint-resolver.js';
import { ApiProviderService } from './api-providers/service.js';
import { CommandLedger } from './commands/command-ledger.js';
import { ChatCommandService } from './commands/chat-command-service.js';
import { ChatHandler } from './ws/chat.js';
import { TelegramNotifier } from './notifications/telegram.js';
import { TelegramSettingsStore } from './notifications/telegram-settings-store.js';
import { AttentionTracker } from './notifications/attention-tracker.js';
import {
  AgentRunOutputMessage,
  AgentRunFinishedMessage,
  AgentRunFailedMessage,
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

export async function startServer() {
  process.on('unhandledRejection', (err) => {
    console.error('unhandled rejection (non-fatal):', err?.message || err);
  });

  try {
    const workspaceDir = getWorkspaceDir();

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

    const historyCache = new HistoryCache(chatRegistry, metadata, agentRegistry);
    historyCache.init();
    const pendingInputs = new PendingUserInputService(historyCache);

    const shareStore = new ShareStore(workspaceDir);
    await shareStore.init();

    const queue = new QueueManager(
      workspaceDir,
      agentRegistry,
      pendingInputs,
      (chatId) => queueDrainOptions(chatId, chatRegistry),
    );
    const commandLedger = new CommandLedger(workspaceDir);
    const chatCommands = new ChatCommandService({
      chats: chatRegistry,
      queue,
      ledger: commandLedger,
    });

    // Telegram notifications wire themselves to agent and queue events.
    const telegramSettings = new TelegramSettingsStore();
    await telegramSettings.init();
    const telegramNotifier = new TelegramNotifier(telegramSettings.getBotToken());
    // eslint-disable-next-line no-unused-vars
    const _attentionTracker = new AttentionTracker(agentRegistry, queue, settings, chatRegistry, historyCache, telegramNotifier, telegramSettings);

    // Start agent runtime purge timers.
    agentRegistry.startPurgeTimers();

    // Recover stale chat queues from previous server runs.
    try {
      await queue.recoverStaleChatQueues();
    } catch (err) {
      console.warn('queue: recovery error:', err.message);
    }

    // Build route and WS handler tables
    const routes = createAllRoutes(
      chatRegistry, settings, queue, pathCache, metadata, historyCache,
      agentRegistry, commandLedger, pendingInputs, telegramNotifier, telegramSettings, shareStore, apiProviders, chatCommands,
    );

    const chatHandler = new ChatHandler(agentRegistry, queue, historyCache, chatRegistry, pendingInputs, {
      settings,
      metadata,
      forkChatFileCopy,
      forkAgentSession: agentRegistry.forkAgentSession.bind(agentRegistry),
    }, chatCommands);
    const wsHandlers = {
      '/shell': shellManager.createHandler(),
      '/ws': chatHandler.createHandler(),
    };

    const listenPort = getPort();
    const bindAddress = getBindAddress();
    const authDisabled = isAuthDisabled();

    const server = Bun.serve({
      port: listenPort,
      hostname: bindAddress,
      idleTimeout: getHttpIdleTimeoutSeconds(),
      maxConnections: getMaxConnections(),
      maxRequestBodySize: getMaxRequestBodySize(),
      routes: wrapRoutes(routes),
      error(error) {
        if (error instanceof MalformedJsonError) {
          return Response.json({ error: 'Malformed JSON' }, { status: 400 });
        }
        console.error('server: route error:', error);
        return Response.json({ error: 'Internal server error' }, { status: 500 });
      },
      async fetch(request, server) {
        const url = new URL(request.url);

        if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
          const { pathname } = url;

          if (!(pathname in wsHandlers)) {
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
        idleTimeout: getWsIdleTimeoutSeconds(),
        sendPings: true,
        backpressureLimit: getWsBackpressureLimit(),
        closeOnBackpressureLimit: true,
        maxPayloadLength: getWsMaxPayloadLength(),
        perMessageDeflate: true,
        open(ws) {
          if (server.pendingWebSockets > getMaxWsClients()) {
            ws.close(1013, 'Server busy');
            return;
          }
          const handler = wsHandlers[ws.data?.pathname];
          if (handler) {
            handler.open(ws);
          } else {
            ws.close();
          }
        },
        async message(ws, message) {
          const handler = wsHandlers[ws.data?.pathname];
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
          const handler = wsHandlers[ws.data?.pathname];
          if (!handler) return;
          handler.close(ws, code, reason);
        },
      },
    });

    // Broadcast helper: all event callbacks only fire when sessions are
    // active or routes are called, both of which happen after server is up.
    const broadcast = (payload) => server.publish('chat', JSON.stringify(payload));

    // Wire agent events to broadcast via AgentRegistry fan-out.
    // HistoryCache's init() already self-wired appendMessages via
    // agentRegistry.onMessages(), so only broadcast wiring is needed here.
    agentRegistry.onMessages((chatId, messages, metadata) => {
      broadcast(new AgentRunOutputMessage(chatId, messages, metadata?.turnId, metadata?.clientRequestId, metadata?.upstreamRequestId));
      pendingInputs.reconcile(chatId).catch((err) => {
        console.warn('pending-inputs: reconcile after messages failed:', err.message);
      });
    });
    agentRegistry.onProcessing((chatId, isProcessing) => {
      broadcast(new ChatProcessingUpdatedMessage(chatId, isProcessing));
    });
    agentRegistry.onSessionCreated((chatId) => {
      broadcast(new ChatSessionCreatedMessage(chatId));
    });
    agentRegistry.onFinished((chatId, exitCode, metadata) => {
      broadcast(new AgentRunFinishedMessage(chatId, exitCode, metadata?.turnId, metadata?.clientRequestId, metadata?.upstreamRequestId));
      pendingInputs.reconcile(chatId).catch((err) => {
        console.warn('pending-inputs: reconcile after finish failed:', err.message);
      });
      // Defer idle check to next microtask so the runtime has time to
      // clear its isRunning flag (emitFinished fires before the flag flip).
      queueMicrotask(() => {
        queue.checkChatIdle(chatId).catch((err) => {
          console.warn('queue: checkChatIdle error:', err.message);
        });
      });
    });
    agentRegistry.onFailed((chatId, errorMessage, metadata) => {
      if (metadata?.commandType === 'chat-start' && metadata.clientRequestId) {
        commandLedger.updateCommand('chat-start', chatId, metadata.clientRequestId, {
          status: 'failed',
          error: errorMessage,
        }).catch((err) => {
          console.warn('commands: failed to mark chat-start command failed:', err.message);
        });
      }
      broadcast(new AgentRunFailedMessage(chatId, errorMessage, metadata?.turnId, metadata?.clientRequestId, metadata?.upstreamRequestId));
      pendingInputs.reconcile(chatId).catch((err) => {
        console.warn('pending-inputs: reconcile after failure failed:', err.message);
      });
      queueMicrotask(() => {
        queue.checkChatIdle(chatId).catch((err) => {
          console.warn('queue: checkChatIdle error:', err.message);
        });
      });
    });

    // Wire store events to broadcast. SettingsStore and ChatRegistry emit
    // domain events on mutation; server.js translates them to WS messages.
    settings.onSessionNameChanged((chatId, title) => {
      broadcast(new ChatTitleUpdatedMessage(chatId, title));
    });
    settings.onListChanged((reason, chatId) => {
      broadcast(new ChatListRefreshRequestedMessage(reason, chatId));
    });
    const broadcastRemoteSettings = async () => {
      try {
        const snapshot = await buildRemoteSettingsSnapshot({ settings, agents: agentRegistry, telegramSettings });
        broadcast(new SettingsChangedMessage(snapshot));
      } catch (err) {
        console.warn('server: failed to broadcast settings-changed:', err.message);
      }
    };
    settings.onRemoteSettingsChanged(broadcastRemoteSettings);
    telegramSettings.onChanged(() => {
      telegramNotifier.setBotToken(telegramSettings.getBotToken());
      void broadcastRemoteSettings();
    });
    chatRegistry.onChatRemoved((chatId) => {
      pendingInputs.clearChat(chatId, 'chat-removed');
      broadcast(new ChatSessionDeletedWsMessage(chatId));
      shareStore.revokeShareByChatId(chatId).catch((err) => {
        console.warn('share-store: failed to revoke share on chat removal:', err.message);
      });
    });
    chatRegistry.onChatReadUpdated((chatId, lastReadAt) => {
      broadcast(new ChatReadUpdatedV1Message(chatId, lastReadAt));
    });

    // Wire queue events to broadcast.
    queue.onQueueUpdated((chatId, queueState) => {
      broadcast(new QueueStateUpdatedMessage(chatId, queueState));
    });
    queue.onDispatching((chatId, entryId, content) => {
      broadcast(new QueueDispatchingMessage(chatId, entryId, content));
    });
    pendingInputs.store.onUpdated((input) => {
      broadcast(new PendingUserInputUpdatedMessage(input));
    });
    pendingInputs.store.onCleared((chatId, clientRequestId, reason) => {
      broadcast(new PendingUserInputClearedMessage(chatId, clientRequestId, reason));
    });
    queue.onSessionStopped((chatId, success) => {
      broadcast(new ChatSessionStoppedMessage(chatId, success));
    });
    queue.onTurnFailed((chatId, errorMessage, options = {}) => {
      broadcast(new AgentRunFailedMessage(chatId, errorMessage, options.turnId, options.clientRequestId));
    });

    // Graceful shutdown: flush pending writes and clean up timers.
    let shuttingDown = false;
    const shutdown = async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log('server: shutting down...');
      try {
        const running = agentRegistry.getRunningSessions();
        for (const [, sessions] of Object.entries(running)) {
          for (const session of sessions) {
            if (session.id) {
              agentRegistry.abortSession(session.id).catch(() => {});
            }
          }
        }
        agentRegistry.shutdown();
        shellManager.shutdown();
        historyCache.destroy();
        await metadata.flush();
        await chatRegistry.flush();
      } catch (err) {
        console.warn('server: shutdown cleanup error:', err.message);
      }
      process.exit(0);
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);

    console.log('');
    console.log(`Started at http://${bindAddress}:${server.port ?? listenPort}`);
    console.log(`Authentication: ${authDisabled ? 'DISABLED' : 'ENABLED'}`);
    if (authDisabled && bindAddress !== '127.0.0.1' && bindAddress !== 'localhost') {
      console.warn('WARNING: authentication is disabled while bound to a non-localhost address.');
    }
    console.log('');
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}
