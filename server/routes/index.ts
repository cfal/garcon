import authRoutes from './auth.js';
import createStaticRoutes from './static.js';
import createFilesRoutes from './files.js';
import createCommandsRoutes from './commands.js';
import createAgentRoutes from './agents.js';
import createApiProviderRoutes from './api-providers.js';
import createModelsRoutes from './models.js';
import createGitRoutes from './git.js';
import createGhRoutes from './gh.js';
import createChatRoutes from './chats.js';
import createSnippetRoutes from './snippets.js';
import { createCanvasRoutes } from './chat-canvases.js';
import { CanvasStore } from '../chat-canvas/store.js';
import createShareRoutes from './shares.js';
import createWorkspaceRoutes from './workspace.js';
import createScheduledPromptRoutes from './scheduled-prompts.js';
import createPreambleRoutes from './preambles.js';
import { createChatPreambleRoutes } from './chat-preambles.js';
import createTerminalRoutes from './terminals.js';
import createPromptRefinementRoutes from './prompt-refinement.js';
import { createRuntimeRoutes } from './runtime.js';
import { createAgentTurnReceiptRoutes } from './agent-turn-receipt.js';
import { createChatSnapshotRoutes } from './chat-snapshot.js';
import { createChatRowRoutes } from './chat-rows.js';
import { createChatExportRoutes } from './chat-export.js';
import { createChatHandoffArtifactRoutes } from './chat-handoff-artifact.js';
import { createNativeSessionLookupRoutes } from './native-session-lookup.js';
import { createProjectResolutionRoutes } from './project-resolution.js';
import { createChatBoardRoutes } from './chat-boards.js';
import { createTicketRoutes } from './tickets.js';
import { createChatTicketSourceRoutes } from './chat-ticket-source.js';
import type { TicketSourceReader } from '../chats/chat-message-reader.js';
import type { TicketRuntime } from '../tickets/setup.js';
import { createChatTagRoutes } from './chat-tags.js';
import type { ServerRuntimeState } from '../lib/server-runtime.js';
import type { RouteMap } from '../lib/http-route-types.js';
import type { IChatRegistry } from '../chats/store.js';
import type { SettingsStore } from '../settings/store.js';
import type { ChatExecutionService } from '../chat-execution/chat-execution-coordinator.js';
import type { MetadataIndex } from '../chats/metadata-store.js';
import type { TranscriptPageReader } from '../chats/chat-message-reader.js';
import type { ShareTranscriptSnapshotPort } from './shares.js';
import type { AgentRegistry } from '../agents/registry.js';
import type { TelegramNotifier } from '../notifications/telegram.js';
import type { TelegramSettingsStore } from '../notifications/telegram-settings-store.js';
import type { IShareStore } from '../chats/share-store.js';
import type { ApiProviderService } from '../api-providers/service.js';
import type { ChatCommandService } from '../commands/chat-command-service.js';
import type { SnippetService } from '../snippets/service.js';
import type { ModelCatalogResponseCache } from './model-catalog-cache.js';
import type { LastSelectedChatState } from '../chats/last-selected-chat-state.js';
import type { ScheduledPromptScheduler } from '../scheduled-prompts/scheduler.js';
import type { ChatListProjector } from '../chats/chat-list-projector.js';
import type { TerminalController } from '../terminals/controller.js';
import type { TranscriptSearchController } from '../chats/search/controller.js';
import type { TranscriptSearchSettingsCoordinator } from '../chats/search/settings-coordinator.js';
import type { RecentTitleIconSource } from '../chats/recent-title-icons.js';
import type { CommandLedger } from '../commands/command-ledger.js';
import type { ChatTransientFeedStore } from '../chats/chat-transient-feed.js';
import type { ChatProcessingActivity } from '../chats/chat-processing-activity.js';
import type { ChatRowService } from '../chats/chat-row-service.js';
import type { TranscriptExportService } from '../chats/transcript-export/service.js';
import type { HandoffArtifactService } from '../chats/handoff-artifact/service.js';
import type { PreambleService } from '../preambles/service.js';
import type { ChatPreambleSelectionService } from '../preambles/chat-selection-service.js';
import type { ChatBoardService } from '../chat-boards/service.js';
import type { ChatTagMutationService } from '../chats/chat-tag-mutation-service.js';
import type { KeyedPromiseLock } from '../lib/keyed-lock.js';
import type { ExecutionNodeManager } from '../execution-nodes/manager.js';
import { PreambleProjectPathService } from '../preambles/project-path-service.js';
import { createExecutionNodeRoutes } from './execution-nodes.js';
import { getHttpIdleTimeoutSeconds } from '../config.js';
import { GIT_OPERATION_TIMEOUT_MS, GH_DETAIL_TIMEOUT_MS } from '../../common/git-execution.js';

