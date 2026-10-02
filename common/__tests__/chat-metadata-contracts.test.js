import { describe, expect, it } from 'bun:test';
import {
  parseUpdateChatTitleRequest,
  parseUpdateChatTitleResponse,
} from '../chat-title-contracts.ts';

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

});
