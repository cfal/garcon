import { parseChatId } from './chat-id.js';
import { parseChatListResponse, type ChatListEntry } from './chat-list.js';
import { isRecord } from './json.js';

export interface PromoteChatRequest { readonly chatId: string }
export interface PromoteChatResponse { readonly success: true; readonly chat: ChatListEntry }

export function parsePromoteChatRequest(value: unknown): PromoteChatRequest | null {
  if (!isRecord(value) || Object.keys(value).some((key) => key !== 'chatId')) return null;
  try { return { chatId: parseChatId(value.chatId) }; } catch { return null; }
}

export function parsePromoteChatResponse(value: unknown): PromoteChatResponse | null {
  if (!isRecord(value) || value.success !== true) return null;
  try {
    const { sessions } = parseChatListResponse({ sessions: [value.chat], total: 1, lastSelectedChatId: null });
    const chat = sessions[0]!;
    if (chat.presentation.collection !== 'conversation' || chat.presentation.notifications !== 'normal') return null;
    return { success: true, chat };
  } catch { return null; }
}
