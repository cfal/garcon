import { runSingleQuery as runSingleQueryAmp, type AmpCliRuntime } from './amp-cli.js';
import { getAmpAuthStatus } from './amp-auth.js';
import { createAgentCapabilities } from '@garcon/server-agent-common/legacy/capabilities';
import type { Agent, AgentTranscriptSource } from '@garcon/server-agent-common/legacy/types';
import { getArtificialAgentSessionId } from '@garcon/server-agent-common/chats/artificial-native-path';
import { getAmpPreview, loadAmpChatMessages } from './history-loader.js';

function createAmpTranscriptSource(amp: AmpCliRuntime): AgentTranscriptSource {
  const threadId = (session: Parameters<AgentTranscriptSource['loadMessages']>[0]): string | null => (
    session.agentSessionId
    ?? getArtificialAgentSessionId(session.nativePath, 'amp')
  );
  return {
    async loadMessages(session) {
      const id = threadId(session);
      if (!id) return [];
      return loadAmpChatMessages(await amp.exportThread(id, { cwd: session.projectPath }));
    },
    async getPreview(session) {
      const id = threadId(session);
      if (!id) return null;
      return getAmpPreview(await amp.exportThread(id, { cwd: session.projectPath }));
    },
    async resolveNativePath(session) {
      const id = threadId(session);
      return id ? `!amp:${id}` : null;
    },
  };
}

export function createAmpAgent(amp: AmpCliRuntime): Agent {
  return {
    id: 'amp',
    label: 'Amp',
    runtime: amp,
    transcript: createAmpTranscriptSource(amp),
    auth: { getAuthStatus: () => getAmpAuthStatus() },
    capabilities: createAgentCapabilities({
      supportsFork: false,
      supportsImages: false,
      acceptsApiProviderEndpoints: false,
      supportedProtocols: [],
      authLoginSupported: false,
    }),
    runSingleQuery: runSingleQueryAmp,
  };
}
