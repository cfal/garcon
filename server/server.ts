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
import { ChatTransientFeedStore } from './chats/chat-transient-feed.js';
import { ChatProcessingActivity } from './chats/chat-processing-activity.js';
import { ChatRowService } from './chats/chat-row-service.js';
import { TranscriptExportService } from './chats/transcript-export/service.js';
import { HandoffArtifactService } from './chats/handoff-artifact/service.js';
import { TranscriptSearchController } from './chats/search/controller.js';
import { TranscriptSearchSettingsCoordinator } from './chats/search/settings-coordinator.js';
import { AgentRegistry } from './agents/index.js';
import {
  CARRYOVER_COMPACTION_TIMEOUT_MS,
  CarryOverCompactionService,
} from './chats/carryover-compaction.js';
import { PreparedCarryoverStore } from './chats/prepared-carryover.js';
import { AgentCommandComposition } from './chats/agent-command-composition.js';
import { defaultAgentIntegrations } from './agents/default-agent-integrations.js';
import { IntegrationHostFactory } from './agents/integration-host.js';
import { IntegrationRegistry } from './agents/integration-registry.js';
import { FileAgentMigrationStore } from './agents/integration-migration-store.js';
import {
  migrateAgentIntegrationCoreRecords,
  refreshAgentExecutionModeCoreRecords,
  refreshAgentIntegrationCoreRecords,
} from './agents/core-record-migration.js';
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
import { TranscriptSearchService } from '@garcon/server-agent-common/search/transcript-search-service';
import { ScheduledPromptStore } from './scheduled-prompts/store.js';
import { ScheduledPromptRunLog } from './scheduled-prompts/run-log.js';
import { ScheduledPromptDispatcher } from './scheduled-prompts/dispatcher.js';
import { ScheduledPromptScheduler } from './scheduled-prompts/scheduler.js';
import { ChatListProjector } from './chats/chat-list-projector.js';
import { AgentOwnershipJournal } from './chats/agent-ownership-journal.js';
import { CarryOverGarbageCollector } from './chats/carryover-garbage-collector.js';
import { CarryOverTranscriptStore } from './chats/carryover-transcript-store.js';
import {
  finalizeCarryOverMigrationValidation,
  migrateLegacyCarryOverWorkspace,
} from './chats/chat-carryover-migration.js';
import {
  resumeInterruptedCarryOverRollback,
  rollbackLegacyCarryOverMigration,
} from './chats/chat-carryover-rollback.js';
import { AgentHandoffService } from './agents/agent-handoff-service.js';
import { SnippetStore } from './snippets/store.js';
import {
  SnippetProjectPathService,
  SnippetService,
} from './snippets/service.js';
import { initializePreambleService } from './preambles/setup.js';
import {
  importNativeHistoryDrafts,
  ledgerRowsToMessages,
  TranscriptAdoptionService,
  TranscriptLedgerService,
  NativeActivityPageReader,
  NativeTranscriptActivityService,
  TranscriptLedgerStore,
  TranscriptReloadService,
  TranscriptViewReader,
} from './ledger/index.js';

// Route factory
import createAllRoutes from './routes/index.js';
import { ModelCatalogResponseCache } from './routes/model-catalog-cache.js';
import { createLogger, type Logger } from './lib/log.js';
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

const logger = createLogger('server');
const CARRY_OVER_MIGRATION_LOG_INTERVAL_MS = 10_000;

