import type { ChatMessage } from '@garcon/common/chat-types';
import { CursorRequestIdentityStore } from './cursor-request-identities.js';
import { getCursorAgentSessionIdFromNativePath } from './cursor-native-path.js';
import { getCursorPreviewFromSessionId, loadCursorChatMessagesBySessionId } from './history-loader.js';
import type { AgentChatEntry } from '@garcon/server-agent-common/legacy/session-types';
import type { AgentTranscriptSource } from '@garcon/server-agent-common/legacy/types';

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
