import type { ChatMessage } from '../../../common/chat-types.js';
import { CursorRequestIdentityStore } from './cursor-request-identities.js';
import { getCursorAgentSessionIdFromNativePath } from './cursor-native-path.js';
import { getCursorPreviewFromSessionId, loadCursorChatMessagesBySessionId } from './history-loader.js';
import type { AgentChatEntry } from '../session-types.js';
import type { AgentTranscriptSource } from '../types.js';

// Cursor ACP sessions persist SQLite transcripts under ~/.cursor/acp-sessions.
export function createCursorTranscriptSource(
  requestIdentities: CursorRequestIdentityStore,
): AgentTranscriptSource {
  return {
    async loadMessages(session: AgentChatEntry, context?: { chatId?: string }): Promise<ChatMessage[]> {
      const agentSessionId = session.agentSessionId
        || getCursorAgentSessionIdFromNativePath(session.nativePath)
        || '';
      const messages = await loadCursorChatMessagesBySessionId(agentSessionId, session.projectPath);
      return requestIdentities.applyToMessages(messages, {
        chatId: context?.chatId,
        agentSessionId,
      });
    },
    async getPreview(session: AgentChatEntry): Promise<unknown> {
      const agentSessionId = session.agentSessionId
        || getCursorAgentSessionIdFromNativePath(session.nativePath)
        || '';
      return getCursorPreviewFromSessionId(agentSessionId, session.projectPath);
    },
  };
}
