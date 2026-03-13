import identityRoutes from './identity.js';
import codexRoutes from './codex.js';
import claudeRoutes from './claude.js';
import ampRoutes from './amp.js';
import staticRoutes from './static.js';
import createFilesRoutes from './files.js';
import createOpenCodeRoutes from './opencode.js';
import createModelsRoutes from './models.js';
import createGitRoutes from './git.js';
import createChatRoutes from './chats.js';
import createWorkspaceRoutes from './workspace.js';

export default function createAllRoutes(registry, settings, queue, pathCache, metadata, historyCache, providers, opencode) {
  return {
    ...staticRoutes,
    ...identityRoutes,
    ...codexRoutes,
    ...claudeRoutes,
    ...ampRoutes,
    ...createChatRoutes(registry, settings, queue, pathCache, metadata, historyCache, providers),
    ...createFilesRoutes(registry),
    ...createWorkspaceRoutes(settings, providers),
    ...createModelsRoutes(providers),
    ...createGitRoutes(providers, settings),
    ...createOpenCodeRoutes(opencode),
  };
}
