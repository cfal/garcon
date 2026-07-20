// Composition root. Instantiates all services and wires them together.
// This is the single place where dependencies are resolved.

import path from 'path';
import { initializeServerConfig } from './config.js';
import { decodeWebSocketMessage, sendWebSocketJson } from './ws/utils.js';
import { wrapRoutes } from './lib/http-route.js';
import { malformedJsonResponse } from './lib/json-route.js';
import { MalformedJsonError } from './lib/http-request.js';
import { jsonError } from './lib/http-error.js';
import { verifyAuthTokenClaims } from './auth/token.js';
import {
  getWebSocketAuthToken,
  webSocketUpgradeHeaders,
} from './lib/websocket-auth.js';
import { init as initAuthStore } from './auth/store.js';
import { forkChatFileCopy, rollbackForkTarget } from './chats/fork-chat.js';
import { wireServerEvents } from './server-event-wiring.js';
import { startExecutionControlPlane } from './execution-control-plane.js';

// Classes
import { ChatRegistry } from './chats/store.js';
import { ChatIdAllocator } from './chats/chat-id-allocator.js';
import { migrateWorkspaceChatIds } from './chats/chat-id-migration.js';
import { InMemoryLastSelectedChatState } from './chats/last-selected-chat-state.js';
import { ShareStore } from './chats/share-store.js';
import { SettingsStore } from './settings/store.js';
import {
  ChatExecutionCoordinator,
  queueDrainOptions,
} from './chat-execution/chat-execution-coordinator.js';
import { PathCache } from './chats/path-cache.js';
import { TerminalManager } from './terminals/terminal-manager.js';
import { TerminalStreamHandler } from './ws/terminal-stream.js';
import { PrimaryWsHandler } from './ws/primary.js';
import {
  PRIMARY_WEBSOCKET_TRANSPORT_OPTIONS,
  publishWebSocketPayload,
  type WebSocketMessagePublisher,
} from './ws/transport.js';
import { MetadataIndex } from './chats/metadata-store.js';
import { ChatViewStore } from './chats/chat-view-store.js';
import { ChatExecutionActivity } from './chats/chat-execution-activity.js';
import { ChatNativeReloader } from './chats/chat-native-reload.js';
import { TranscriptSearchController } from './chats/search/controller.js';
import { TranscriptSearchSettingsCoordinator } from './chats/search/settings-coordinator.js';
import { PendingUserInputService } from './chats/pending-user-input-service.js';
import { PendingUserInputRecoveryCoordinator } from './chats/pending-user-input-recovery.js';
import {
  ChatCarryOverStore,
  renderCarriedTranscript,
} from './chats/chat-carryover-store.js';
import { AgentRegistry } from './agents/index.js';
import { AgentDirectory } from './agents/directory.js';
import { AgentSwitchService } from './agents/agent-switch-service.js';
import { stripFirstUserSeed } from '@garcon/common/transcript-seed';
import { defaultAgentIntegrations } from './agents/default-agent-integrations.js';
import { IntegrationHostFactory } from './agents/integration-host.js';
import { IntegrationRegistry } from './agents/integration-registry.js';
import { FileAgentMigrationStore } from './agents/integration-migration-store.js';
import { migrateAgentIntegrationCoreRecords } from './agents/core-record-migration.js';
import { toAgentChatReference } from './agents/integration-chat-reference.js';
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
import {
  abortRunningSessionsWithTimeout,
  shutdownExitCode,
  waitForShutdownPhasesWithTimeout,
} from './lib/shutdown.js';
import { WebSocketAdmissionController } from './lib/websocket-capacity.js';
import { WsFaultMessage } from '../common/ws-events.ts';
import { AgentIntegrationError } from '@garcon/server-agent-interface';
import { TranscriptSearchService } from '@garcon/server-agent-common/search/transcript-search-service';
import { ScheduledPromptStore } from './scheduled-prompts/store.js';
import { ScheduledPromptRunLog } from './scheduled-prompts/run-log.js';
import { ScheduledPromptDispatcher } from './scheduled-prompts/dispatcher.js';
import { ScheduledPromptScheduler } from './scheduled-prompts/scheduler.js';
import { ChatListProjector } from './chats/chat-list-projector.js';
import { AgentOwnershipJournal } from './chats/agent-ownership-journal.js';
import { SnippetStore } from './snippets/store.js';
import {
  SnippetProjectPathService,
  SnippetService,
} from './snippets/service.js';

