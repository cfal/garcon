import { runSingleQuery as runSingleQueryCursor } from './run-single-query.js';
import { getCursorModels } from './cursor-models.js';
import { CursorRequestIdentityStore } from './cursor-request-identities.js';
import { createAgentCapabilities } from '../capabilities.js';
import type { Agent } from '../types.js';
import { cursorAuthDriver } from './cursor-auth-driver.js';
import { createCursorTranscriptSource } from './cursor-transcript-source.js';
import { createCursorAcpNativePath } from './cursor-native-path.js';
import { forkCursorAcpSession } from './cursor-session-store.js';
import { AcpAgentRuntime } from '../shared/acp-agent-runtime.js';
import { createCursorAcpPolicy } from './cursor-acp-policy.js';
import { CursorAcpEventConverter } from './cursor-acp-event-converter.js';

export interface CreateCursorAgentArgs {
  workspaceDir: string;
  cursorHome?: string;
  createSessionId?: () => string;
}

export function createCursorAgent(args: CreateCursorAgentArgs): Agent {
  const requestIdentities = new CursorRequestIdentityStore(args.workspaceDir);
  const runtime = new AcpAgentRuntime(createCursorAcpPolicy(), {
    converter: new CursorAcpEventConverter(),
  });
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
        return createCursorAcpNativePath(session.agentSessionId);
      },
    },
    auth: cursorAuthDriver,
    capabilities: createAgentCapabilities({
      supportsFork: true,
      supportsForkAtMessage: false,
      supportsUpdateProjectPath: true,
      supportsImages: false,
      acceptsApiProviderEndpoints: false,
      supportedProtocols: [],
      authLoginSupported: false,
      getModels: getCursorModels,
    }),
    forkSession({ sourceSession }) {
      return forkCursorAcpSession(sourceSession, {
        cursorHome: args.cursorHome,
        createSessionId: args.createSessionId,
      });
    },
    runSingleQuery(prompt, options) {
      return runSingleQueryCursor(prompt, options);
    },
  };
}
