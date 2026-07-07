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
import { getWebSocketAuthToken, webSocketUpgradeHeaders } from './lib/websocket-auth.js';
import { init as initAuthStore } from './auth/store.js';
import { forkChatFileCopy } from './chats/fork-chat.js';
import { wireServerEvents } from './server-event-wiring.js';

// Classes
import { ChatRegistry } from './chats/store.js';
import { InMemoryLastSelectedChatState } from './chats/last-selected-chat-state.js';
import { ShareStore } from './chats/share-store.js';
import { SettingsStore } from './settings/store.js';
import { QueueManager, queueDrainOptions } from './queue.js';
import { PathCache } from './chats/path-cache.js';
import { ShellManager } from './ws/shell.js';
import { MetadataIndex } from './chats/metadata-store.js';
import { ChatViewStore } from './chats/chat-view-store.js';
import { ChatNativeReloader } from './chats/chat-native-reload.js';
import { PendingUserInputService } from './chats/pending-user-input-service.js';
import { ChatCarryOverStore, renderCarriedTranscript } from './chats/chat-carryover-store.js';
import { AgentRegistry, createDefaultAgentSuite } from './agents/index.js';
import { AgentDirectory } from './agents/directory.js';
import { AgentSwitchService } from './agents/agent-switch-service.js';
import { stripFirstUserSeed } from './agents/shared/transcript-seed.js';
import { ApiProviderStore } from './api-providers/store.js';
import { ApiProviderEndpointResolver } from './api-providers/endpoint-resolver.js';
import { ApiProviderService } from './api-providers/service.js';
import { CommandLedger } from './commands/command-ledger.js';
import { ChatCommandService } from './commands/chat-command-service.js';
import { KeyedPromiseLock } from './lib/keyed-lock.js';
import { ChatHandler } from './ws/chat.js';
import { TelegramNotifier } from './notifications/telegram.js';
import { TelegramSettingsStore } from './notifications/telegram-settings-store.js';
import { AttentionTracker } from './notifications/attention-tracker.js';
import { TelegramAttentionSink } from './notifications/telegram-attention-sink.js';
import { BrowserPushSettingsStore } from './notifications/browser-push-settings-store.js';
import { BrowserPushSubscriptionStore } from './notifications/browser-push-subscription-store.js';
import { BrowserPushNotifier } from './notifications/browser-push.js';
import { BrowserNotificationPresenceStore } from './notifications/browser-notification-presence.js';
import { BrowserPushAttentionSink } from './notifications/browser-push-attention-sink.js';
import { abortRunningSessionsWithTimeout, shutdownExitCode } from './lib/shutdown.js';
import { shouldRejectWebSocketUpgrade } from './lib/websocket-capacity.js';
import { migrateCursorStreamJsonSessionsToAcp } from './agents/cursor/cursor-acp-migration.js';
import { WsFaultMessage } from '../common/ws-events.ts';

// Route factory
import createAllRoutes from './routes/index.js';
import { ModelCatalogResponseCache } from './routes/model-catalog-cache.js';
import type { ShellWebSocketData } from './ws/shell.js';
import { createLogger } from './lib/log.js';
import { errorMessage } from './lib/errors.js';

