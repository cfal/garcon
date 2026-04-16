// Loads Z.AI session history from persisted JSONL files.

import type { ChatMessage } from '../../../common/chat-types.js';
import {
  getOpenAiCompatiblePreviewFromSessionId,
  loadOpenAiCompatibleChatMessages,
} from './openai-compatible-history-loader.js';
import { getSessionFilePath, isValidSessionId } from '../zai-paths.js';

export async function loadZaiChatMessages(sessionId: string | null | undefined): Promise<ChatMessage[]> {
  return loadOpenAiCompatibleChatMessages(sessionId, {
    getSessionFilePath,
    isValidSessionId,
    sessionLabel: 'Z.AI Session',
  });
}

export async function getZaiPreviewFromSessionId(sessionId: string | null | undefined) {
  return getOpenAiCompatiblePreviewFromSessionId(sessionId, loadZaiChatMessages, 'Z.AI Session');
}
