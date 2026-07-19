import { createAgentCapabilities } from '@garcon/server-agent-common/legacy/capabilities';
import { createArtificialNativePath, isArtificialNativePath } from '@garcon/server-agent-common/chats/artificial-native-path';
import type { Agent, AgentRuntime } from '@garcon/server-agent-common/legacy/types';
import type { AgentChatEntry } from '@garcon/server-agent-common/legacy/session-types';

function hasRealPiNativePath(session: AgentChatEntry): session is AgentChatEntry & { nativePath: string } {
  return Boolean(session.nativePath) && !isArtificialNativePath(session.nativePath);
}

export function createPiAgent(pi: AgentRuntime): Agent {
  return {
    id: 'pi',
    label: 'Pi',
    runtime: pi,
    transcript: {
      async loadMessages(session) {
        const history = await import('./history-loader.js');
        if (hasRealPiNativePath(session)) return history.loadPiChatMessages(session.nativePath);
        if (!session.agentSessionId) return [];
        return history.loadPiChatMessagesBySessionId(session.agentSessionId, session.projectPath);
      },
      async getPreview(session) {
        const history = await import('./history-loader.js');
        if (hasRealPiNativePath(session)) return history.getPiPreviewFromSessionPath(session.nativePath);
        if (!session.agentSessionId) return null;
        return history.getPiPreviewFromSessionId(session.agentSessionId, session.projectPath);
      },
      async resolveNativePath(session) {
        if (!session.agentSessionId) return null;
        const { findPiSessionFileBySessionId } = await import('./pi-session-paths.js');
        const found = await findPiSessionFileBySessionId(session.agentSessionId, session.projectPath);
        return found || createArtificialNativePath(session.agentId, session.agentSessionId);
      },
    },
    auth: {
      async getAuthStatus() {
        const { getPiAuthStatus } = await import('./pi-auth.js');
        return getPiAuthStatus();
      },
    },
    capabilities: createAgentCapabilities({
      supportsFork: true,
      supportsForkAtMessage: false,
      supportsUpdateProjectPath: true,
      requiresNativePathForProjectPathUpdate: true,
      supportsImages: false,
      acceptsApiProviderEndpoints: false,
      supportedProtocols: [],
      authLoginSupported: false,
      requiresStrictModelDiscovery: true,
      async getModels(query) {
        const models = await import('./pi-models.js');
        return query?.strict ? models.getPiModelsStrict() : models.getPiModels();
      },
    }),
    forkSession({ sourceSession }) {
      return import('./pi-fork.js').then(({ forkPiSession }) => forkPiSession(sourceSession));
    },
    runSingleQuery(prompt, options) {
      return import('./pi-cli.js').then(({ runSingleQuery }) => runSingleQuery(prompt, options));
    },
  };
}