export default function createAllRoutes(workspaceDir: string, {
  registry,
  settings,
  recentTitleIcons,
  queue,
  processing,
  metadata,
  chatViews,
  ticketSources,
  shareSnapshots,
  agents,
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
  chatPreambleSelection,
  chatBoards,
  tickets,
  resolveTicketProject,
  chatTags,
  chatMutationLock,
  terminals,
  searchIndex,
  transcriptSearchSettings,
  runtimeState,
  commandLedger,
  transientFeeds,
  chatRows,
  transcriptExport,
  handoffArtifact,
  executionNodes,
  projectBasePath,
}: {
  registry: IChatRegistry;
  settings: SettingsStore;
  recentTitleIcons: RecentTitleIconSource;
  queue: ChatExecutionService;
  processing: ChatProcessingActivity;
  metadata: MetadataIndex;
  chatViews: TranscriptPageReader;
  ticketSources: TicketSourceReader;
  shareSnapshots: ShareTranscriptSnapshotPort;
  agents: AgentRegistry;
  telegramNotifier: TelegramNotifier;
  telegramSettings: TelegramSettingsStore;
  shareStore: IShareStore;
  apiProviders: ApiProviderService;
  chatCommands: ChatCommandService;
  chatListProjector: ChatListProjector;
  modelCatalogResponseCache: ModelCatalogResponseCache;
  lastSelectedChat: LastSelectedChatState;
  scheduledPrompts: ScheduledPromptScheduler;
  snippets: SnippetService;
  preambles: PreambleService;
  chatPreambleSelection: ChatPreambleSelectionService;
  chatBoards: ChatBoardService;
  tickets: TicketRuntime;
  resolveTicketProject: Parameters<typeof createTicketRoutes>[1];
  chatTags: ChatTagMutationService;
  chatMutationLock: Pick<KeyedPromiseLock, 'runExclusive'>;
  terminals: TerminalController;
  searchIndex: TranscriptSearchController;
  transcriptSearchSettings: TranscriptSearchSettingsCoordinator;
  runtimeState: ServerRuntimeState;
  commandLedger: CommandLedger;
  transientFeeds: ChatTransientFeedStore;
  chatRows: ChatRowService;
  transcriptExport: TranscriptExportService;
  handoffArtifact: HandoffArtifactService;
  executionNodes: ExecutionNodeManager;
  projectBasePath: string;
}): RouteMap {
  const canvases = new CanvasStore(workspaceDir);
  const inspectProject = executionNodes.inspectProject;
  const httpIdleSeconds = getHttpIdleTimeoutSeconds();
  const gitBudget = httpIdleSeconds > 0 ? Math.max(1000, httpIdleSeconds * 1000 - 2000) : GH_DETAIL_TIMEOUT_MS;
  return {
    ...createExecutionNodeRoutes(executionNodes),
    ...createRuntimeRoutes(runtimeState),
    ...createAgentTurnReceiptRoutes(commandLedger),
    ...createChatSnapshotRoutes({
      summaries: chatListProjector,
      execution: queue,
      chatViews,
      transientFeeds,
    }),
    ...createChatRowRoutes(chatRows),
    ...createChatExportRoutes(transcriptExport),
    ...createChatHandoffArtifactRoutes(handoffArtifact),
    ...createNativeSessionLookupRoutes(registry, agents),
    ...createProjectResolutionRoutes({ registry, inspect: inspectProject }),
    ...createStaticRoutes(settings),
    ...authRoutes,
    ...createAgentRoutes({ agents, apiProviders }),
    ...createApiProviderRoutes(apiProviders, modelCatalogResponseCache),
    ...createChatRoutes({
      registry,
      settings,
      recentTitleIcons,
      queue,
      processing,
      metadata,
      chatViews,
      agents,
      commandService: chatCommands,
      chatListProjector,
      lastSelectedChat,
      searchIndex,
      transcriptSearchMaintenance: transcriptSearchSettings,
      chatMutationLock,
      projects: (nodeId) => executionNodes.projectService(nodeId),
    }),
    ...createChatTagRoutes(chatTags),
    ...createChatBoardRoutes(chatBoards),
    ...createTicketRoutes(tickets, resolveTicketProject),
    ...createChatTicketSourceRoutes(registry, ticketSources),
    ...createShareRoutes(shareStore, registry, settings, metadata, shareSnapshots),
    ...createFilesRoutes(registry, { files: (nodeId) => executionNodes.requireNode(nodeId).getFilesService(), inspectProject }),
    ...createTerminalRoutes(terminals),
    ...createGitRoutes(agents, settings, (nodeId) => executionNodes.requireNode(nodeId).getGitService(), Math.min(GIT_OPERATION_TIMEOUT_MS, gitBudget)),
    ...createGhRoutes((nodeId) => executionNodes.requireNode(nodeId).getGhService(), Math.min(GH_DETAIL_TIMEOUT_MS, gitBudget)),
    ...createCommandsRoutes({ registry, agents, inspectProject }),
    ...createWorkspaceRoutes(
      settings,
      agents,
      telegramNotifier,
      telegramSettings,
      projectBasePath,
      registry,
      transcriptSearchSettings,
    ),
    ...createModelsRoutes({
      modelCatalog: { agents, apiProviders },
      responseCache: modelCatalogResponseCache,
    }),
    ...createScheduledPromptRoutes(scheduledPrompts),
    ...createSnippetRoutes(snippets),
    ...createCanvasRoutes(canvases),
    ...createPreambleRoutes(preambles),
    ...createChatPreambleRoutes({
      selection: chatPreambleSelection,
      preambles,
      projectPaths: new PreambleProjectPathService(inspectProject),
    }),
    ...createPromptRefinementRoutes({ settings, agents }),
  };
}
