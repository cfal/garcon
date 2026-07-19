import type { ChatMessage } from '@garcon/common/chat-types';
import { CursorRequestIdentityStore } from './cursor-request-identities.js';
import { getCursorAgentSessionIdFromNativePath } from './cursor-native-path.js';
import { getCursorPreviewFromSessionId, loadCursorChatMessagesBySessionId } from './history-loader.js';

export interface CursorTranscriptReference {
  readonly agentSessionId?: string | null;
  readonly nativePath?: string | null;
  readonly projectPath: string;
}

export interface CursorTranscriptReader {
  loadMessages(
    session: CursorTranscriptReference,
    context?: { readonly chatId?: string },
  ): Promise<ChatMessage[]>;
  getPreview(session: CursorTranscriptReference): Promise<unknown>;
}

// Cursor ACP sessions persist SQLite transcripts under ~/.cursor/acp-sessions.
export function createCursorTranscriptSource(
  requestIdentities: CursorRequestIdentityStore,
): CursorTranscriptReader {
  return {
    async loadMessages(session, context): Promise<ChatMessage[]> {
      const agentSessionId = session.agentSessionId
        || getCursorAgentSessionIdFromNativePath(session.nativePath)
        || '';
      const messages = await loadCursorChatMessagesBySessionId(agentSessionId, session.projectPath);
      return requestIdentities.applyToMessages(messages, {
        chatId: context?.chatId,
        agentSessionId,
      });
    },
    async getPreview(session): Promise<unknown> {
      const agentSessionId = session.agentSessionId
        || getCursorAgentSessionIdFromNativePath(session.nativePath)
        || '';
      return getCursorPreviewFromSessionId(agentSessionId, session.projectPath);
    },
  };
}
