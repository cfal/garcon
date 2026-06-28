import type { ChatMessage } from '../../../common/chat-types.js';
import type { AgentChatEntry } from '../session-types.js';
import type { AgentTranscriptSource } from '../types.js';
import {
  findFactorySessionFileBySessionId,
  getFactoryPreviewFromSessionPath,
  loadFactoryChatMessages,
} from './history-loader.js';

interface FactoryTranscriptSourceDeps {
  findSessionFileBySessionId: typeof findFactorySessionFileBySessionId;
  getPreviewFromSessionPath: typeof getFactoryPreviewFromSessionPath;
  loadFromPath: typeof loadFactoryChatMessages;
}

const DEFAULT_DEPS: FactoryTranscriptSourceDeps = {
  findSessionFileBySessionId: findFactorySessionFileBySessionId,
  getPreviewFromSessionPath: getFactoryPreviewFromSessionPath,
  loadFromPath: loadFactoryChatMessages,
};

function getFactoryNativePath(session: AgentChatEntry): string | null {
  return typeof session.nativePath === 'string' && session.nativePath.trim()
    ? session.nativePath
    : null;
}

export function createFactoryTranscriptSource(
  overrides: Partial<FactoryTranscriptSourceDeps> = {},
): AgentTranscriptSource {
  const deps = { ...DEFAULT_DEPS, ...overrides };

  return {
    async loadMessages(session: AgentChatEntry): Promise<ChatMessage[]> {
      const nativePath = getFactoryNativePath(session);
      if (!nativePath) return [];
      return deps.loadFromPath(nativePath);
    },

    async getPreview(session: AgentChatEntry): Promise<unknown> {
      const nativePath = getFactoryNativePath(session);
      if (!nativePath) return null;
      return deps.getPreviewFromSessionPath(nativePath);
    },

    async resolveNativePath(session: AgentChatEntry): Promise<string | null> {
      if (!session.agentSessionId) return null;
      return deps.findSessionFileBySessionId(session.agentSessionId);
    },
  };
}
