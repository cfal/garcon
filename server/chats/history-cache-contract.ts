import type { ChatMessage } from '../../common/chat-types.js';

export interface PaginatedChatMessages {
  messages: ChatMessage[];
  total: number;
  hasMore: boolean;
  offset: number;
  limit: number;
}

export interface HistoryCacheServiceContract {
  ensureLoaded(chatId: string): Promise<unknown>;
  getMessages(chatId: string): ChatMessage[] | null;
  getPaginatedMessages(chatId: string, limit: number, offset: number): Promise<PaginatedChatMessages>;
  appendMessages(chatId: string, messages: ChatMessage[]): Promise<void>;
}

export type HistoryCacheMessageReader = Pick<HistoryCacheServiceContract, 'ensureLoaded' | 'getMessages'>;

export type HistoryCachePageReader = Pick<HistoryCacheServiceContract, 'getPaginatedMessages'>;
