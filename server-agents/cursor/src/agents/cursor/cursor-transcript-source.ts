import type { ChatMessage } from '@garcon/common/chat-types';
import { getCursorAgentSessionIdFromNativePath } from './cursor-native-path.js';
import { getCursorPreviewFromSessionId, loadCursorChatMessagesBySessionId } from './history-loader.js';

export interface CursorTranscriptReference {
  readonly agentSessionId?: string | null;
  readonly nativePath?: string | null;
  readonly projectPath: string;
}

export interface CursorTranscriptReader {
  loadMessages(session: CursorTranscriptReference): Promise<ChatMessage[]>;
  getPreview(session: CursorTranscriptReference): Promise<unknown>;
}

// Cursor ACP sessions persist SQLite transcripts under ~/.cursor/acp-sessions.
export function createCursorTranscriptSource(): CursorTranscriptReader {
  return {
    async loadMessages(session): Promise<ChatMessage[]> {
      const agentSessionId = session.agentSessionId
        || getCursorAgentSessionIdFromNativePath(session.nativePath)
        || '';
      return loadCursorChatMessagesBySessionId(agentSessionId, session.projectPath);
    },
    async getPreview(session): Promise<unknown> {
      const agentSessionId = session.agentSessionId
        || getCursorAgentSessionIdFromNativePath(session.nativePath)
        || '';
      return getCursorPreviewFromSessionId(agentSessionId, session.projectPath);
    },
  };
}