export async function runCarryOverMigrationAtStartup(
  migrate: () => Promise<void>,
  progressLogger: Pick<Logger, 'info'>,
): Promise<void> {
  const startedAt = Date.now();
  const elapsedSeconds = () => Math.floor((Date.now() - startedAt) / 1_000);

  progressLogger.info(
    'Workspace history migration started. This one-time upgrade may take several minutes.',
  );
  const heartbeat = setInterval(() => {
    progressLogger.info(
      `Workspace history migration is still running (${elapsedSeconds()}s elapsed).`,
    );
  }, CARRY_OVER_MIGRATION_LOG_INTERVAL_MS);

  try {
    await migrate();
  } finally {
    clearInterval(heartbeat);
  }
  progressLogger.info(
    `Workspace history migration completed (${elapsedSeconds()}s elapsed).`,
  );
}

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
    // Rollback recovery answers to the migration marker, not the workspace
    // version, so it runs before the version-gated ladder opens: a crash
    // mid-rollback can leave restored legacy files beside a version-5 marker,
    // which the ladder would never hand to its callback.
    await resumeInterruptedCarryOverRollback(workspaceDir);
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

    const carryOver = new CarryOverTranscriptStore({ workspaceDir });
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
    await workspaceMigrations.run('carryover-segment-migration', async () => {
      await runCarryOverMigrationAtStartup(
        async () => {
          await migrateLegacyCarryOverWorkspace(workspaceDir);
        },
        logger,
      );
    });
    await workspaceMigrations.run('agent-integration-settings-refresh', () => (
      refreshAgentIntegrationCoreRecords({ workspaceDir, integrations: integrationRegistry })
    ));
    await workspaceMigrations.run('agent-execution-mode-refresh', () => (
      refreshAgentExecutionModeCoreRecords({ workspaceDir, integrations: integrationRegistry })
    ));
    await chatRegistry.init();
    await settings.init();
    let queue: ChatExecutionCoordinator | null = null;
    const agentCommands = new AgentCommandComposition();
    const transcriptStore = new TranscriptLedgerStore(
      path.join(workspaceDir, 'transcript-ledgers'),
    );
    transcriptStore.removeUnregisteredChatDirectories(
      new Set(Object.keys(chatRegistry.listAllChats())),
    );
    const transcriptLedger = new TranscriptLedgerService(transcriptStore, {
      serverInstanceId: runtimeState.identity.instanceId,
      onListenerError(error) {
        logger.warn('Transcript commit listener failed:', errorMessage(error));
      },
      chatIdRequests: agentCommands.chatIdRequests,
      interAgentMessages: agentCommands.interAgentMessages,
    });
    const preparedCarryover = new PreparedCarryoverStore();
    transcriptLedger.subscribe((event) => {
      if (event.type !== 'view-replaced') return;
      preparedCarryover.discard(event.chatId);
      agentCommands.discardSource(event.chatId);
    });
    chatRegistry.onChatRemoved((chatId) => {
      preparedCarryover.discard(chatId);
      agentCommands.discardSource(chatId);
    });
    const agentOwnership = new AgentOwnershipJournal({
      workspaceDir,
      registry: chatRegistry,
      integrations: integrationRegistry,
      ledger: transcriptLedger,
    });
    // Persists the version before ownership recovery can remove chats and rewrite the migrated registry.
    await workspaceMigrations.finish();
    await agentOwnership.initialize();
    const carryOverGarbageCollector = new CarryOverGarbageCollector({
      registry: chatRegistry,
      journal: agentOwnership,
      store: carryOver,
    });
    await carryOverGarbageCollector.initialize();
    chatRegistry.onChatRemoved(() => carryOverGarbageCollector.schedule());
    // A resumed rollback restores the source workspace version before the
    // ladder opens, so its re-migration skips this the way a first migration
    // does and keeps its rollback window.
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
    let unsubscribeSearchStatus = () => {};
    // Constructed below but captured by the carried-context callback, which only
    // runs once a session starts.
    let carryOverCompaction: CarryOverCompactionService | null = null;
    let agentRegistry!: AgentRegistry;
    let executionQueries: Pick<ChatExecutionCoordinator, 'ownsExecution'> | null = null;
    let chatSearch: TranscriptSearchController | null = null;
    const transcriptAdoption = new TranscriptAdoptionService({
      ledger: transcriptLedger,
      registry: chatRegistry,
      integrations: integrationRegistry,
      logger,
      getCarryOverRevision: (entry) => carryOver.revision(
        entry.carryOverSegments ?? [],
        entry.carryOverMigrationQuarantine ?? null,
      ),
      async loadFrozenPrefix(_chatId, entry, signal) {
        return carryOver.loadAll(entry.carryOverSegments ?? [], signal);
      },
      onAdopted(chatId) {
        chatSearch?.catalogMayHaveChanged(chatId);
      },
    });
    const nativeTranscriptActivity = new NativeTranscriptActivityService({
      ledger: transcriptLedger,
      registry: chatRegistry,
      integrations: integrationRegistry,
      ownsExecution(chatId) {
        if (!executionQueries) throw new Error('Chat execution coordinator is not initialized');
        return executionQueries.ownsExecution(chatId);
      },
      notifyOperationalNotice(chatId, noticeType, content) {
        eventWiring?.notifyOperationalNotice(chatId, noticeType, content);
      },
    });
    const transcriptReader = new TranscriptViewReader(
      transcriptLedger,
      transcriptAdoption,
    );
    const preambles = await initializePreambleService(workspaceDir);

    agentRegistry = new AgentRegistry({
      registry: chatRegistry,
      integrations: integrationRegistry,
      endpointResolver,
      getCarryOverRevision: (entry) => carryOver.revision(
        entry.carryOverSegments ?? [],
        entry.carryOverMigrationQuarantine ?? null,
      ),
      async createCarriedContext(input) {
        const prepared = preparedCarryover.take({
          chatId: input.chatId,
          transcriptViewId: input.transcriptViewId,
          targetAgentId: input.entry.agentId,
          clientRequestId: input.clientRequestId,
        });
        if (prepared) return prepared;
        if (!carryOverCompaction) throw new Error('Carryover compaction is not initialized');
        return carryOverCompaction.planFor({
          operation: 'fresh-start',
          chatId: input.chatId,
          projectPath: input.entry.projectPath,
          messages: input.messages,
          destination: {
            agentId: input.entry.agentId,
            model: input.entry.model ?? '',
            prompt: input.destinationPrompt,
          },
          signal: input.signal,
        });
      },
      onCarryOverChanged(chatId) {
        eventWiring?.notifyTranscriptCompositionChanged(chatId);
      },
      hasPendingOwnershipTransfer: (chatId) => agentOwnership.hasPending(chatId),
      chatMutationLock,
      ledger: transcriptLedger,
      adoption: transcriptAdoption,
      preambles,
    });

    await chatRegistry.reconcileSessions((session, chatId) =>
      agentRegistry.resolveNativeSession(session, chatId),
    );
    await settings.reconcileWithRegistry(chatRegistry);

    // Chat infrastructure uses the agent registry through narrow injected APIs.
    const metadata = new MetadataIndex(chatRegistry, agentRegistry, carryOver, {
      metadataPath: path.join(workspaceDir, 'chat-metadata.json'),
    });
    await metadata.init();

    const transientFeeds = new ChatTransientFeedStore(runtimeState.identity.instanceId);
    carryOverCompaction = new CarryOverCompactionService({
      agents: agentRegistry,
      getUiSettings: () => settings.getUiSettings(),
      onCompactionStarted(chatId) {
        eventWiring?.notifyOperationalNotice(
          chatId,
          'info',
          `Compacting earlier chat history. This may take up to ${CARRYOVER_COMPACTION_TIMEOUT_MS / 60_000} minutes per attempt.`,
        );
      },
    });
    const transcriptSearchService = new TranscriptSearchService({
      workspaceDirectory: workspaceDir,
      logger,
    });
    chatSearch = new TranscriptSearchController({
      service: transcriptSearchService,
      ledger: transcriptLedger,
      adoption: transcriptAdoption,
      listChatIds: () => Object.keys(chatRegistry.listAllChats()),
      hasChat: (chatId) => chatRegistry.getChat(chatId) !== null,
      logger,
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

    const chatMessageReader = {
      getMessages(chatId: string) {
        return transcriptLedger.currentView(chatId)
          ? ledgerRowsToMessages(transcriptLedger.currentRows(chatId))
          : null;
      },
    };
    const chatViewPages = new NativeActivityPageReader(
      transcriptReader,
      nativeTranscriptActivity,
    );
    const handoffs = new AgentHandoffService({
      registry: chatRegistry,
      integrations: integrationRegistry,
      endpointResolver,
      catalog: agentRegistry,
      ownership: agentOwnership,
      ledger: transcriptLedger,
      carryover: carryOverCompaction,
      preparedCarryover,
      reopenProducer: (chatId) => agentRegistry.reopenTranscriptProducer(chatId),
      onCommitted(chatId) {
        eventWiring?.notifyAgentHandoff(chatId);
      },
    });
    void handoffs.recoverPendingHandoffs().catch((error) => {
      logger.warn('Pending agent handoff recovery failed:', errorMessage(error));
    });

    const shareStore = new ShareStore(workspaceDir);
    await shareStore.init();

    const commandLedger = new CommandLedger(workspaceDir);
    queue = new ChatExecutionCoordinator(
      workspaceDir,
      agentRegistry,
      agentRegistry,
      (chatId) => queueDrainOptions(chatId, chatRegistry),
      (chatId) => Boolean(chatRegistry.getChat(chatId)),
      new InMemoryChatExecutionControlRepository(runtimeState.identity.instanceId),
      (chatId) => commandLedger.unsettledQueueReceiptKeys(chatId),
      agentCommands.appendControlReceipt,
    );
    executionQueries = queue;
    const transcriptReload = new TranscriptReloadService({
      ledger: transcriptLedger,
      adoption: transcriptAdoption,
      registry: chatRegistry,
      integrations: integrationRegistry,
      execution: queue,
      reopenProducer: (chatId) => agentRegistry.reopenTranscriptProducer(chatId),
      getCarryOverRevision: (entry) => carryOver.revision(
        entry.carryOverSegments ?? [],
        entry.carryOverMigrationQuarantine,
      ),
      chatMutationLock,
    });
    const chatRows = new ChatRowService({
      registry: chatRegistry,
      adoption: transcriptAdoption,
      ledger: transcriptLedger,
      ownershipJournal: agentOwnership,
      chatMutationLock,
      logger,
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
      canReloadFromNativeHistory(_chatId, session) {
        return Boolean(
          session.agentSessionId
          && session.nativeSession
          && integrationRegistry.get(session.agentId)?.nativeHistoryImport,
        );
      },
    });
    const transcriptExport = new TranscriptExportService({
      summaries: chatListProjector,
      transcripts: transcriptReader,
    });
    const handoffArtifact = new HandoffArtifactService({
      summaries: chatListProjector,
      transcripts: transcriptReader,
    });
    const chatCommands = new ChatCommandService({
      chats: chatRegistry,
      queue,
      ledger: commandLedger,
      settings,
      recentTitleIcons,
      metadata,
      agents: agentRegistry,
      fileMentions: { resolve: resolveFileMentionsInCommand },
      forkChatFileCopy,
      readForkedNativeHistory: async ({
        targetChatId,
        sourceSession,
        fork,
        signal,
        preambleEvidence,
      }) => {
        const integration = integrationRegistry.get(sourceSession.agentId);
        if (!integration?.nativeHistoryImport) return null;
        return importNativeHistoryDrafts({
          chatId: targetChatId,
          entry: sourceSession,
          integration,
          nativeHistoryImport: integration.nativeHistoryImport,
          session: fork,
          // The fork target starts with no carryover of its own; its history is the
          // session it resumes from.
          carryOverRevision: carryOver.revision([]),
          signal,
          now: () => new Date().toISOString(),
          preambleEvidence,
        });
      },
      transcripts: transcriptLedger,
      chatListProjector,
      pathCache,
      ownership: agentOwnership,
      handoffs,
      transientFeeds,
      chatMutationLock,
    });
    agentCommands.initialize({
      registry: chatRegistry,
      adoption: transcriptAdoption,
      execution: queue,
      notices: transcriptLedger,
      chatMutationLock,
      settings,
      onChatIdError(error, chatId) {
        logger.warn('Chat ID auto-discovery delivery failed', {
          chatId,
          reason: errorMessage(error),
        });
      },
    });

    const scheduledPromptStore = new ScheduledPromptStore(workspaceDir);
    const scheduledPromptRunLog = new ScheduledPromptRunLog();
    const scheduledPrompts = new ScheduledPromptScheduler({
      store: scheduledPromptStore,
      runLog: scheduledPromptRunLog,
      dispatcher: new ScheduledPromptDispatcher({
        commands: chatCommands,
        chatIds,
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
    new AttentionTracker(
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
        currentTranscriptMessages: (chatId) => transcriptLedger.conversationMessages(chatId),
        assistantMessagesForSubmission: (
          chatId,
          viewId,
          clientMessageId,
          throughOrdinal,
        ) => transcriptLedger.assistantMessagesForSubmission(
          chatId,
          viewId,
          clientMessageId,
          throughOrdinal,
        ),
        transientFeeds,
        commandLedger,
        shareStore,
        telegramNotifier,
        telegramSettings,
        scheduledPrompts,
        snippets,
        preambles,
        searchIndex: chatSearch,
      }),
      startScheduledPrompts: () => scheduledPrompts.start(),
    });
    unsubscribeSearchStatus = chatSearch.onStatusChanged((status) => {
      eventWiring?.broadcastTranscriptSearchStatus(status);
    });

    // Build route and WS handler tables
    const routes = createAllRoutes({
      registry: chatRegistry,
      settings,
      recentTitleIcons,
      queue,
      processing: chatProcessingActivity,
      pathCache,
      metadata,
      chatViews: chatViewPages,
      shareSnapshots: transcriptReader,
      agents: agentRegistry,
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
      preambles,
      terminals: terminalManager,
      searchIndex: chatSearch,
      transcriptSearchSettings,
      runtimeState,
      commandLedger,
      transientFeeds,
      chatRows,
      transcriptExport,
      handoffArtifact,
    });

    const chatHandler = new ChatHandler({
      serverInstanceId: runtimeState.identity.instanceId,
      processing: chatProcessingActivity,
      chatViews: {
        ...chatViewPages,
        readReplay: (chatId, viewId, afterOrdinal, throughOrdinal) =>
          transcriptReader.replay(chatId, viewId, afterOrdinal, throughOrdinal),
        resendCandidates: (chatId) => agentRegistry.resendCandidates(chatId),
      },
      transcriptReload: async (chatId) => {
        await transcriptReload.reload(chatId);
        return transcriptReader.page(chatId, 100);
      },
      queue,
      transientFeeds,
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
      carryOverGarbageCollector.shutdown();
      logger.info('server: shutting down...');
      const reservedChatIds = queue.beginShutdown();
      handoffs.shutdown();
      let abortTimedOut = false;
      let cleanupFailed = false;
      try {
        await server.stop(true);
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
        unsubscribeSearchStatus();
        await chatSearch.close();
        await integrationRegistry.stop();
        transcriptLedger.close();
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
