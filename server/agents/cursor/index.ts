import { runSingleQuery as runSingleQueryCursor } from './run-single-query.js';
import { getCursorModels } from './cursor-models.js';
import { CursorRequestIdentityStore } from './cursor-request-identities.js';
import { createAgentCapabilities } from '../capabilities.js';
import { AcpAgentRuntime } from '../shared/acp-agent-runtime.js';
import type { Agent } from '../types.js';
import { createCursorAcpPolicy } from './cursor-acp-policy.js';
import { CursorAcpEventConverter } from './cursor-acp-event-converter.js';
import { cursorAuthDriver } from './cursor-auth-driver.js';
import { CursorReplayHealth } from './cursor-replay-health.js';
import { createCursorTranscriptSource } from './cursor-transcript-source.js';
import { createArtificialNativePath } from '../../chats/artificial-native-path.js';

export interface CreateCursorAgentArgs {
  workspaceDir: string;
}

export function createCursorAgent(args: CreateCursorAgentArgs): Agent {
  const requestIdentities = new CursorRequestIdentityStore(args.workspaceDir);
  const replayHealth = new CursorReplayHealth();
  const runtime = new AcpAgentRuntime(createCursorAcpPolicy(), {
    converter: new CursorAcpEventConverter(),
  });
  const transcript = createCursorTranscriptSource(requestIdentities);

  return {
    id: 'cursor',
    label: 'Cursor',
    runtime,
    transcript: {
      async loadMessages(session, context) {
        const messages = await transcript.loadMessages(session, context);
        replayHealth.record({
          loadedAt: new Date().toISOString(),
          replayUpdates: 0,
          success: true,
        });
        return messages;
      },
      getPreview: transcript.getPreview,
      async resolveNativePath(session) {
        if (!session.agentSessionId) return null;
        return createArtificialNativePath('cursor', session.agentSessionId);
      },
    },
    auth: cursorAuthDriver,
    capabilities: createAgentCapabilities({
      supportsFork: false,
      supportsImages: false,
      acceptsApiProviderEndpoints: false,
      supportedProtocols: [],
      authLoginSupported: false,
      getModels: getCursorModels,
    }),
    runSingleQuery(prompt, options) {
      return runSingleQueryCursor(prompt, options);
    },
  };
}
