import type { ChatMessage } from '../../../../common/chat-types.js';
import { getArtificialProviderSessionId } from '../../../chats/artificial-native-path.js';
import type { HarnessTranscriptSource } from '../../harness-plugin.js';
import { CursorRequestIdentityStore } from '../../cursor-request-identities.js';
import { getCursorPreviewFromSessionId, loadCursorChatMessagesBySessionId } from '../../loaders/cursor-history-loader.js';
import type { ProviderChatEntry } from '../../types.js';

// Keeps Cursor transcript hydration on SQLite while ACP replay remains unstable.
// Reference: https://forum.cursor.com/t/cursor-acp-session-load-fails-with-session-id-not-found-breaking-persistent-sessions-acpx-openclaw-acp-runtime/155516
// TODO(acp-replay): Replace SQLite history/preview loaders with ACP-native replay once Cursor session/load + resume are reliable.
export function createCursorTranscriptSource(
  requestIdentities: CursorRequestIdentityStore,
): HarnessTranscriptSource {
  return {
    async loadMessages(session: ProviderChatEntry, context?: { chatId?: string }): Promise<ChatMessage[]> {
      const providerSessionId = session.providerSessionId
        || getArtificialProviderSessionId(session.nativePath, 'cursor')
        || '';
      const messages = await loadCursorChatMessagesBySessionId(providerSessionId, session.projectPath);
      return requestIdentities.applyToMessages(messages, {
        chatId: context?.chatId,
        providerSessionId,
      });
    },
    async getPreview(session: ProviderChatEntry): Promise<unknown> {
      const providerSessionId = session.providerSessionId
        || getArtificialProviderSessionId(session.nativePath, 'cursor')
        || '';
      return getCursorPreviewFromSessionId(providerSessionId, session.projectPath);
    },
  };
}
