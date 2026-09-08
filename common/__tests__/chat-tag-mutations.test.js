import { describe, expect, it } from 'bun:test';
import {
  normalizeChatTagsMutationResponse,
  normalizeCommandTagMutationOutcome,
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

  it('parses every accepted-command tag outcome', () => {
    expect(normalizeCommandTagMutationOutcome({
      status: 'applied',
      addedTags: ['ready'],
    })).toEqual({ status: 'applied', addedTags: ['ready'] });
    expect(normalizeCommandTagMutationOutcome({
      status: 'not-applied',
      errorCode: 'CHAT_TAG_SAVE_FAILED',
      retryable: true,
    })).toEqual({
      status: 'not-applied',
      errorCode: 'CHAT_TAG_SAVE_FAILED',
      retryable: true,
    });
    expect(normalizeCommandTagMutationOutcome({
      status: 'unknown',
      errorCode: 'CHAT_TAG_SAVE_UNKNOWN',
      recoveryRequired: true,
    })).toEqual({
      status: 'unknown',
      errorCode: 'CHAT_TAG_SAVE_UNKNOWN',
      recoveryRequired: true,
    });
  });

  it('rejects malformed accepted-command tag outcomes', () => {
    expect(normalizeCommandTagMutationOutcome({
      status: 'applied',
      addedTags: ['Ready'],
    })).toBeNull();
    expect(normalizeCommandTagMutationOutcome({
      status: 'not-applied',
      errorCode: 'CHAT_TAG_SAVE_FAILED',
      retryable: false,
    })).toBeNull();
    expect(normalizeCommandTagMutationOutcome({
      status: 'unknown',
      errorCode: 'CHAT_TAG_SAVE_UNKNOWN',
      recoveryRequired: true,
      extra: true,
    })).toBeNull();
  });
});
