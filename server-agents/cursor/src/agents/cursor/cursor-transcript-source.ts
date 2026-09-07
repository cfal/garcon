import type { ChatMessage } from '@garcon/common/chat-types';
import { getCursorAgentSessionIdFromNativePath } from './cursor-native-path.js';
import {
  cursorStoreDbPath,
  loadImportableCursorChatMessagesBySessionId,
} from './history-loader.js';

export interface CursorTranscriptReference {
  readonly agentSessionId?: string | null;
  readonly nativePath?: string | null;
  readonly projectPath: string;
}

export interface CursorTranscriptReader {
  loadMessages(session: CursorTranscriptReference): Promise<ChatMessage[]>;
  sourcePath(session: CursorTranscriptReference): string | null;
}

// Cursor ACP sessions persist SQLite transcripts under ~/.cursor/acp-sessions.
export function createCursorTranscriptSource(
  options: { readonly cursorHome?: string } = {},
): CursorTranscriptReader {
  const sessionId = (session: CursorTranscriptReference): string => (
    session.agentSessionId
      || getCursorAgentSessionIdFromNativePath(session.nativePath)
      || ''
  );
  return {
    async loadMessages(session): Promise<ChatMessage[]> {
      return loadImportableCursorChatMessagesBySessionId(
        sessionId(session),
        session.projectPath,
        options.cursorHome,
      );
    },
    sourcePath(session): string | null {
      const id = sessionId(session);
      return id ? cursorStoreDbPath(id, session.projectPath, options.cursorHome) : null;
    },
  };
}
