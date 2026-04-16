// Loads OpenRouter session history from persisted JSONL files.

import type { ChatMessage } from '../../../common/chat-types.js';
import {
  getOpenAiCompatiblePreviewFromSessionId,
  loadOpenAiCompatibleChatMessages,
} from './openai-compatible-history-loader.js';
import { getSessionFilePath, isValidSessionId } from '../openrouter-paths.js';

export async function loadOpenRouterChatMessages(sessionId: string | null | undefined): Promise<ChatMessage[]> {
  return loadOpenAiCompatibleChatMessages(sessionId, {
    getSessionFilePath,
    isValidSessionId,
    sessionLabel: 'OpenRouter Session',
  });
}

export async function getOpenRouterPreviewFromSessionId(sessionId: string | null | undefined) {
  return getOpenAiCompatiblePreviewFromSessionId(sessionId, loadOpenRouterChatMessages, 'OpenRouter Session');
}
