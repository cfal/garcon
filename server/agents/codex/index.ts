import type { ChatMessage } from '../../../common/chat-types.js';
import { runSingleQuery as runSingleQueryCodex } from './app-server/run-single-query.js';
import type { CodexAppServerRuntime } from './app-server/runtime.js';
import { getCodexAuthStatus } from './codex-auth.js';
import { launchAgentAuthLogin } from '../auth-login.js';
import { createAgentCapabilities } from '../capabilities.js';
import type { Agent } from '../types.js';
import { buildCodexAppServerEndpointRuntime } from './app-server/endpoint-runtime.js';
import { getCodexSlashCommands } from './slash-command-discovery.js';

export function createCodexAgent(codex: CodexAppServerRuntime): Agent {
  return {
    id: 'codex',
    label: 'Codex',
    runtime: codex,
    transcript: {
      async loadMessages(session): Promise<ChatMessage[]> {
        return await codex.loadMessages(session) as ChatMessage[];
      },
      loadMessagePage(session, page) {
        return codex.loadMessagePage(session, page);
      },
      getPreview(session) {
        return codex.getPreview(session);
      },
      resolveNativePath(session) {
        return codex.resolveNativePath(session);
      },
    },
    auth: {
      getAuthStatus: () => getCodexAuthStatus(),
      launchLogin: () => launchAgentAuthLogin('codex'),
    },
    capabilities: createAgentCapabilities({
      supportsFork: true,
      supportsForkAtMessage: true,
      supportsForkWhileRunning: true,
      supportsUpdateProjectPath: true,
      supportsImages: true,
      acceptsApiProviderEndpoints: true,
      supportedProtocols: ['openai-compatible'],
      authLoginSupported: true,
    }),
    prepareEndpointRuntime: buildCodexAppServerEndpointRuntime,
    forkSession(args) {
      return codex.forkSession(args);
    },
    runSingleQuery: runSingleQueryCodex,
    discoverSlashCommands: (projectPath) => getCodexSlashCommands(projectPath),
  };
}
