import { describe, expect, it } from 'bun:test';
import {
  isRelationallyValidTranscriptPage,
  parseChatHistoryResponse,
} from '../chat-view.ts';
import { AssistantMessage } from '../chat-types.ts';

const TS = '2026-08-16T00:00:00.000Z';

describe('transcript raw-page relations', () => {
  it('[TLV5-PAGE.09-CONTRACT-01] accepts an all-hidden page with an advancing raw continuation', () => {
    expect(isRelationallyValidTranscriptPage({
      messages: [],
      lastOrdinal: 300,
      pageOldestOrdinal: 0,
      pageNewestOrdinal: 250,
      nextBeforeOrdinal: 201,
      hasMore: true,
    })).toBe(true);
  });

  it('[TLV5-PAGE.10-CONTRACT-01] makes hasMore exactly equivalent to a raw continuation', () => {
    const base = {
      messages: [{ ordinal: 225, message: new AssistantMessage(TS, 'visible') }],
      lastOrdinal: 300,
      pageOldestOrdinal: 225,
      pageNewestOrdinal: 250,
    };

    expect(isRelationallyValidTranscriptPage({
      ...base,
      nextBeforeOrdinal: 201,
      hasMore: false,
    })).toBe(false);
    expect(isRelationallyValidTranscriptPage({
      ...base,
      nextBeforeOrdinal: null,
      hasMore: true,
    })).toBe(false);
    expect(isRelationallyValidTranscriptPage({
      ...base,
      nextBeforeOrdinal: 201,
      hasMore: true,
    })).toBe(true);
  });

  it('parses a request-correlated complete page and rejects view drift', () => {
    const request = {
      chatId: '1785337200123456',
      transcriptViewId: 'view-1',
      beforeOrdinal: 251,
      limit: 200,
    };
    const response = {
      historyState: { kind: 'complete' },
      chatId: request.chatId,
      messages: [{ ordinal: 225, message: new AssistantMessage(TS, 'visible') }],
      resendCandidates: [],
      transcriptViewId: 'view-1',
      lastOrdinal: 300,
      pageOldestOrdinal: 225,
      pageNewestOrdinal: 250,
      nextBeforeOrdinal: 51,
      hasMore: true,
      limit: 200,
    };

    expect(parseChatHistoryResponse(request, response)).toEqual(response);
    expect(() => parseChatHistoryResponse(request, {
      ...response,
      transcriptViewId: 'view-2',
    })).toThrow('transcriptViewId does not match request');
  });

  it('parses a degraded page only when transcript fields are absent', () => {
    const request = { chatId: '1785337200123456', limit: 1 };
    const response = {
      historyState: { kind: 'degraded', errorCode: 'TRANSCRIPT_UNAVAILABLE', retryable: true },
      chatId: request.chatId,
      messages: [],
    };
    expect(parseChatHistoryResponse(request, response)).toEqual(response);
    expect(() => parseChatHistoryResponse(request, { ...response, lastOrdinal: 0 }))
      .toThrow('unavailable lastOrdinal');
  });
});
