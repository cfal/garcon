import type { ChatMessage } from '../../../common/chat-types.js';
import { runSingleQuery as runSingleQueryCodex } from './app-server/run-single-query.js';
import type { CodexAppServerRuntime } from './app-server/runtime.js';
import { getCodexAuthStatus } from './codex-auth.js';
import { getAgentAuthLoginStatus, launchAgentAuthLogin } from '../auth-login.js';
import { createAgentCapabilities } from '../capabilities.js';
import type { Agent } from '../types.js';
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
      async resolveSearchLoadPlan(session) {
        const nativePath = session.nativePath ?? await codex.resolveNativePath(session);
        if (!nativePath) return { kind: 'live-only', reasonCode: 'source-unavailable', retryable: true };
        return { kind: 'detached', source: { kind: 'codex-jsonl', nativePath } };
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
