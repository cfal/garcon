import { describe, expect, it } from 'bun:test';
import {
  parseUpdateChatTitleRequest,
  parseUpdateChatTitleResponse,
} from '../chat-title-contracts.ts';
import {
  parseSetChatTagsRequest,
  parseSetChatTagsResponse,
} from '../chat-tags-contracts.ts';

describe('chat metadata contracts', () => {
  it('normalizes title requests and validates canonical responses', () => {
    expect(parseUpdateChatTitleRequest({ chatId: ' chat-a ', title: ' New title ' })).toEqual({
      chatId: 'chat-a',
      title: 'New title',
    });
    expect(parseUpdateChatTitleResponse({
      success: true,
      chatId: 'chat-a',
      title: 'New title',
      changed: false,
    })).toEqual({
      success: true,
      chatId: 'chat-a',
      title: 'New title',
      changed: false,
    });
  });

  it('rejects malformed title contracts', () => {
    expect(parseUpdateChatTitleRequest({ chatId: 'chat-a' })).toBeNull();
    expect(parseUpdateChatTitleRequest({ chatId: 'chat-a', title: ' ', extra: true })).toBeNull();
    expect(parseUpdateChatTitleResponse({
      success: true,
      chatId: 'chat-a',
      title: ' New title ',
      changed: true,
    })).toBeNull();
  });

  it('requires an explicit tag array and normalizes it once', () => {
    expect(parseSetChatTagsRequest({
      chatId: ' chat-a ',
      tags: ['Review Needed', 'review-needed', 'ops!'],
    })).toEqual({ chatId: 'chat-a', tags: ['ops', 'review-needed'] });
    expect(parseSetChatTagsResponse({
      success: true,
      chatId: 'chat-a',
      tags: ['ops', 'review-needed'],
      changed: true,
    })).toEqual({
      success: true,
      chatId: 'chat-a',
      tags: ['ops', 'review-needed'],
      changed: true,
    });
  });

  it('rejects missing, malformed, and noncanonical tag contracts', () => {
    expect(parseSetChatTagsRequest({ chatId: 'chat-a' })).toBeNull();
    expect(parseSetChatTagsRequest({ chatId: 'chat-a', tags: 'ops' })).toBeNull();
    expect(parseSetChatTagsRequest({ chatId: 'chat-a', tags: [1] })).toBeNull();
    expect(parseSetChatTagsResponse({
      success: true,
      chatId: 'chat-a',
      tags: ['Review Needed'],
      changed: false,
    })).toBeNull();
  });
});
