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
import createShareRoutes from './shares.js';
import createWorkspaceRoutes from './workspace.js';
import createScheduledPromptRoutes from './scheduled-prompts.js';
import createTerminalRoutes from './terminals.js';
import type { RouteMap } from '../lib/http-route-types.js';
import type { IChatRegistry } from '../chats/store.js';
import type { SettingsStore } from '../settings/store.js';
import type { ChatExecutionService } from '../chat-execution/chat-execution-coordinator.js';
import type { PathCache } from '../chats/path-cache.js';
import type { MetadataIndex } from '../chats/metadata-store.js';
import type { ChatViewPageReader } from '../chats/chat-message-reader.js';
import type { AgentRegistry } from '../agents/registry.js';
import type { PendingUserInputServiceContract } from '../chats/pending-user-input-service.js';
import type { PendingUserInputRecoveryCoordinator } from '../chats/pending-user-input-recovery.js';
import type { TelegramNotifier } from '../notifications/telegram.js';
import type { TelegramSettingsStore } from '../notifications/telegram-settings-store.js';
import type { IShareStore } from '../chats/share-store.js';
import type { ApiProviderService } from '../api-providers/service.js';
import type { ChatCommandService } from '../commands/chat-command-service.js';
import type { AgentSwitchService } from '../agents/agent-switch-service.js';
import type { SnippetService } from '../snippets/service.js';
import type { ModelCatalogResponseCache } from './model-catalog-cache.js';
import type { LastSelectedChatState } from '../chats/last-selected-chat-state.js';
import type { ScheduledPromptScheduler } from '../scheduled-prompts/scheduler.js';
import type { ChatListProjector } from '../chats/chat-list-projector.js';
import type { TerminalManager } from '../terminals/terminal-manager.js';
import type { TranscriptSearchController } from '../chats/search/controller.js';
import type { TranscriptSearchSettingsCoordinator } from '../chats/search/settings-coordinator.js';

export default function createAllRoutes({
  registry,
  settings,
  queue,
  pathCache,
  metadata,
  chatViews,
  agents,
  pendingInputs,
  pendingInputRecovery,
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
  terminals,
  searchIndex,
  transcriptSearchSettings,
}: {
  registry: IChatRegistry;
  settings: SettingsStore;
  queue: ChatExecutionService;
  pathCache: PathCache;
  metadata: MetadataIndex;
  chatViews: ChatViewPageReader;
  agents: AgentRegistry;
  pendingInputs: PendingUserInputServiceContract;
  pendingInputRecovery: PendingUserInputRecoveryCoordinator;
  telegramNotifier: TelegramNotifier;
  telegramSettings: TelegramSettingsStore;
  shareStore: IShareStore;
  apiProviders: ApiProviderService;
  chatCommands: ChatCommandService;
  chatListProjector: ChatListProjector;
  agentSwitch: AgentSwitchService;
  modelCatalogResponseCache: ModelCatalogResponseCache;
  lastSelectedChat: LastSelectedChatState;
  scheduledPrompts: ScheduledPromptScheduler;
  snippets: SnippetService;
  terminals: TerminalManager;
  searchIndex: TranscriptSearchController;
  transcriptSearchSettings: TranscriptSearchSettingsCoordinator;
}): RouteMap {
  return {
    ...createStaticRoutes(settings),
    ...authRoutes,
    ...createAgentRoutes({ agents, apiProviders }),
    ...createApiProviderRoutes(apiProviders, modelCatalogResponseCache),
    ...createChatRoutes({
      registry,
      settings,
      queue,
      pathCache,
      metadata,
      chatViews,
      agents,
      pendingInputs,
      pendingInputRecovery,
      commandService: chatCommands,
      chatListProjector,
      agentSwitch,
      lastSelectedChat,
      searchIndex,
    }),
    ...createShareRoutes(shareStore, registry, settings, metadata, chatViews),
    ...createFilesRoutes(registry),
    ...createCommandsRoutes({ registry, agents }),
    ...createWorkspaceRoutes(
      settings,
      agents,
      telegramNotifier,
      telegramSettings,
      registry,
      transcriptSearchSettings,
    ),
    ...createModelsRoutes({
      modelCatalog: { agents, apiProviders },
      responseCache: modelCatalogResponseCache,
    }),
    ...createGitRoutes(agents, settings),
    ...createGhRoutes(),
    ...createScheduledPromptRoutes(scheduledPrompts),
    ...createSnippetRoutes(snippets),
    ...createTerminalRoutes(terminals),
  };
}
