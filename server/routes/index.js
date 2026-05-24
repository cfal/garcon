import authRoutes from './auth.js';
import staticRoutes from './static.js';
import createFilesRoutes from './files.js';
import createAgentRoutes from './agents.js';
import createApiProviderRoutes from './api-providers.js';
import createModelsRoutes from './models.js';
import createGitRoutes from './git.js';
import createChatRoutes from './chats.js';
import createShareRoutes from './shares.js';
import createWorkspaceRoutes from './workspace.js';

export default function createAllRoutes(registry, settings, queue, pathCache, metadata, historyCache, agents, pendingInputs, telegramNotifier, telegramSettings, shareStore, apiProviders, chatCommands) {
  return {
    ...staticRoutes,
    ...authRoutes,
    ...createAgentRoutes({ agents, apiProviders }),
    ...createApiProviderRoutes(apiProviders),
    ...createChatRoutes(registry, settings, queue, pathCache, metadata, historyCache, agents, pendingInputs, chatCommands),
    ...createShareRoutes(shareStore, registry, settings, metadata, historyCache),
    ...createFilesRoutes(registry),
    ...createWorkspaceRoutes(settings, agents, telegramNotifier, telegramSettings),
    ...createModelsRoutes({ agents, apiProviders }),
    ...createGitRoutes(agents, settings),
  };
}
