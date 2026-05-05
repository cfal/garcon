import authRoutes from './auth.js';
import staticRoutes from './static.js';
import createFilesRoutes from './files.js';
import createProviderRoutes from './providers.js';
import createModelsRoutes from './models.js';
import createGitRoutes from './git.js';
import createChatRoutes from './chats.js';
import createShareRoutes from './shares.js';
import createWorkspaceRoutes from './workspace.js';

export default function createAllRoutes(registry, settings, queue, pathCache, metadata, historyCache, providers, telegramNotifier, shareStore) {
  return {
    ...staticRoutes,
    ...authRoutes,
    ...createProviderRoutes(providers),
    ...createChatRoutes(registry, settings, queue, pathCache, metadata, historyCache, providers),
    ...createShareRoutes(shareStore, registry, settings, metadata, historyCache),
    ...createFilesRoutes(registry),
    ...createWorkspaceRoutes(settings, providers, telegramNotifier),
    ...createModelsRoutes(providers),
    ...createGitRoutes(providers, settings),
  };
}
