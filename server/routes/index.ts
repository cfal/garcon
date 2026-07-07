import authRoutes from './auth.js';
import createStaticRoutes from './static.js';
import createFilesRoutes from './files.js';
import createCommandsRoutes from './commands.js';
import createAgentRoutes from './agents.js';
import createApiProviderRoutes from './api-providers.js';
import createModelsRoutes from './models.js';
import createGitRoutes from './git.js';
import createChatRoutes from './chats.js';
import createShareRoutes from './shares.js';
import createWorkspaceRoutes from './workspace.js';
import type { RouteMap } from '../lib/http-route-types.js';
import type { IChatRegistry } from '../chats/store.js';
import type { SettingsStore } from '../settings/store.js';
import type { ChatQueueService } from '../queue.js';
import type { PathCache } from '../chats/path-cache.js';
import type { MetadataIndex } from '../chats/metadata-store.js';
import type { ChatViewPageReader } from '../chats/chat-message-reader.js';
import type { AgentRegistry } from '../agents/registry.js';
import type { PendingUserInputServiceContract } from '../chats/pending-user-input-service.js';
import type { TelegramNotifier } from '../notifications/telegram.js';
import type { TelegramSettingsStore } from '../notifications/telegram-settings-store.js';
import type { IShareStore } from '../chats/share-store.js';
import type { ApiProviderService } from '../api-providers/service.js';
import type { ChatCommandService } from '../commands/chat-command-service.js';
import type { AgentSwitchService } from '../agents/agent-switch-service.js';
import type { ModelCatalogResponseCache } from './model-catalog-cache.js';
import type { LastSelectedChatState } from '../chats/last-selected-chat-state.js';

export default function createAllRoutes({
  registry,
  settings,
  queue,
  pathCache,
  metadata,
  chatViews,
  agents,
  pendingInputs,
  telegramNotifier,
  telegramSettings,
  shareStore,
  apiProviders,
  chatCommands,
  agentSwitch,
  modelCatalogResponseCache,
  lastSelectedChat,
}: {
  registry: IChatRegistry;
  settings: SettingsStore;
  queue: ChatQueueService;
  pathCache: PathCache;
  metadata: MetadataIndex;
  chatViews: ChatViewPageReader;
  agents: AgentRegistry;
  pendingInputs: PendingUserInputServiceContract;
  telegramNotifier: TelegramNotifier;
  telegramSettings: TelegramSettingsStore;
  shareStore: IShareStore;
  apiProviders: ApiProviderService;
  chatCommands: ChatCommandService;
  agentSwitch: AgentSwitchService;
  modelCatalogResponseCache: ModelCatalogResponseCache;
  lastSelectedChat: LastSelectedChatState;
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
      commandService: chatCommands,
      agentSwitch,
      lastSelectedChat,
    }),
    ...createShareRoutes(shareStore, registry, settings, metadata, chatViews),
    ...createFilesRoutes(registry),
    ...createCommandsRoutes({ registry, agents }),
    ...createWorkspaceRoutes(settings, agents, telegramNotifier, telegramSettings, registry),
    ...createModelsRoutes({
      modelCatalog: { agents, apiProviders },
      responseCache: modelCatalogResponseCache,
    }),
    ...createGitRoutes(agents, settings),
  };
}