// Route factory
import createAllRoutes from './routes/index.js';
import { ModelCatalogResponseCache } from './routes/model-catalog-cache.js';
import { createLogger } from './lib/log.js';
import { errorMessage } from './lib/errors.js';
import { acquireWorkspaceLease, type WorkspaceLease } from './lib/workspace-lease.js';
import {
  LOCAL_SERVER_PRINCIPAL,
  type ServerPrincipal,
} from './lib/http-route-types.js';

const logger = createLogger('server');

interface WsConnectionData {
  connectionId: string;
  principal: ServerPrincipal;
}

type ServeOptionsWithConnectionLimit = Parameters<
  typeof Bun.serve<WsConnectionData>
>[0] & {
  maxConnections?: number;
};

export async function startServer(): Promise<void> {
  process.on('unhandledRejection', (err: unknown) => {
    logger.error('unhandled rejection (non-fatal):', errorMessage(err));
  });

  let workspaceLease: WorkspaceLease | null = null;
  try {
    const config = initializeServerConfig();
    workspaceLease = await acquireWorkspaceLease(config.workspaceDir, {
      onCompromised(error) {
        logger.error('Workspace lease was compromised:', errorMessage(error));
        process.kill(process.pid, 'SIGTERM');
      },
    });
    const workspaceDir = workspaceLease.workspaceDir;
    const chatIdMigration = await migrateWorkspaceChatIds(workspaceDir);
    const migratedChatIdCount = Object.keys(
      chatIdMigration.migratedChatIds,
    ).length;
    if (migratedChatIdCount > 0) {
      logger.info(
        `migrated ${migratedChatIdCount} legacy chat ID(s) across ${chatIdMigration.changedFiles.length} persisted file(s)`,
      );
    }

    // Leaf modules with no inter-service dependencies.
    const chatRegistry = new ChatRegistry(workspaceDir);
    const settings = new SettingsStore(workspaceDir);
    const pathCache = new PathCache();
    const terminalManager = new TerminalManager();
    const terminalStream = new TerminalStreamHandler(terminalManager);
    const wsAdmission = new WebSocketAdmissionController(config.maxWsClients);

    await initAuthStore();

    // User-managed API provider store and resolver.
    const apiProviderStore = new ApiProviderStore();
    await apiProviderStore.init();

    const carryOver = new ChatCarryOverStore({
      filePath: path.join(workspaceDir, 'chat-carryover.json'),
    });
    await carryOver.init();

    const integrationHostFactory = new IntegrationHostFactory({
      workspaceDir,
      async resolveCredential({ reference, signal }) {
        signal.throwIfAborted();
        const resolved = apiProviderStore.getEndpoint(reference.endpointId);
        if (!resolved || resolved.apiProvider.id !== reference.apiProviderId) return null;
        return { kind: 'api-key', value: resolved.endpoint.apiKey };
      },
      async loadCarryOver(request) {
        request.signal.throwIfAborted();
        const revision = carryOver.getRevision(request.chatId);
        if (revision !== request.expectedRevision) {
          throw new AgentIntegrationError(
            'SOURCE_REVISION_CHANGED',
            `Carry-over revision changed for chat ${request.chatId}`,
            true,
          );
        }
        return {
          revision,
          messages: renderCarriedTranscript(carryOver.getSegments(request.chatId), {
            agentId: request.currentAgentId,
            model: request.currentModel,
          }),
        };
      },
    });
    const integrationRegistry = new IntegrationRegistry({
      integrations: defaultAgentIntegrations,
      hostFactory: integrationHostFactory,
      migrationStoreFor: (agentId) => new FileAgentMigrationStore(workspaceDir, agentId),
    });
    const endpointResolver = new ApiProviderEndpointResolver(
      () => apiProviderStore.list(),
      (agentId) => integrationRegistry.get(agentId)?.descriptor.supportedEndpointProtocols ?? [],
    );
    await migrateAgentIntegrationCoreRecords({ workspaceDir, integrations: integrationRegistry });
    await chatRegistry.init();
    await settings.init();
    carryOver.bindRegistry(chatRegistry);
    await integrationRegistry.start();
    const agentOwnership = new AgentOwnershipJournal({
      workspaceDir,
      registry: chatRegistry,
      carryOver,
      integrations: integrationRegistry,
    });
    await agentOwnership.initialize();
    const apiProviders = new ApiProviderService({
      store: apiProviderStore,
      isApiProviderReferenced(apiProviderId) {
        return Object.values(chatRegistry.listAllChats()).some(
          (entry) => entry.apiProviderId === apiProviderId,
        );
      },
    });
    const modelCatalogResponseCache = new ModelCatalogResponseCache();

    // Every chat mutation shares one lock, including live settings changes.
    const chatMutationLock = new KeyedPromiseLock();

    // Agent registry wraps runtimes, persisted chat state, and endpoint selection.
    const agentRegistry = new AgentRegistry({
      registry: chatRegistry,
      integrations: integrationRegistry,
      endpointResolver,
      getCarryOverRevision: (chatId) => carryOver.getRevision(chatId),
      loadCarryOver: (chatId, entry) => renderCarriedTranscript(carryOver.getSegments(chatId), {
        agentId: entry.agentId,
        model: entry.model ?? '',
      }),
      chatMutationLock,
    });

    await chatRegistry.reconcileSessions((session, chatId) =>
      agentRegistry.resolveNativeSession(session, chatId),
    );
    await settings.reconcileWithRegistry(chatRegistry);

    // Chat infrastructure uses the agent registry through narrow injected APIs.
    const metadata = new MetadataIndex(chatRegistry, agentRegistry, {
      metadataPath: path.join(workspaceDir, 'chat-metadata.json'),
    });
    await metadata.init();

    // Agent-switch coordinator: snapshots the outgoing transcript and stages a
    // fresh session under the new agent. Uses a directory built from the same
    // agent suite the registry wraps.
    const agentDirectory = new AgentDirectory(integrationRegistry);
    const agentSwitch = new AgentSwitchService({
      registry: chatRegistry,
      directory: agentDirectory,
      endpointResolver,
      carryOver,
      ownership: agentOwnership,
      chatMutationLock,
    });

    const chatExecutionActivity = new ChatExecutionActivity(agentRegistry);
    const chatViews = new ChatViewStore(chatExecutionActivity.isActive);
    const chatViewPruneTimer = setInterval(() => chatViews.prune(), 60_000);
    chatViewPruneTimer.unref();
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
    const loadNativeMessagePage = async (chatId: string, limit: number, offset: number) => {
      const session = chatRegistry.getChat(chatId);
      // Falls back to the composite full loader because carried segments and the
      // stripped continuation seed do not share the native transcript's offsets.
      if (!session || carryOver.getSegments(chatId).length > 0) return null;
      return agentRegistry.loadMessagePage(session, limit, offset, chatId);
    };
    const chatNativeReloader = new ChatNativeReloader(
      chatViews,
      { loadNativeMessages },
      chatExecutionActivity.isActive,
    );
    const transcriptSearchService = new TranscriptSearchService({
      workspaceDirectory: workspaceDir,
      logger,
      openCarryOverStream: (request) => carryOver.openSearchStream(request),
    });
    const chatSearch = new TranscriptSearchController({
      integrations: integrationRegistry,
      service: transcriptSearchService,
      listChats: () => Object.entries(chatRegistry.listAllChats()).flatMap(([chatId, session]) => {
        const integration = integrationRegistry.get(session.agentId);
        if (!integration) return [];
        return [{
          agentId: session.agentId,
          reference: toAgentChatReference(
            integration,
            chatId,
            session,
            carryOver.getRevision(chatId),
          ),
          updatedAt: metadata.getChatMetadata(chatId)?.lastActivity ?? null,
        }];
      }),
    });
    try {
      await chatSearch.initialize(
        settings.getFeatureSettings().transcriptSearch.enabled,
      );
    } catch {
      logger.warn('Transcript search admission failed; server startup will continue.', {
        code: 'SEARCH_INDEX_ADMISSION_FAILED',
      });
    }
    const transcriptSearchSettings = new TranscriptSearchSettingsCoordinator(
      settings,
      chatSearch,
    );

    const indexedNativeReloader: Pick<ChatNativeReloader, 'reloadFromNative'> = {
      async reloadFromNative(chatId, mode, processErrorReason) {
        const reload = await chatNativeReloader.reloadFromNative(chatId, mode, processErrorReason);
        chatSearch.markDirty(chatId);
        return reload;
      },
    };
    const chatMessageReader = {
      loadNativeMessages,
      getMessages(chatId: string) {
        return chatViews.getLoadedMessages(chatId);
      },
      getRetainedHistoryMessages(chatId: string) {
        return chatViews.getRetainedHistoryMessages(chatId);
      },
      hasCompleteHistory(chatId: string) {
        return chatViews.getLoadedMessages(chatId) !== null;
      },
    };
    const chatViewPages = {
      isChatActive(chatId: string) {
        return chatExecutionActivity.isActive(chatId);
      },
      async getOrCreatePage(chatId: string, limit: number, beforeSeq?: number) {
        return chatViews.getOrCreatePage(
          chatId,
          {
            loadAll: () => loadNativeMessages(chatId),
            loadPage: (limit, offset) => loadNativeMessagePage(chatId, limit, offset),
          },
          limit,
          beforeSeq,
        );
      },
      async reconcileNativeSnapshot(
        chatId: string,
        messages: Parameters<ChatViewStore['reconcileNativeSnapshot']>[1],
      ) {
        await chatViews.reconcileNativeSnapshot(chatId, messages);
      },
    };
    const chatMessageAppender = {
      async appendMessages(
        chatId: string,
        messages: Parameters<ChatViewStore['appendAfterEnsuringGeneration']>[2],
      ) {
        return chatViews.appendAfterEnsuringGeneration(
          chatId,
          () => loadNativeMessages(chatId),
          messages,
        );
      },
    };
    const pendingInputs = new PendingUserInputService(chatMessageReader);

    const shareStore = new ShareStore(workspaceDir);
    await shareStore.init();

    const queue = new ChatExecutionCoordinator(
      workspaceDir,
      agentRegistry,
      pendingInputs,
      chatMessageAppender,
      (chatId) => queueDrainOptions(chatId, chatRegistry),
      (chatId) => Boolean(chatRegistry.getChat(chatId)),
    );
    chatExecutionActivity.attachReservedExecutions(queue);
    const commandLedger = new CommandLedger(workspaceDir);
    const interruptedSessionControls = await commandLedger.listRestartInterruptedSessionControls();
    for (const record of interruptedSessionControls) {
      if (record.commandType === 'agent-stop' && chatRegistry.getChat(record.chatId)) {
        await queue.pauseChatQueue(record.chatId);
      }
      const settled = await commandLedger.settleRestartInterruptedSessionControl(record.key);
      if (!settled) {
        throw new Error(`Could not settle interrupted ${record.commandType} for ${record.chatId}`);
      }
      logger.warn(`${record.commandType}: recovered interrupted command for ${record.chatId}`);
    }
    const forkPreparations = await commandLedger.listForkPreparationsPendingRecovery();
    for (const record of forkPreparations) {
      const preparation = record.forkPreparation!;
      const sourceChatId = preparation.sourceChatId;
      pendingInputs.clearChat(record.chatId, 'chat-removed');
      await queue.deleteChatQueueFile(record.chatId).catch(() => undefined);
      await rollbackForkTarget({
        sourceChatId,
        targetChatId: record.chatId,
        registry: chatRegistry,
        settings,
        ownership: agentOwnership,
        sourceNextForkOrdinal: preparation.sourceNextForkOrdinal,
      });
      await commandLedger.settleForkPreparationRecovery(record.key);
      logger.warn(`fork-run: removed interrupted pre-schedule target ${record.chatId}`);
    }
    const pendingRecovery = new PendingUserInputRecoveryCoordinator(
      {
        ledger: commandLedger,
        pendingInputs,
        nativeSnapshots: chatViewPages,
        queuedInputHandoffs: queue,
        chatExists: (chatId) => Boolean(chatRegistry.getChat(chatId)),
        onRecoveredChatSettled: async (chatId) => {
          await queue.dropRecoveredInputContinuation(chatId);
        },
      },
      (error) => {
        logger.warn('pending-inputs: failed to settle durable recovery:', errorMessage(error));
      },
    );
    pendingRecovery.start();
    const pendingRecoveryResult = await pendingRecovery.restore();
    if (pendingRecoveryResult.restored > 0 || pendingRecoveryResult.discardedMissingChat > 0) {
      logger.warn(
        `pending-inputs: restart recovery restored=${pendingRecoveryResult.restored} missingChats=${pendingRecoveryResult.discardedMissingChat}`,
      );
    }
    const lastSelectedChat = new InMemoryLastSelectedChatState();
    const chatIds = new ChatIdAllocator(chatRegistry);
    const chatListProjector = new ChatListProjector({
      registry: chatRegistry,
      settings,
      metadata,
      agents: agentRegistry,
      pathCache,
    });
    const chatCommands = new ChatCommandService({
      chats: chatRegistry,
      queue,
      ledger: commandLedger,
      settings,
      metadata,
      agents: agentRegistry,
      pendingInputs,
      forkChatFileCopy,
      carryOver,
      chatIds,
      chatListProjector,
      pathCache,
      ownership: agentOwnership,
      chatMutationLock,
    });

    const scheduledPromptStore = new ScheduledPromptStore(workspaceDir);
    const scheduledPromptRunLog = new ScheduledPromptRunLog();
    const scheduledPrompts = new ScheduledPromptScheduler({
      store: scheduledPromptStore,
      runLog: scheduledPromptRunLog,
      dispatcher: new ScheduledPromptDispatcher({
        commands: chatCommands,
      }),
      chats: chatRegistry,
      agents: agentRegistry,
    });

    const snippetStore = new SnippetStore(workspaceDir);
    await snippetStore.init();
    const snippets = new SnippetService({
      store: snippetStore,
      chats: chatRegistry,
      projectPaths: new SnippetProjectPathService(),
    });

    // Telegram notifications wire themselves to agent and queue events.
    const telegramSettings = new TelegramSettingsStore();
    await telegramSettings.init();
    const telegramNotifier = new TelegramNotifier(
      telegramSettings.getBotToken(),
    );
    // eslint-disable-next-line no-unused-vars
    const _attentionTracker = new AttentionTracker(
      agentRegistry,
      queue,
      settings,
      chatRegistry,
      chatMessageReader,
      telegramNotifier,
      telegramSettings,
    );

    let webSocketPublisher: WebSocketMessagePublisher | null = null;
    const eventWiring = await startExecutionControlPlane({
      wireEvents: () => wireServerEvents({
        server: {
          publish(topic, payload) {
            if (!webSocketPublisher) return;
            return publishWebSocketPayload(webSocketPublisher, topic, payload);
          },
        },
        agentRegistry,
        chatRegistry,
        settings,
        queue,
        metadata,
        chatViews,
        chatNativeReloader: indexedNativeReloader,
        pendingInputs,
        pendingRecovery,
        commandLedger,
        shareStore,
        telegramNotifier,
        telegramSettings,
        scheduledPrompts,
        snippets,
        loadNativeMessages,
        searchIndex: chatSearch,
      }),
      recoverControls: () => queue.recoverChatExecutionControls(
        new Set(pendingRecoveryResult.restoredChatIds),
      ),
      activateRecoveredSettlement: () => pendingRecovery.activateRecoveredChatSettlement(),
      startScheduledPrompts: () => scheduledPrompts.start(),
    });

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
      pendingInputRecovery: pendingRecovery,
      telegramNotifier,
      telegramSettings,
      shareStore,
      apiProviders,
      chatCommands,
      chatListProjector,
      agentSwitch,
      modelCatalogResponseCache,
      lastSelectedChat,
      scheduledPrompts,
      snippets,
      terminals: terminalManager,
      searchIndex: chatSearch,
      transcriptSearchSettings,
    });

    const chatHandler = new ChatHandler({
      agents: agentRegistry,
      chatViews: {
        ...chatViewPages,
        readReplay: (chatId, generationId, afterSeq) =>
          chatViews.readReplay(chatId, generationId, afterSeq),
      },
      nativeReloader: indexedNativeReloader,
      queue,
      pendingInputs,
      registry: chatRegistry,
    });
    const primaryWs = new PrimaryWsHandler(chatHandler, terminalStream);

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
          if (url.pathname !== '/ws') {
            return new Response('Not found', { status: 404 });
          }

          const token = getWebSocketAuthToken(request);
          const claims = authDisabled
            ? null
            : await verifyAuthTokenClaims(token);
          const principal: ServerPrincipal | null = authDisabled
            ? LOCAL_SERVER_PRINCIPAL
            : claims
              ? {
                  mode: 'authenticated',
                  key: claims.username,
                  username: claims.username,
                  expiresAtMs: claims.expiresAtMs,
                }
              : null;
          if (!principal) {
            return new Response('Unauthorized', { status: 401 });
          }

          const connectionId = crypto.randomUUID();
          const admission = wsAdmission.tryReserve(connectionId);
          if (!admission.ok)
            return new Response(admission.reason, { status: 503 });

          const upgradeOptions: {
            data: WsConnectionData;
            headers?: HeadersInit;
          } = {
            data: {
              connectionId,
              principal,
            },
          };
          const headers = webSocketUpgradeHeaders(request);
          if (headers) upgradeOptions.headers = headers;

          let upgraded: boolean;
          try {
            upgraded = server.upgrade(request, upgradeOptions);
          } catch (error) {
            wsAdmission.release(connectionId);
            throw error;
          }
          if (!upgraded) {
            wsAdmission.release(connectionId);
            return new Response('WebSocket upgrade failed', { status: 400 });
          }
          return;
        }

        return new Response('Not found', { status: 404 });
      },
      websocket: {
        ...PRIMARY_WEBSOCKET_TRANSPORT_OPTIONS,
        idleTimeout: config.wsIdleTimeoutSeconds,
        sendPings: true,
        backpressureLimit: config.wsBackpressureLimit,
        closeOnBackpressureLimit: true,
        maxPayloadLength: config.wsMaxPayloadLength,
        open(ws) {
          const admission = wsAdmission.confirm(ws.data.connectionId);
          if (!admission.ok) {
            ws.close(1013, admission.reason);
            return;
          }
          primaryWs.open(ws);
        },
        async message(ws, message) {
          const text = decodeWebSocketMessage(message);
          let data;
          try {
            data = JSON.parse(text);
          } catch {
            sendWebSocketJson(ws, new WsFaultMessage('Malformed JSON'));
            return;
          }
          try {
            await primaryWs.message(ws, data);
          } catch (error) {
            logger.error('primary WebSocket message failed:', error);
            sendWebSocketJson(ws, new WsFaultMessage('WebSocket operation failed'));
          }
        },
        drain(ws) {
          primaryWs.drain(ws);
        },
        close(ws, code, reason) {
          try {
            primaryWs.close(ws, code, reason);
          } finally {
            wsAdmission.release(ws.data.connectionId);
          }
        },
      },
    } satisfies ServeOptionsWithConnectionLimit;

    const server = Bun.serve<WsConnectionData>(serveOptions);
    webSocketPublisher = server;

    // Graceful shutdown: flush pending writes and clean up timers.
    let shuttingDown = false;
    const shutdown = async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      logger.info('server: shutting down...');
      const reservedChatIds = queue.beginShutdown();
      let abortTimedOut = false;
      let cleanupFailed = false;
      try {
        pendingRecovery.beginShutdown();
        await server.stop(true);
        clearInterval(chatViewPruneTimer);
        scheduledPrompts.stop();
        const abortResult = await abortRunningSessionsWithTimeout({
          runningSessions: agentRegistry.getRunningSessions(),
          additionalChatIds: reservedChatIds,
          abortSession: (chatId) => queue.abortForShutdown(chatId),
          onAbortError: (chatId, abortError) => {
            logger.warn(
              `server: abort during shutdown failed for ${chatId}:`,
              errorMessage(abortError),
            );
          },
        });
        if (abortResult.timedOut) {
          abortTimedOut = true;
          logger.warn(
            `server: shutdown abort wait timed out after ${abortResult.attempted} session(s)`,
          );
        }
        const backgroundTasks = await waitForShutdownPhasesWithTimeout([
          () => chatCommands.waitForBackgroundTasks(),
          () => queue.waitForExecutionOwners(),
          () => eventWiring.waitForIdle(),
          () => pendingRecovery.waitForBackgroundTasks(),
        ]);
        if (!backgroundTasks.completed) {
          cleanupFailed = true;
          logger.warn('server: shutdown background phases timed out');
        }
        for (const backgroundError of backgroundTasks.errors) {
          cleanupFailed = true;
          logger.warn('server: shutdown background-task error:', errorMessage(backgroundError));
        }
        await chatSearch.close();
        await integrationRegistry.stop();
        terminalManager.shutdown();
        await metadata.flush();
        await carryOver.flush();
        await chatRegistry.flush();
      } catch (err) {
        cleanupFailed = true;
        logger.warn('server: shutdown cleanup error:', errorMessage(err));
      } finally {
        try {
          await workspaceLease?.release();
        } catch (err) {
          cleanupFailed = true;
          logger.warn('server: workspace lease release error:', errorMessage(err));
        }
        workspaceLease = null;
      }
      process.exit(shutdownExitCode({ abortTimedOut, cleanupFailed }));
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);

    logger.info(
      `Started at http://${bindAddress}:${server.port ?? listenPort}`,
    );
    logger.info(`Authentication: ${authDisabled ? 'DISABLED' : 'ENABLED'}`);
    if (
      authDisabled &&
      bindAddress !== '127.0.0.1' &&
      bindAddress !== 'localhost'
    ) {
      logger.warn(
        'WARNING: authentication is disabled while bound to a non-localhost address.',
      );
    }
  } catch (error) {
    await workspaceLease?.release().catch((releaseError) => {
      logger.warn('Failed to release workspace lease:', errorMessage(releaseError));
    });
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
}
