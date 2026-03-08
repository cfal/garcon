// Composition root. Instantiates all services and wires them together.
// This is the single place where dependencies are resolved.

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
import { wrapRoutes } from './lib/route-auth.js';
import { verifyWebSocketToken } from './middleware/auth.js';
import { init as initAuthStore } from './auth/store.js';
import { resolveMissingNativePath } from './chats/resolve-native-path.js';

// Classes
import { ChatRegistry } from './chats/store.js';
import { SettingsStore } from './settings/store.js';
import { QueueManager } from './queue.js';
import { PathCache } from './chats/path-cache.js';
import { ShellManager } from './ws/shell.js';
import { MetadataIndex } from './chats/metadata-store.js';
import { HistoryCache } from './chats/history-cache.js';
import { ClaudeProvider } from './providers/claude-cli.js';
import { CodexProvider } from './providers/codex.js';
import { OpenCodeProvider } from './providers/opencode.js';
import { ProviderRegistry } from './providers/index.js';
import { ChatHandler } from './ws/chat.js';
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
  WsFaultMessage,
} from '../common/ws-events.ts';

// Route factory
import createAllRoutes from './routes/index.js';

export async function startServer() {
  process.on('unhandledRejection', (err) => {
    console.error('unhandled rejection (non-fatal):', err?.message || err);
  });

  try {
    const workspaceDir = getWorkspaceDir();

    // Tier 0: Leaf modules (no inter-service dependencies)
    const chatRegistry = new ChatRegistry(workspaceDir);
    const settings = new SettingsStore(workspaceDir);
    const pathCache = new PathCache();
    const shellManager = new ShellManager();

    await initAuthStore();
    await chatRegistry.init();
    await chatRegistry.reconcileSessions(resolveMissingNativePath);
    await settings.init();

    await settings.reconcileWithRegistry(chatRegistry);

    // Tier 1: Standalone providers (EventEmitter-based, no deps)
    const claudeProvider = new ClaudeProvider();
    const codexProvider = new CodexProvider();
    const opencodeProvider = new OpenCodeProvider();

    // Tier 2: Provider registry wrapping providers + registry
    const providerRegistry = new ProviderRegistry(chatRegistry, claudeProvider, codexProvider, opencodeProvider);

    // Tier 3: Chat infrastructure (uses ProviderRegistry)
    const metadata = new MetadataIndex(chatRegistry, providerRegistry);
    await metadata.init();

    const historyCache = new HistoryCache(chatRegistry, metadata, providerRegistry);
    historyCache.init();

    const queue = new QueueManager(workspaceDir, providerRegistry, historyCache);

    // Start provider purge timers
    providerRegistry.startPurgeTimers();

    // Recover stale chat queues from previous server runs.
    try {
      await queue.recoverStaleChatQueues();
    } catch (err) {
      console.warn('queue: recovery error:', err.message);
    }

    // Build route and WS handler tables
    const routes = createAllRoutes(
      chatRegistry, settings, queue, pathCache, metadata, historyCache,
      providerRegistry, opencodeProvider,
    );

    const chatHandler = new ChatHandler(providerRegistry, queue, historyCache, chatRegistry);
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
        if (error.message === 'Malformed JSON') {
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
          const isAuthorized = authDisabled ? true : await verifyWebSocketToken(token);
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

    // Wire provider events to broadcast via ProviderRegistry fan-out.
    // HistoryCache's init() already self-wired appendMessages via
    // providers.onMessages(), so only broadcast wiring is needed here.
    providerRegistry.onMessages((chatId, messages) => {
      broadcast(new AgentRunOutputMessage(chatId, messages));
    });
    providerRegistry.onProcessing((chatId, isProcessing) => {
      broadcast(new ChatProcessingUpdatedMessage(chatId, isProcessing));
    });
    providerRegistry.onSessionCreated((chatId) => {
      broadcast(new ChatSessionCreatedMessage(chatId));
    });
    providerRegistry.onFinished((chatId, exitCode) => {
      broadcast(new AgentRunFinishedMessage(chatId, exitCode));
    });
    providerRegistry.onFailed((chatId, errorMessage) => {
      broadcast(new AgentRunFailedMessage(chatId, errorMessage));
    });

    // Wire store events to broadcast. SettingsStore and ChatRegistry emit
    // domain events on mutation; server.js translates them to WS messages.
    settings.onSessionNameChanged((chatId, title) => {
      broadcast(new ChatTitleUpdatedMessage(chatId, title));
    });
    settings.onListChanged((reason, chatId) => {
      broadcast(new ChatListRefreshRequestedMessage(reason, chatId));
    });
    chatRegistry.onChatRemoved((chatId) => {
      broadcast(new ChatSessionDeletedWsMessage(chatId));
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
    queue.onSessionStopped((chatId, success) => {
      broadcast(new ChatSessionStoppedMessage(chatId, success));
    });

    // Graceful shutdown: flush pending writes and clean up timers.
    let shuttingDown = false;
    const shutdown = async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log('server: shutting down...');
      try {
        historyCache.destroy();
        await chatRegistry.flush();
      } catch (err) {
        console.warn('server: shutdown cleanup error:', err.message);
      }
      process.exit(0);
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);

    console.log('');
    console.log(`Started at http://${bindAddress}:${listenPort}`);
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
