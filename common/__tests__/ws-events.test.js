import { describe, expect, it } from 'bun:test';
import { ChatOperationalNoticeMessage, parseServerWsMessage } from '../ws-events.ts';

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
