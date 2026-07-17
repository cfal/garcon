import type { ChatMessage } from '../../common/chat-types.js';
import type { ChatViewPage } from '../../common/chat-view.js';

export interface ChatMessageReader {
  ensureLoaded(chatId: string): Promise<ChatMessage[]>;
  getMessages(chatId: string): ChatMessage[] | null;
  getRetainedHistoryMessages(chatId: string): ChatMessage[] | null;
}

export interface ChatViewPageReader {
  getOrCreatePage(chatId: string, limit: number, beforeSeq?: number): Promise<ChatViewPage>;
}
