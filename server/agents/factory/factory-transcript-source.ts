import type { ChatMessage } from '../../../common/chat-types.js';
import {
  createArtificialNativePath,
  getArtificialAgentSessionId,
  isArtificialNativePath,
} from '../../chats/artificial-native-path.js';
import type { AgentChatEntry } from '../session-types.js';
import type { AgentTranscriptSource } from '../types.js';
import {
  findFactorySessionFileBySessionId,
  getFactoryPreviewFromSessionId,
  getFactoryPreviewFromSessionPath,
  loadFactoryChatMessages,
  loadFactoryChatMessagesBySessionId,
} from './history-loader.js';

interface FactoryTranscriptSourceDeps {
  findSessionFileBySessionId: typeof findFactorySessionFileBySessionId;
  getPreviewFromSessionId: typeof getFactoryPreviewFromSessionId;
  getPreviewFromSessionPath: typeof getFactoryPreviewFromSessionPath;
  loadBySessionId: typeof loadFactoryChatMessagesBySessionId;
  loadFromPath: typeof loadFactoryChatMessages;
}

const DEFAULT_DEPS: FactoryTranscriptSourceDeps = {
  findSessionFileBySessionId: findFactorySessionFileBySessionId,
  getPreviewFromSessionId: getFactoryPreviewFromSessionId,
  getPreviewFromSessionPath: getFactoryPreviewFromSessionPath,
  loadBySessionId: loadFactoryChatMessagesBySessionId,
  loadFromPath: loadFactoryChatMessages,
};

function hasRealFactoryNativePath(session: AgentChatEntry): session is AgentChatEntry & { nativePath: string } {
  return Boolean(session.nativePath) && !isArtificialNativePath(session.nativePath);
}

function getFactoryAgentSessionId(session: AgentChatEntry): string | null {
  return session.agentSessionId || getArtificialAgentSessionId(session.nativePath, 'factory');
}

export function createFactoryTranscriptSource(
  overrides: Partial<FactoryTranscriptSourceDeps> = {},
): AgentTranscriptSource {
  const deps = { ...DEFAULT_DEPS, ...overrides };

  return {
    async loadMessages(session: AgentChatEntry): Promise<ChatMessage[]> {
      if (hasRealFactoryNativePath(session)) return deps.loadFromPath(session.nativePath);
      const sessionId = getFactoryAgentSessionId(session);
      if (!sessionId) return [];
      return deps.loadBySessionId(sessionId);
    },

    async getPreview(session: AgentChatEntry): Promise<unknown> {
      if (hasRealFactoryNativePath(session)) return deps.getPreviewFromSessionPath(session.nativePath);
      const sessionId = getFactoryAgentSessionId(session);
      if (!sessionId) return null;
      return deps.getPreviewFromSessionId(sessionId);
    },

    async resolveNativePath(session: AgentChatEntry): Promise<string | null> {
      const sessionId = getFactoryAgentSessionId(session);
      if (!sessionId) return null;

      const found = await deps.findSessionFileBySessionId(sessionId);
      if (found) return found;

      // Keeps unresolved Factory chats visible until Droid materializes or reindexes
      // the real JSONL path. Real provider transcripts must remain provider-owned.
      return createArtificialNativePath('factory', sessionId);
    },
  };
}
