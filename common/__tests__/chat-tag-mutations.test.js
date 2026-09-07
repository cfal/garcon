import { describe, expect, it } from 'bun:test';
import {
  normalizeChatTagsMutationResponse,
  normalizeRecoverChatTagsResponse,
} from '../chat-tag-mutations.ts';

describe('chat tag mutation responses', () => {
  it('parses canonical mutation and recovery responses', () => {
    expect(normalizeChatTagsMutationResponse({
      success: true,
      chatId: 'chat-1',
      tags: ['ready', 'web'],
      addedTags: ['ready'],
      removedTags: [],
    })).toEqual({
      success: true,
      chatId: 'chat-1',
      tags: ['ready', 'web'],
      addedTags: ['ready'],
      removedTags: [],
    });
    expect(normalizeRecoverChatTagsResponse({
      success: true,
      chatId: 'chat-1',
      tags: ['ready'],
    })).toEqual({ success: true, chatId: 'chat-1', tags: ['ready'] });
  });

  it('rejects unknown keys and noncanonical tag arrays', () => {
    expect(normalizeChatTagsMutationResponse({
      success: true,
      chatId: 'chat-1',
      tags: ['Ready'],
      addedTags: [],
      removedTags: [],
    })).toBeNull();
    expect(normalizeRecoverChatTagsResponse({
      success: true,
      chatId: 'chat-1',
      tags: [],
      extra: true,
    })).toBeNull();
  });
});
