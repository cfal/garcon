import type { ChatMessage } from '../../../common/chat-types.js';
import { runSingleQuery as runSingleQueryCodex } from './app-server/run-single-query.js';
import type { CodexAppServerProvider } from './app-server/provider.js';
import { getCodexAuthStatus } from './codex-auth.js';
import { launchProviderAuthLogin } from '../auth-login.js';
import { createAgentCapabilities } from '../capabilities.js';
import type { Agent } from '../types.js';

export function createCodexAgent(codex: CodexAppServerProvider): Agent {
  return {
    id: 'codex',
    label: 'Codex',
    runtime: codex,
    transcript: {
      async loadMessages(session): Promise<ChatMessage[]> {
        return await codex.loadMessages(session) as ChatMessage[];
      },
      getPreview(session) {
        return codex.getPreview(session);
      },
    },
    auth: {
      getAuthStatus: () => getCodexAuthStatus(),
      launchLogin: () => launchProviderAuthLogin('codex'),
    },
    capabilities: createAgentCapabilities({
      supportsFork: true,
      supportsImages: true,
      acceptsApiProviderEndpoints: true,
      supportedProtocols: ['openai-compatible'],
      authLoginSupported: true,
    }),
    forkSession(args) {
      return codex.forkSession(args);
    },
    runSingleQuery: runSingleQueryCodex,
  };
}
