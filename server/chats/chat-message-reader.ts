import type { ChatMessage } from '../../common/chat-types.js';
import type { ChatViewPage } from '../../common/chat-view.js';

export interface PendingInputHistoryReader {
  loadNativeMessages(chatId: string): Promise<ChatMessage[]>;
  getRetainedHistoryMessages(chatId: string): ChatMessage[] | null;
  hasCompleteHistory?(chatId: string): boolean;
}

export interface ChatViewPageReader {
  getOrCreatePage(chatId: string, limit: number, beforeSeq?: number): Promise<ChatViewPage>;
}
