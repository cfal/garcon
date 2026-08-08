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
import { forkChatFileCopy } from './chats/fork-chat.js';
import { resolveFileMentionsInCommand } from './chats/file-mentions.js';
import { wireServerEvents, type ServerEventWiring } from './server-event-wiring.js';
import { startExecutionControlPlane } from './execution-control-plane.js';

// Classes
import { ChatRegistry } from './chats/store.js';
import { ChatIdAllocator } from './chats/chat-id-allocator.js';
import { migrateWorkspaceChatIds } from './chats/chat-id-migration.js';
import { InMemoryLastSelectedChatState } from './chats/last-selected-chat-state.js';
import { RecentTitleIconStore } from './chats/recent-title-icons.js';
import { ShareStore } from './chats/share-store.js';
import { SettingsStore } from './settings/store.js';
import {
  ChatExecutionCoordinator,
} from './chat-execution/chat-execution-coordinator.js';
import { InMemoryChatExecutionControlRepository } from './chat-execution/chat-execution-control-repository.js';
import { queueDrainOptions } from './chats/chat-execution-options.js';
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
import { IdleNativeReconciler } from './chats/idle-native-reconciler.js';
import { ChatProcessingActivity } from './chats/chat-processing-activity.js';
import { ChatNativeReloader } from './chats/chat-native-reload.js';
import { TranscriptSearchController } from './chats/search/controller.js';
import { TranscriptSearchSettingsCoordinator } from './chats/search/settings-coordinator.js';
import { PendingUserInputService } from './chats/pending-user-input-service.js';
import { AgentRegistry } from './agents/index.js';
import { renderCarriedContext } from '@garcon/common/transcript-seed';
import { CarryOverCompactionService } from './chats/carryover-compaction.js';
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
import { ChatGenerationResetMessage, WsFaultMessage } from '../common/ws-events.ts';
import { ErrorMessage } from '../common/chat-types.ts';
import { TranscriptSearchService } from '@garcon/server-agent-common/search/transcript-search-service';
import { ScheduledPromptStore } from './scheduled-prompts/store.js';
import { ScheduledPromptRunLog } from './scheduled-prompts/run-log.js';
import { ScheduledPromptDispatcher } from './scheduled-prompts/dispatcher.js';
import { ScheduledPromptScheduler } from './scheduled-prompts/scheduler.js';
import { ChatListProjector } from './chats/chat-list-projector.js';
import { AgentOwnershipJournal } from './chats/agent-ownership-journal.js';
import { CarryOverGarbageCollector } from './chats/carryover-garbage-collector.js';
import {
  CarryOverHistoryUnavailableError,
  CarryOverTranscriptStore,
} from './chats/carryover-transcript-store.js';
import {
  finalizeCarryOverMigrationValidation,
  markCarryOverMigrationRollbackUnsafe,
  migrateLegacyCarryOverWorkspace,
  rollbackLegacyCarryOverMigration,
} from './chats/chat-carryover-migration.js';
import { OrderedChatTranscriptReader } from './chats/ordered-chat-transcript-reader.js';
import { AgentHandoffService } from './agents/agent-handoff-service.js';
import { SettledNativeCaptureService } from './agents/settled-native-capture.js';
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
  advertisedServerUrl,
  createServerRuntimeState,
  listeningServerUrl,
  publishServerRuntime,
  removeServerRuntime,
} from './lib/server-runtime.js';
import {
  cleanupLegacyQueueState,
  WorkspaceMigrationRunner,
} from './migrations/index.js';
import {
  LOCAL_SERVER_PRINCIPAL,
  type ServerPrincipal,
} from './lib/http-route-types.js';
import { TranscriptSearchCarryOverError } from '@garcon/server-agent-common/search/transcript-search-service';

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
    if (config.rollbackCarryOverMigration) {
      const result = await rollbackLegacyCarryOverMigration(workspaceDir);
      logger.info(`Carryover migration rollback ${result}. The server was not started.`);
      await workspaceLease.release();
      workspaceLease = null;
      return;
    }
    const runtimeState = createServerRuntimeState(workspaceDir);
    const workspaceMigrations = await WorkspaceMigrationRunner.open(workspaceDir);
    await workspaceMigrations.run('chat-id-migration', async () => {
      const result = await migrateWorkspaceChatIds(workspaceDir);
      const migratedChatIdCount = Object.keys(result.migratedChatIds).length;
      if (migratedChatIdCount > 0) {
        logger.info(
          `migrated ${migratedChatIdCount} legacy chat ID(s) across ${result.changedFiles.length} persisted file(s)`,
        );
      }
    });

    // Leaf modules with no inter-service dependencies.
    const chatRegistry = new ChatRegistry(workspaceDir);
    const settings = new SettingsStore(workspaceDir);
    const recentTitleIcons = new RecentTitleIconStore();
    settings.onSessionNameChanged((_chatId, title) => {
      try {
        recentTitleIcons.recordTitle(title);
      } catch (error) {
        logger.warn('chat-title: failed to record recent icons:', errorMessage(error));
      }
    });
    const pathCache = new PathCache();
    const terminalManager = new TerminalManager();
    const terminalStream = new TerminalStreamHandler(terminalManager);
    const wsAdmission = new WebSocketAdmissionController(config.maxWsClients);

    await initAuthStore();

    // User-managed API provider store and resolver.
    const apiProviderStore = new ApiProviderStore();
    await apiProviderStore.init();

    const carryOver = new CarryOverTranscriptStore({
      workspaceDir,
      onSegmentCommitted: () => markCarryOverMigrationRollbackUnsafe(workspaceDir),
    });
    await carryOver.initialize();

    const integrationHostFactory = new IntegrationHostFactory({
      workspaceDir,
      async resolveCredential({ reference, signal }) {
        signal.throwIfAborted();
        const resolved = apiProviderStore.getEndpoint(reference.endpointId);
        if (!resolved || resolved.apiProvider.id !== reference.apiProviderId) return null;
        return { kind: 'api-key', value: resolved.endpoint.apiKey };
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
    await workspaceMigrations.run('core-record-migration', () => (
      migrateAgentIntegrationCoreRecords({ workspaceDir, integrations: integrationRegistry })
    ));
    await integrationRegistry.start();
    await workspaceMigrations.run('ephemeral-queue-state-cleanup', () => cleanupLegacyQueueState({
      workspaceDir,
      settleOwnershipIntents: async () => undefined,
    }));
    await workspaceMigrations.run('carryover-node-migration', async () => undefined);
    await workspaceMigrations.run('carryover-segment-migration', () => (
      migrateLegacyCarryOverWorkspace(workspaceDir)
    ));
    await chatRegistry.init();
    await settings.init();
    const agentOwnership = new AgentOwnershipJournal({
      workspaceDir,
      registry: chatRegistry,
      integrations: integrationRegistry,
    });
    await agentOwnership.initialize();
    const carryOverGarbageCollector = new CarryOverGarbageCollector({
      registry: chatRegistry,
      journal: agentOwnership,
      store: carryOver,
    });
    await carryOverGarbageCollector.initialize();
    chatRegistry.onChatRemoved(() => carryOverGarbageCollector.schedule());
    await workspaceMigrations.finish();
    if (workspaceMigrations.initialVersion >= 5) {
      await finalizeCarryOverMigrationValidation(workspaceDir);
    }
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
    let eventWiring: ServerEventWiring | null = null;
    // Both are constructed below but are needed by the carried-context callback,
    // which only runs once a session starts.
    let carryOverCompaction: CarryOverCompactionService | null = null;
    let carryOverWarnings: ((chatId: string, message: string) => void) | null = null;
    const agentRegistry = new AgentRegistry({
      registry: chatRegistry,
      integrations: integrationRegistry,
      endpointResolver,
      getCarryOverRevision: (entry) => carryOver.revision(
        entry.carryOverSegments ?? [],
        entry.carryOverMigrationQuarantine ?? null,
      ),
      async loadCarriedContext(chatId, entry, signal) {
        if (entry.carryOverMigrationQuarantine) {
          throw new CarryOverHistoryUnavailableError();
        }
        const refs = entry.carryOverSegments ?? [];
        if (refs.length === 0) return null;
        const messages = await carryOver.loadProjectionSource({
          refs,
          signal,
        });
        if (!carryOverCompaction) return renderCarriedContext(messages);
        return carryOverCompaction.carriedContextFor({
          chatId,
          projectPath: entry.projectPath,
          messages,
          destination: { agentId: entry.agentId, model: entry.model ?? '', prompt: null },
          signal,
        });
      },
      getCarryOverMessageCount: async (entry) => (
        carryOver.logicalMessageCount(entry.carryOverSegments ?? [])
      ),
      onCarryOverChanged(chatId) {
        eventWiring?.notifyTranscriptCompositionChanged(chatId);
      },
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

    // Bound once the coordinator exists. Until then nothing can own execution beyond a running
    // provider session, so transcript retention and reload gating consult the same question the
    // coordinator answers rather than assembling their own union of ownership state.
    let executionCoordinator: ChatExecutionCoordinator | null = null;
    const ownsExecution = (chatId: string): boolean => (
      executionCoordinator === null
        ? agentRegistry.isChatRunning(chatId)
        : executionCoordinator.ownsExecution(chatId)
    );
    const chatViews = new ChatViewStore(ownsExecution);
    carryOverWarnings = (chatId, message) => {
      void chatViews.appendToCurrentOrProvisional(chatId, [
        new ErrorMessage(new Date().toISOString(), message),
      ]).catch((error: unknown) => {
        logger.warn('carryover compaction notice failed:', errorMessage(error));
      });
    };
    carryOverCompaction = new CarryOverCompactionService({
      agents: agentRegistry,
      getUiSettings: () => settings.getUiSettings(),
      warn: (chatId, message) => carryOverWarnings?.(chatId, message),
    });
    const chatViewPruneTimer = setInterval(() => chatViews.prune(), 60_000);
    chatViewPruneTimer.unref();
    const transcripts = new OrderedChatTranscriptReader({
      registry: chatRegistry,
      agents: agentRegistry,
      carryOver,
    });
    const loadChatSnapshot = (chatId: string) => transcripts.loadAll(chatId);
    const loadChatMessages = async (chatId: string) => (await loadChatSnapshot(chatId)).messages;
    const loadCurrentNativeMessages = (chatId: string) => (
      transcripts.loadCurrentNativeMessages(chatId)
    );
    const chatNativeReloader = new ChatNativeReloader(
      chatViews,
      { loadSnapshot: loadChatSnapshot },
      ownsExecution,
    );
    const transcriptSearchService = new TranscriptSearchService({
      workspaceDirectory: workspaceDir,
      logger,
      async openCarryOverStream(request) {
        request.signal.throwIfAborted();
        const entry = chatRegistry.getChat(request.chatId);
        if (!entry || entry.carryOverMigrationQuarantine) {
          throw new TranscriptSearchCarryOverError({
            kind: 'transcript-search-carry-over-failure',
            code: 'CARRY_OVER_UNAVAILABLE',
            retryable: false,
          });
        }
        const revision = carryOver.revision(
          entry.carryOverSegments,
          entry.carryOverMigrationQuarantine,
        );
        if (revision !== request.expectedRevision) {
          throw new TranscriptSearchCarryOverError({
            kind: 'transcript-search-carry-over-failure',
            code: 'CARRY_OVER_REVISION_CHANGED',
            retryable: true,
          });
        }
        return {
          revision,
          batches: carryOver.stream({
            refs: entry.carryOverSegments,
            maxMessagesPerBatch: request.limits.maxMessagesPerBatch,
            signal: request.signal,
          }),
        };
      },
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
            carryOver.revision(
              session.carryOverSegments,
              session.carryOverMigrationQuarantine,
            ),
          ),
          updatedAt: metadata.getChatMetadata(chatId)?.lastActivity ?? null,
        }];
      }),
    });
    try {
      await chatSearch.initialize(
        settings.getFeatureSettings().transcriptSearch.enabled,
      );
    } catch (error) {
      logger.warn('Transcript search admission failed; server startup will continue.', {
        code: 'SEARCH_INDEX_ADMISSION_FAILED',
        reason: error instanceof Error ? error.message : String(error),
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
      loadNativeMessages: loadCurrentNativeMessages,
      loadNativeWindow: (input: Parameters<OrderedChatTranscriptReader['loadNativeWindow']>[0]) => (
        transcripts.loadNativeWindow(input)
      ),
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
        return ownsExecution(chatId);
      },
      async getOrCreatePage(chatId: string, limit: number, beforeSeq?: number) {
        return chatViews.getOrCreatePage(
          chatId,
          {
            loadAll: () => loadChatSnapshot(chatId),
            loadPage: (limit, offset) => transcripts.loadPage(chatId, limit, offset),
          },
          limit,
          beforeSeq,
        );
      },
      async reconcileNativeSnapshot(
        chatId: string,
        input: Parameters<ChatViewStore['reconcileNativeSnapshot']>[1],
      ) {
        await chatViews.reconcileNativeSnapshot(chatId, input);
      },
    };
    const chatMessageAppender = {
      async appendMessages(
        chatId: string,
        messages: Parameters<ChatViewStore['appendAfterEnsuringGeneration']>[2],
      ) {
        return chatViews.appendAfterEnsuringGeneration(
          chatId,
          {
            loadAll: () => loadChatSnapshot(chatId),
            loadPage: (limit, offset) => transcripts.loadPage(chatId, limit, offset),
          },
          messages,
        );
      },
    };
    const pendingInputs = new PendingUserInputService(chatMessageReader);
    const handoffs = new AgentHandoffService({
      registry: chatRegistry,
      integrations: integrationRegistry,
      endpointResolver,
      catalog: agentRegistry,
      carryOver,
      settledCapture: new SettledNativeCaptureService({ pendingInputs }),
      ownership: agentOwnership,
      onCommitted(chatId) {
        eventWiring?.notifyAgentHandoff(chatId);
      },
    });

    const shareStore = new ShareStore(workspaceDir);
    await shareStore.init();

    const commandLedger = new CommandLedger(workspaceDir);
    const queue = new ChatExecutionCoordinator(
      workspaceDir,
      agentRegistry,
      pendingInputs,
      chatMessageAppender,
      (chatId) => queueDrainOptions(chatId, chatRegistry),
      (chatId) => Boolean(chatRegistry.getChat(chatId)),
      new InMemoryChatExecutionControlRepository(runtimeState.identity.instanceId),
      (chatId) => commandLedger.unsettledQueueReceiptKeys(chatId),
    );
    executionCoordinator = queue;
    const idleReconciler = new IdleNativeReconciler({
      views: chatViews,
      source: {
        loadNativeSnapshot: (chatId) => transcripts.loadNativeReconciliation(chatId),
        loadFullSnapshot: (chatId) => transcripts.loadAll(chatId),
      },
      ownsExecution,
      onGenerationReset: (chatId, generationId, lastSeq) => {
        if (!webSocketPublisher) return;
        publishWebSocketPayload(
          webSocketPublisher,
          'chat',
          JSON.stringify(new ChatGenerationResetMessage(
            chatId,
            generationId,
            'idle-reconcile',
            lastSeq,
          )),
        );
      },
    });
    const chatProcessingActivity = new ChatProcessingActivity(agentRegistry, queue);
    const lastSelectedChat = new InMemoryLastSelectedChatState();
    const chatIds = new ChatIdAllocator(chatRegistry);
    const chatListProjector = new ChatListProjector({
      registry: chatRegistry,
      settings,
      metadata,
      processing: chatProcessingActivity,
      pathCache,
    });
    const chatCommands = new ChatCommandService({
      chats: chatRegistry,
      queue,
      chatViews,
      idleReconciler,
      ledger: commandLedger,
      settings,
      recentTitleIcons,
      metadata,
      agents: agentRegistry,
      pendingInputs,
      fileMentions: { resolve: resolveFileMentionsInCommand },
      forkChatFileCopy,
      carryOver,
      chatIds,
      chatListProjector,
      pathCache,
      ownership: agentOwnership,
      handoffs,
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
    eventWiring = await startExecutionControlPlane({
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
        processing: chatProcessingActivity,
        metadata,
        chatViews,
        idleReconciler,
        chatNativeReloader: indexedNativeReloader,
        pendingInputs,
        commandLedger,
        shareStore,
        telegramNotifier,
        telegramSettings,
        scheduledPrompts,
        snippets,
        loadChatSnapshot,
        loadChatPage: (chatId, limit, offset) => transcripts.loadPage(chatId, limit, offset),
        searchIndex: chatSearch,
      }),
      startScheduledPrompts: () => scheduledPrompts.start(),
    });

    // Build route and WS handler tables
    const routes = createAllRoutes({
      registry: chatRegistry,
      settings,
      recentTitleIcons,
      queue,
      pathCache,
      metadata,
      chatViews: chatViewPages,
      agents: agentRegistry,
      pendingInputs,
      telegramNotifier,
      telegramSettings,
      shareStore,
      apiProviders,
      chatCommands,
      chatListProjector,
      modelCatalogResponseCache,
      lastSelectedChat,
      scheduledPrompts,
      snippets,
      terminals: terminalManager,
      searchIndex: chatSearch,
      transcriptSearchSettings,
      runtimeState,
      commandLedger,
      notifyHistoryChanged(chatId) {
        eventWiring?.notifyTranscriptCompositionChanged(chatId);
      },
    });

    const chatHandler = new ChatHandler({
      serverInstanceId: runtimeState.identity.instanceId,
      processing: chatProcessingActivity,
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
      routes: wrapRoutes(routes, { localCapability: runtimeState.localCapability }),
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
    const actualPort = server.port ?? listenPort;
    const runtimeBaseUrl = advertisedServerUrl(bindAddress, actualPort);
    let runtimeFilePath: string | null = null;
    if (config.workspaceName !== null) {
      try {
        const publishedRuntime = await publishServerRuntime(runtimeState, runtimeBaseUrl);
        runtimeFilePath = publishedRuntime.filePath;
        logger.info(
          `Published workspace ${config.workspaceName} runtime at ${runtimeFilePath} (${runtimeBaseUrl})`,
        );
      } catch (error) {
        await server.stop(true);
        throw error;
      }
    }

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
        await server.stop(true);
        clearInterval(chatViewPruneTimer);
        idleReconciler.stop();
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
          () => eventWiring!.waitForIdle(),
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
        await chatRegistry.flush();
      } catch (err) {
        cleanupFailed = true;
        logger.warn('server: shutdown cleanup error:', errorMessage(err));
      } finally {
        if (runtimeFilePath) {
          try {
            await removeServerRuntime(runtimeFilePath, runtimeState.identity.instanceId);
          } catch (err) {
            cleanupFailed = true;
            logger.warn('server: runtime descriptor cleanup error:', errorMessage(err));
          }
        }
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
      `Started at ${listeningServerUrl(bindAddress, actualPort)}`,
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
