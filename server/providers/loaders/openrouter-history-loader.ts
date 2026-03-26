// Stub history loader for OpenRouter. Sessions are in-memory only;
// persistence can be added as a follow-up.

import type { ChatMessage } from '../../../common/chat-types.js';

export function loadOpenRouterChatMessages(_sessionId: string | null | undefined): ChatMessage[] {
  return [];
}

export function getOpenRouterPreview(_sessionId: string | null | undefined): null {
  return null;
}
