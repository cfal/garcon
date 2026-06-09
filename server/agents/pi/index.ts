import { runSingleQuery as runSingleQueryPi, type PiCliRuntime } from './pi-cli.js';
import { forkPiSession } from './pi-fork.js';
import { getPiModelsStrict } from './pi-models.js';
import { findPiSessionFileBySessionId } from './pi-session-paths.js';
import { getPiAuthStatus } from './pi-auth.js';
import { createAgentCapabilities } from '../capabilities.js';
import { createArtificialNativePath } from '../../chats/artificial-native-path.js';
import type { Agent } from '../types.js';

export function createPiAgent(pi: PiCliRuntime): Agent {
  return {
    id: 'pi',
    label: 'Pi',
    runtime: pi,
    transcript: {
      async loadMessages() {
        return [];
      },
      async getPreview() {
        return null;
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
