import type { ChatMessage } from '../../common/chat-types.js';
import type { ChatEventPage } from './chat-event-log.js';

export interface ChatMessageReader {
  ensureLoaded(chatId: string): Promise<unknown>;
  getMessages(chatId: string): ChatMessage[] | null;
}

export interface ChatEventPageReader {
  readPage(chatId: string, limit: number, beforeSeq?: number): Promise<ChatEventPage>;
}
