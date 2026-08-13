import type { TranscriptPage } from '../../common/chat-view.js';

export interface TranscriptPageReader {
  page(chatId: string, limit: number, beforeOrdinal?: number): Promise<TranscriptPage>;
}
