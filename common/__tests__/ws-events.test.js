import { describe, expect, it } from 'bun:test';
import {
  ChatOperationalNoticeMessage,
  ChatProcessingUpdatedMessage,
  parseServerWsMessage,
  TranscriptSearchStatusMessage,
} from '../ws-events.ts';

describe('parseServerWsMessage chat-processing-updated', () => {
  const retry = { attempt: 3, message: 'Provider is overloaded', nextAttemptAt: '2026-08-21T20:23:00.000Z' };

  it('parses a phase without retry detail', () => {
    const parsed = parseServerWsMessage({
      type: 'chat-processing-updated',
      chatId: 'chat-1',
      phase: 'running',
    });

    expect(parsed).toBeInstanceOf(ChatProcessingUpdatedMessage);
    expect(parsed).toMatchObject({ chatId: 'chat-1', phase: 'running', retry: null });
  });

  it('parses a phase with retry detail', () => {
    const parsed = parseServerWsMessage({
      type: 'chat-processing-updated',
      chatId: 'chat-1',
      phase: 'running',
      retry,
    });

    expect(parsed).toMatchObject({ chatId: 'chat-1', phase: 'running', retry });
  });

  it('rejects a malformed retry detail', () => {
    expect(parseServerWsMessage({
      type: 'chat-processing-updated',
      chatId: 'chat-1',
      phase: 'running',
      retry: { attempt: 'first', message: 'x', nextAttemptAt: null },
    })).toBeNull();
  });

  it('parses snapshot entries carrying retry detail', () => {
    const parsed = parseServerWsMessage({
      type: 'ws-pong',
      clientRequestId: 'probe-1',
      sentAt: 5,
      serverTime: '2026-08-21T00:00:00.000Z',
      serverInstanceId: 'server-1',
      processing: {
        outcome: 'snapshot',
        chats: [
          { chatId: 'chat-1', phase: 'running', retry },
          { chatId: 'chat-2', phase: 'stopping' },
        ],
      },
    });

    expect(parsed?.processing).toEqual({
      outcome: 'snapshot',
      chats: [
        { chatId: 'chat-1', phase: 'running', retry },
        { chatId: 'chat-2', phase: 'stopping', retry: null },
      ],
    });
  });
});

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
    chats: { indexed: 3, pending: 7, failed: 1 },
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
