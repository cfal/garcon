import type { ChatMessage } from '../../../common/chat-types.js';
import { getArtificialAgentSessionId } from '../../chats/artificial-native-path.js';
import { CursorRequestIdentityStore } from './cursor-request-identities.js';
import { getCursorPreviewFromSessionId, loadCursorChatMessagesBySessionId } from './history-loader.js';
import type { AgentChatEntry } from '../session-types.js';
import type { AgentTranscriptSource } from '../types.js';

// Keeps Cursor transcript hydration on SQLite while ACP replay remains unstable.
// Reference: https://forum.cursor.com/t/cursor-acp-session-load-fails-with-session-id-not-found-breaking-persistent-sessions-acpx-openclaw-acp-runtime/155516
// TODO(acp-replay): Replace SQLite history/preview loaders with ACP-native replay once Cursor session/load + resume are reliable.
export function createCursorTranscriptSource(
  requestIdentities: CursorRequestIdentityStore,
): AgentTranscriptSource {
  return {
    async loadMessages(session: AgentChatEntry, context?: { chatId?: string }): Promise<ChatMessage[]> {
      const agentSessionId = session.agentSessionId
        || getArtificialAgentSessionId(session.nativePath, 'cursor')
        || '';
      const messages = await loadCursorChatMessagesBySessionId(agentSessionId, session.projectPath);
      return requestIdentities.applyToMessages(messages, {
        chatId: context?.chatId,
        agentSessionId,
      });
    },
    async getPreview(session: AgentChatEntry): Promise<unknown> {
      const agentSessionId = session.agentSessionId
        || getArtificialAgentSessionId(session.nativePath, 'cursor')
        || '';
      return getCursorPreviewFromSessionId(agentSessionId, session.projectPath);
    },
  };
}
