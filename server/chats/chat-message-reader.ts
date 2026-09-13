import type { TranscriptPage, TranscriptReadPurpose } from '../../common/chat-view.js';
import type { TicketSource } from '../../common/tickets.js';
import type { TicketSourceResolution } from '../../common/ticket-source-navigation.js';

export interface TicketSourceReader {
  resolveTicketSource(source: TicketSource, signal?: AbortSignal): Promise<TicketSourceResolution>;
}

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
