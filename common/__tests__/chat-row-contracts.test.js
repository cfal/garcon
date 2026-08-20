import { describe, expect, it } from 'bun:test';
import {
  CHAT_ROW_CONTENT_MAX_BYTES,
  CHAT_ROW_TITLE_MAX_CODE_POINTS,
  parseAddChatRowRequest,
  parseAddChatRowResponse,
  parseChatRowContent,
  parseChatRowTitle,
  parseChatRowTargetResponse,
} from '../chat-row-contracts.ts';

const request = {
  clientRequestId: 'request-1',
  clientMessageId: 'message-1',
  chatId: '1787000000000000',
  transcriptViewId: 'view-1',
  type: 'notice',
  content: '  retained exactly\n',
};

describe('chat row contracts', () => {
  it('[TLV5-CHAT-ROW.01-CONTRACT-01] parses both chat row types without trimming content', () => {
    expect(parseAddChatRowRequest(request)).toEqual(request);
    expect(parseAddChatRowRequest({ ...request, type: 'error' })).toEqual({
      ...request,
      type: 'error',
    });
  });

  it('canonicalizes optional titles without changing row content', () => {
    expect(parseAddChatRowRequest({
      ...request,
      title: '  Release   validation  ',
    })).toEqual({
      ...request,
      title: 'Release   validation',
    });
    expect(parseAddChatRowRequest({ ...request, title: null })).toEqual(request);
    expect(parseChatRowTitle('Deployment')).toBe('Deployment');
  });

  it('enforces the single-line title boundary in Unicode code points', () => {
    const astral = '\u{1f680}';
    expect(parseChatRowTitle(astral.repeat(CHAT_ROW_TITLE_MAX_CODE_POINTS)))
      .toBe(astral.repeat(CHAT_ROW_TITLE_MAX_CODE_POINTS));
    expect(() => parseChatRowTitle(astral.repeat(CHAT_ROW_TITLE_MAX_CODE_POINTS + 1)))
      .toThrow('at most 120 characters');
    expect(() => parseChatRowTitle('x'.repeat(CHAT_ROW_TITLE_MAX_CODE_POINTS + 1)))
      .toThrow('at most 120 characters');
    expect(() => parseChatRowTitle(' \t ')).toThrow('must not be empty');
    expect(() => parseChatRowTitle('first\nsecond')).toThrow('single line');
    expect(() => parseChatRowTitle('first\u2028second')).toThrow('single line');
    expect(() => parseChatRowTitle(String.fromCharCode(0xd800))).toThrow('well-formed Unicode');
    expect(() => parseChatRowTitle(42)).toThrow('must be a string');
  });

  it('enforces the UTF-8 content boundary and well-formed Unicode', () => {
    expect(parseChatRowContent('x'.repeat(CHAT_ROW_CONTENT_MAX_BYTES)))
      .toHaveLength(CHAT_ROW_CONTENT_MAX_BYTES);
    expect(() => parseChatRowContent('x'.repeat(CHAT_ROW_CONTENT_MAX_BYTES + 1))).toThrow();
    expect(() => parseChatRowContent('é'.repeat(CHAT_ROW_CONTENT_MAX_BYTES / 2 + 1))).toThrow();
    expect(() => parseChatRowContent(String.fromCharCode(0xd800))).toThrow();
    expect(() => parseChatRowContent(String.fromCharCode(0xdc00))).toThrow();
    expect(() => parseChatRowContent(' \n\t ')).toThrow();
  });

  it('rejects unsupported chat row types', () => {
    expect(() => parseAddChatRowRequest({ ...request, type: 'alert' })).toThrow(
      'type must be notice or error',
    );
  });

  it('parses target and mutation responses strictly', () => {
    expect(parseChatRowTargetResponse({
      success: true,
      chatId: request.chatId,
      transcriptViewId: request.transcriptViewId,
    })).toEqual({
      success: true,
      chatId: request.chatId,
      transcriptViewId: request.transcriptViewId,
    });
    const response = {
      success: true,
      commandType: 'chat-row-add',
      clientRequestId: request.clientRequestId,
      clientMessageId: request.clientMessageId,
      chatId: request.chatId,
      transcriptViewId: request.transcriptViewId,
      ordinal: 7,
      type: 'error',
      status: 'duplicate',
      timestamp: '2026-08-18T00:00:00.000Z',
    };
    expect(parseAddChatRowResponse(response)).toEqual(response);
    expect(parseAddChatRowResponse({ ...response, ordinal: 0 })).toBeNull();
    expect(parseAddChatRowResponse({ ...response, status: 'accepted' })).toBeNull();
    expect(parseAddChatRowResponse({ ...response, commandType: 'agent-run' })).toBeNull();
    expect(parseChatRowTargetResponse({ success: true, chatId: '', transcriptViewId: 'view-1' }))
      .toBeNull();
  });
});