const logger = createLogger('server');

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
    await migrateCursorStreamJsonSessionsToAcp(chatRegistry);
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

    // Durable prior-agent transcript snapshots for cross-agent continuation.
    const carryOver = new ChatCarryOverStore({
      filePath: path.join(workspaceDir, 'chat-carryover.json'),
    });
    await carryOver.init();
    carryOver.bindRegistry(chatRegistry);

    // Single per-chat mutation lock shared by every chat mutator so send/fork/
    // compaction/delete and agent switches serialize on the same `chat:<id>` key
    // and cannot race one another.
    const chatMutationLock = new KeyedPromiseLock();

    // Agent-switch coordinator: snapshots the outgoing transcript and stages a
    // fresh session under the new agent. Uses a directory built from the same
    // agent suite the registry wraps.
    const agentDirectory = new AgentDirectory(agentSuite.agents);
    const agentSwitch = new AgentSwitchService({
      registry: chatRegistry,
      directory: agentDirectory,
      endpointResolver,
      carryOver,
      chatMutationLock,
    });

    const chatViews = new ChatViewStore((chatId) => agentRegistry.isChatRunning(chatId));
    // Prepends carried-over segments, interleaved with agent-switch boundary
    // markers, and strips the seed from the new session's first user turn so a
    // switched chat shows its full history once and only once.
    const loadNativeMessages = async (chatId: string) => {
      const session = chatRegistry.getChat(chatId);
      if (!session) return [];
      const native = await agentRegistry.loadMessages(session, chatId);
      const segments = carryOver.getSegments(chatId);
      if (segments.length === 0) return native;
      const carried = renderCarriedTranscript(segments, {
        agentId: session.agentId,
        model: session.model,
      });
      return [...carried, ...stripFirstUserSeed(native)];
    };
    const chatNativeReloader = new ChatNativeReloader(
      chatViews,
      { loadNativeMessages },
      (chatId) => agentRegistry.isChatRunning(chatId),
    );
    const chatMessageReader = {
      async ensureLoaded(chatId: string) {
        return chatViews.getOrCreateMessages(chatId, () => loadNativeMessages(chatId));
      },
      getMessages(chatId: string) {
        return chatViews.getLoadedMessages(chatId);
      },
    };
    const chatViewPages = {
      async getOrCreatePage(chatId: string, limit: number, beforeSeq?: number) {
        return chatViews.getOrCreatePage(chatId, () => loadNativeMessages(chatId), limit, beforeSeq);
      },
    };
    const chatMessageAppender = {
      async appendMessages(
        chatId: string,
        messages: Parameters<ChatViewStore['appendAfterEnsuringGeneration']>[2],
      ) {
        return chatViews.appendAfterEnsuringGeneration(chatId, () => loadNativeMessages(chatId), messages);
      },
    };
    const pendingInputs = new PendingUserInputService(chatMessageReader);

    const shareStore = new ShareStore(workspaceDir);
    await shareStore.init();

    const queue = new QueueManager(
      workspaceDir,
      agentRegistry,
      pendingInputs,
      chatMessageAppender,
      (chatId) => queueDrainOptions(chatId, chatRegistry),
    );
    const commandLedger = new CommandLedger(workspaceDir);
    const lastSelectedChat = new InMemoryLastSelectedChatState();
    const chatCommands = new ChatCommandService({
      chats: chatRegistry,
      queue,
      ledger: commandLedger,
      settings,
      metadata,
      agents: agentRegistry,
      pendingInputs,
      nativeMessages: { loadNativeMessages },
      forkChatFileCopy,
      carryOver,
      chatMutationLock,
    });

    // Telegram notifications wire themselves to agent and queue events.
    const telegramSettings = new TelegramSettingsStore();
    await telegramSettings.init();
    const telegramNotifier = new TelegramNotifier(telegramSettings.getBotToken());
    const browserPushSettings = new BrowserPushSettingsStore();
    await browserPushSettings.init();
    const browserPushSubscriptions = new BrowserPushSubscriptionStore(workspaceDir);
    await browserPushSubscriptions.init();
    const browserPresence = new BrowserNotificationPresenceStore();
    const browserPushNotifier = new BrowserPushNotifier(browserPushSettings.getVapidKeys());
    // eslint-disable-next-line no-unused-vars
    const _attentionTracker = new AttentionTracker(
      agentRegistry,
      queue,
      settings,
      chatRegistry,
      chatMessageReader,
      [
        new TelegramAttentionSink({ settings, telegram: telegramNotifier, telegramSettings }),
        new BrowserPushAttentionSink({
          settings,
          subscriptions: browserPushSubscriptions,
          presence: browserPresence,
          notifier: browserPushNotifier,
        }),
      ],
    );

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
      chatViews: chatViewPages,
      agents: agentRegistry,
      pendingInputs,
      telegramNotifier,
      telegramSettings,
      browserPushSettings,
      browserPushSubscriptions,
      browserPushNotifier,
      shareStore,
      apiProviders,
      chatCommands,
      agentSwitch,
      modelCatalogResponseCache,
      lastSelectedChat,
    });

    const chatHandler = new ChatHandler({
      agents: agentRegistry,
      chatViews: {
        ...chatViewPages,
        readReplay: (chatId, generationId, afterSeq) =>
          chatViews.readReplay(chatId, generationId, afterSeq),
      },
      nativeReloader: chatNativeReloader,
      registry: chatRegistry,
      browserPresence,
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

          const token = getWebSocketAuthToken(request);
          const isAuthorized = authDisabled ? true : await verifyAuthToken(token);
          if (!isAuthorized) {
            return new Response('Unauthorized', { status: 401 });
          }

          if (shouldRejectWebSocketUpgrade(server.pendingWebSockets, config.maxWsClients)) {
            return new Response('Server busy', { status: 503 });
          }

          const upgradeOptions: { data: WsConnectionData; headers?: HeadersInit } = {
            data: {
              pathname,
            },
          };
          const headers = webSocketUpgradeHeaders(request);
          if (headers) upgradeOptions.headers = headers;

          const upgraded = server.upgrade(request, upgradeOptions);
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
          // Handles races where multiple upgrades pass the pre-upgrade capacity
          // check before Bun increments pendingWebSockets.
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

    wireServerEvents({
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
    });

    // Graceful shutdown: flush pending writes and clean up timers.
    let shuttingDown = false;
    const shutdown = async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      logger.info('server: shutting down...');
      let abortTimedOut = false;
      let cleanupFailed = false;
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
          abortTimedOut = true;
          logger.warn(`server: shutdown abort wait timed out after ${abortResult.attempted} session(s)`);
        }
        agentRegistry.shutdown();
        shellManager.shutdown();
        await metadata.flush();
        await carryOver.flush();
        await chatRegistry.flush();
      } catch (err) {
        cleanupFailed = true;
        logger.warn('server: shutdown cleanup error:', errorMessage(err));
      }
      process.exit(shutdownExitCode({ abortTimedOut, cleanupFailed }));
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
