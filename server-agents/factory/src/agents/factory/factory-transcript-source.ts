import type { ChatMessage } from '@garcon/common/chat-types';
import type { AgentLogger } from '@garcon/server-agent-interface';
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

const SILENT_LOGGER: AgentLogger = {
  debug() {}, info() {}, warn() {}, error() {},
};

export interface FactoryTranscriptReference {
  readonly agentSessionId?: string | null;
  readonly nativePath?: string | null;
}

export interface FactoryTranscriptReader {
  loadMessages(session: FactoryTranscriptReference): Promise<ChatMessage[]>;
  getPreview(session: FactoryTranscriptReference): Promise<unknown>;
  resolveNativePath(session: FactoryTranscriptReference): Promise<string | null>;
}

function getFactoryNativePath(session: FactoryTranscriptReference): string | null {
  return typeof session.nativePath === 'string' && session.nativePath.trim()
    ? session.nativePath
    : null;
}

export function createFactoryTranscriptSource(
  overrides: Partial<FactoryTranscriptSourceDeps> = {},
  logger: AgentLogger = SILENT_LOGGER,
): FactoryTranscriptReader {
  const deps: FactoryTranscriptSourceDeps = {
    findSessionFileBySessionId: findFactorySessionFileBySessionId,
    getPreviewFromSessionPath: (sessionPath) => getFactoryPreviewFromSessionPath(
      sessionPath,
      {},
      logger,
    ),
    loadFromPath: (sessionPath) => loadFactoryChatMessages(sessionPath, logger),
    ...overrides,
  };

  return {
    async loadMessages(session: FactoryTranscriptReference): Promise<ChatMessage[]> {
      const nativePath = getFactoryNativePath(session);
      if (!nativePath) return [];
      return deps.loadFromPath(nativePath);
    },

    async getPreview(session: FactoryTranscriptReference): Promise<unknown> {
      const nativePath = getFactoryNativePath(session);
      if (!nativePath) return null;
      return deps.getPreviewFromSessionPath(nativePath);
    },

    async resolveNativePath(session: FactoryTranscriptReference): Promise<string | null> {
      if (!session.agentSessionId) return null;
      return deps.findSessionFileBySessionId(session.agentSessionId);
    },
  };
}
