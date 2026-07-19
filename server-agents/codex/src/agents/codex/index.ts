import type { ChatMessage } from '@garcon/common/chat-types';
import { runSingleQuery as runSingleQueryCodex } from './app-server/run-single-query.js';
import type { CodexAppServerRuntime } from './app-server/runtime.js';
import { getCodexAuthStatus } from './codex-auth.js';
import { getAgentAuthLoginStatus, launchAgentAuthLogin } from '../auth-login.js';
import { createAgentCapabilities } from '@garcon/server-agent-common/legacy/capabilities';
import type { Agent } from '@garcon/server-agent-common/legacy/types';
import { buildCodexAppServerEndpointRuntime } from './app-server/endpoint-runtime.js';
import { getCodexSlashCommands } from './slash-command-discovery.js';
import { rewriteCodexForkTranscriptEntry } from './fork-transcript.js';

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
      rewriteForkTranscriptEntry: rewriteCodexForkTranscriptEntry,
    },
    auth: {
      getAuthStatus: () => getCodexAuthStatus(),
      launchLogin: () => launchAgentAuthLogin('codex'),
      loginStatus: (expectedSessionId) => getAgentAuthLoginStatus('codex', expectedSessionId),
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
