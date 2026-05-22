import type { ChatMessage } from '../../../common/chat-types.js';
import { runSingleQuery as runSingleQueryCodex } from '../../providers/codex-app-server/run-single-query.js';
import type { CodexAppServerProvider } from '../../providers/codex-app-server/provider.js';
import { getCodexAuthStatus } from '../../providers/codex-auth.js';
import { launchProviderAuthLogin } from '../../providers/auth-login.js';
import { createHarnessCapabilities } from '../capabilities.js';
import type { Harness } from '../types.js';

export function createCodexHarness(codex: CodexAppServerProvider): Harness {
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
    capabilities: createHarnessCapabilities({
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
