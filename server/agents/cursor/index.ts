import { CursorRuntime, runSingleQuery as runSingleQueryCursor } from './cursor-cli.js';
import { getCursorModels } from './cursor-models.js';
import { CursorRequestIdentityStore } from './cursor-request-identities.js';
import { createAgentCapabilities } from '../capabilities.js';
import type { Agent } from '../types.js';
import { cursorAuthDriver } from './cursor-auth-driver.js';
import { createCursorTranscriptSource } from './cursor-transcript-source.js';
import { createCursorStreamJsonNativePath } from './cursor-native-path.js';
import { forkCursorStreamJsonSession } from './cursor-session-store.js';

export interface CreateCursorAgentArgs {
  workspaceDir: string;
  cursorHome?: string;
  createSessionId?: () => string;
}

export function createCursorAgent(args: CreateCursorAgentArgs): Agent {
  const requestIdentities = new CursorRequestIdentityStore(args.workspaceDir);
  const runtime = new CursorRuntime(requestIdentities);
  const transcript = createCursorTranscriptSource(requestIdentities);

  return {
    id: 'cursor',
    label: 'Cursor',
    runtime,
    transcript: {
      loadMessages: transcript.loadMessages,
      getPreview: transcript.getPreview,
      async resolveNativePath(session) {
        if (!session.agentSessionId) return null;
        return createCursorStreamJsonNativePath(session.agentSessionId);
      },
    },
    auth: cursorAuthDriver,
    capabilities: createAgentCapabilities({
      supportsFork: true,
      supportsImages: false,
      acceptsApiProviderEndpoints: false,
      supportedProtocols: [],
      authLoginSupported: false,
      getModels: getCursorModels,
    }),
    forkSession({ sourceSession }) {
      return forkCursorStreamJsonSession(sourceSession, {
        cursorHome: args.cursorHome,
        createSessionId: args.createSessionId,
      });
    },
    runSingleQuery(prompt, options) {
      return runSingleQueryCursor(prompt, options);
    },
  };
}
