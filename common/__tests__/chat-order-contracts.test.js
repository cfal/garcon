import { describe, expect, it } from 'bun:test';
import {
  parseReorderChatRequest,
  parseReorderChatResponse,
} from '../chat-order-contracts.ts';

describe('chat order contracts', () => {
  it.each([
    ['top'],
    ['bottom'],
  ])('parses a %s boundary placement', (boundary) => {
    expect(parseReorderChatRequest({
      chatId: ' chat-a ',
      placement: { kind: 'boundary', boundary },
    })).toEqual({
      chatId: 'chat-a',
      placement: { kind: 'boundary', boundary },
    });
  });

  it.each([
    ['before'],
    ['after'],
  ])('parses a %s relative placement', (position) => {
    expect(parseReorderChatRequest({
      chatId: ' chat-a ',
      placement: {
        kind: 'relative',
        referenceChatId: ' chat-b ',
        position,
      },
    })).toEqual({
      chatId: 'chat-a',
      placement: {
        kind: 'relative',
        referenceChatId: 'chat-b',
        position,
      },
    });
  });

  const invalidRequests = [
    null,
    [],
    'request',
    {},
    { chatId: '', placement: { kind: 'boundary', boundary: 'top' } },
    { chatId: 'chat-a' },
    { chatId: 'chat-a', placement: null },
    { chatId: 'chat-a', placement: { kind: 'unknown' } },
    { chatId: 'chat-a', placement: { kind: 'boundary', boundary: 'middle' } },
    { chatId: 'chat-a', placement: { kind: 'relative', referenceChatId: '', position: 'after' } },
    { chatId: 'chat-a', placement: { kind: 'relative', referenceChatId: 'chat-a', position: 'after' } },
    { chatId: 'chat-a', placement: { kind: 'relative', referenceChatId: 'chat-b', position: 'beside' } },
    { chatId: 'chat-a', placement: { kind: 'boundary', boundary: 'top', referenceChatId: 'chat-b' } },
    { chatId: 'chat-a', placement: { kind: 'relative', referenceChatId: 'chat-b', position: 'after', boundary: 'top' } },
    { chatId: 'chat-a', placement: { kind: 'boundary', boundary: 'top' }, extra: true },
    { list: 'normal', oldOrder: ['a'], newOrder: ['a'] },
    { chatId: 'chat-a', chatIdAbove: 'chat-b' },
  ];
  for (const [index, value] of invalidRequests.entries()) {
    it(`rejects invalid reorder request ${index + 1}`, () => {
      expect(parseReorderChatRequest(value)).toBeNull();
    });
  }

  it.each([
    ['pinned', true],
    ['normal', false],
    ['archived', true],
  ])('parses a %s reorder response', (orderGroup, changed) => {
    expect(parseReorderChatResponse({
      success: true,
      chatId: ' chat-a ',
      orderGroup,
      changed,
    })).toEqual({
      success: true,
      chatId: 'chat-a',
      orderGroup,
      changed,
    });
  });

  const invalidResponses = [
    null,
    [],
    { success: false, chatId: 'chat-a', orderGroup: 'normal', changed: true },
    { success: true, chatId: '', orderGroup: 'normal', changed: true },
    { success: true, chatId: 'chat-a', orderGroup: 'orphan', changed: true },
    { success: true, chatId: 'chat-a', orderGroup: 'normal', changed: 'yes' },
    { success: true, chatId: 'chat-a', changed: true },
  ];
  for (const [index, value] of invalidResponses.entries()) {
    it(`rejects invalid reorder response ${index + 1}`, () => {
      expect(parseReorderChatResponse(value)).toBeNull();
    });
  }
});
