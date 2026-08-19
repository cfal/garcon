import type { TranscriptPage, TranscriptReadPurpose } from '../../common/chat-view.js';

export interface TranscriptPageReader {
  page(
    chatId: string,
    limit: number,
    beforeOrdinal?: number,
    expectedTranscriptViewId?: string,
    signal?: AbortSignal,
    purpose?: TranscriptReadPurpose,
  ): Promise<TranscriptPage>;
}
