import { describe, expect, it } from 'bun:test';
import {
  ChatOperationalNoticeMessage,
  parseServerWsMessage,
  TranscriptSearchStatusMessage,
} from '../ws-events.ts';

describe('parseServerWsMessage chat-operational-notice', () => {
  it('parses a complete notice payload', () => {
    const parsed = parseServerWsMessage({
      type: 'chat-operational-notice',
      chatId: 'chat-1',
      noticeType: 'warning',
      content: 'Carryover context was compacted.',
      timestamp: '2026-06-01T00:00:00.000Z',
    });

    expect(parsed).toBeInstanceOf(ChatOperationalNoticeMessage);
    expect(parsed).toMatchObject({
      chatId: 'chat-1',
      noticeType: 'warning',
      content: 'Carryover context was compacted.',
      timestamp: '2026-06-01T00:00:00.000Z',
    });
  });

  it('parses an informational notice', () => {
    expect(parseServerWsMessage({
      type: 'chat-operational-notice',
      chatId: 'chat-1',
      noticeType: 'info',
      content: 'Compacting earlier chat history.',
    })).toMatchObject({
      chatId: 'chat-1',
      noticeType: 'info',
      content: 'Compacting earlier chat history.',
    });
  });

  it('rejects an unknown notice type', () => {
    expect(parseServerWsMessage({
      type: 'chat-operational-notice',
      chatId: 'chat-1',
      noticeType: 'progress',
      content: 'nope',
    })).toBeNull();
  });

  it('rejects an empty notice content', () => {
    expect(parseServerWsMessage({
      type: 'chat-operational-notice',
      chatId: 'chat-1',
      noticeType: 'error',
      content: '   ',
    })).toBeNull();
  });
});

describe('parseServerWsMessage transcript-search-status', () => {
  const status = {
    version: 1,
    phase: 'rebuilding',
    chats: { total: 12, indexed: 3, pending: 7, failed: 1, unindexed: 1 },
    queuedJobs: 2,
    resync: { completedChats: 4, totalChats: 10 },
    backlogRows: 42,
    activeChat: { position: 8, total: 20 },
    lastErrorCode: null,
    updatedAt: '2026-08-19T00:00:00.000Z',
  };

  it('[TLV5-SEARCH.09-WS-01] round-trips a complete status payload', () => {
    const parsed = parseServerWsMessage(new TranscriptSearchStatusMessage(status));

    expect(parsed).toBeInstanceOf(TranscriptSearchStatusMessage);
    expect(parsed).toEqual(new TranscriptSearchStatusMessage(status));
  });

  it('[TLV5-SEARCH.09-WS-02] rejects malformed status payloads without throwing', () => {
    const malformed = [
      { ...status, phase: 'unknown' },
      { ...status, chats: { ...status.chats, pending: -1 } },
      { ...status, activeChat: { position: 3, total: 2 } },
      { ...status, activeChat: undefined },
      { ...status, resync: undefined },
    ];

    for (const candidate of malformed) {
      expect(parseServerWsMessage({
        type: 'transcript-search-status',
        status: candidate,
      })).toBeNull();
    }
  });
});
