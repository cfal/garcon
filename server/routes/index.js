import authRoutes from './auth.js';
import staticRoutes from './static.js';
import createFilesRoutes from './files.js';
import createProviderRoutes from './providers.js';
import createModelsRoutes from './models.js';
import createGitRoutes from './git.js';
import createChatRoutes from './chats.js';
import createWorkspaceRoutes from './workspace.js';

export default function createAllRoutes(registry, settings, queue, pathCache, metadata, historyCache, providers) {
  return {
    ...staticRoutes,
    ...authRoutes,
    ...createProviderRoutes(providers),
    ...createChatRoutes(registry, settings, queue, pathCache, metadata, historyCache, providers),
    ...createFilesRoutes(registry),
    ...createWorkspaceRoutes(settings, providers),
    ...createModelsRoutes(providers),
    ...createGitRoutes(providers, settings),
  };
}
