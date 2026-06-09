import { runSingleQuery as runSingleQueryPi, type PiCliRuntime } from './pi-cli.js';
import { forkPiSession } from './pi-fork.js';
import {
  getPiPreviewFromSessionId,
  getPiPreviewFromSessionPath,
  loadPiChatMessages,
  loadPiChatMessagesBySessionId,
} from './history-loader.js';
import { getPiModelsStrict } from './pi-models.js';
import { findPiSessionFileBySessionId } from './pi-session-paths.js';
import { getPiAuthStatus } from './pi-auth.js';
import { createAgentCapabilities } from '../capabilities.js';
import { createArtificialNativePath, isArtificialNativePath } from '../../chats/artificial-native-path.js';
import type { Agent } from '../types.js';
import type { AgentChatEntry } from '../session-types.js';

function hasRealPiNativePath(session: AgentChatEntry): session is AgentChatEntry & { nativePath: string } {
  return Boolean(session.nativePath) && !isArtificialNativePath(session.nativePath);
}

export function createPiAgent(pi: PiCliRuntime): Agent {
  return {
    id: 'pi',
    label: 'Pi',
    runtime: pi,
    transcript: {
      async loadMessages(session) {
        if (hasRealPiNativePath(session)) return loadPiChatMessages(session.nativePath);
        if (!session.agentSessionId) return [];
        return loadPiChatMessagesBySessionId(session.agentSessionId, session.projectPath);
      },
      async getPreview(session) {
        if (hasRealPiNativePath(session)) return getPiPreviewFromSessionPath(session.nativePath);
        if (!session.agentSessionId) return null;
        return getPiPreviewFromSessionId(session.agentSessionId, session.projectPath);
      },
      async resolveNativePath(session) {
        if (!session.agentSessionId) return null;
        const found = await findPiSessionFileBySessionId(session.agentSessionId, session.projectPath);
        return found || createArtificialNativePath(session.agentId, session.agentSessionId);
      },
    },
    auth: { getAuthStatus: () => getPiAuthStatus() },
    capabilities: createAgentCapabilities({
      supportsFork: true,
      supportsImages: false,
      acceptsApiProviderEndpoints: false,
      supportedProtocols: [],
      authLoginSupported: false,
      getModels: (query) => query?.strict ? getPiModelsStrict() : pi.getModels(),
    }),
    forkSession({ sourceSession }) {
      return forkPiSession(sourceSession);
    },
    runSingleQuery: runSingleQueryPi,
  };
}
