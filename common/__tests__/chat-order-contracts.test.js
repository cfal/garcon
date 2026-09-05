import { describe, expect, it } from 'bun:test';
import {
  parseReorderChatRequest,
  parseReorderChatResponse,
  parseSortChatOrderRequest,
  parseSortChatOrderResponse,
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

  it.each(['created', 'activity'])('parses a %s chat-order sort request', (sortKey) => {
    expect(parseSortChatOrderRequest({ sortKey })).toEqual({ sortKey });
  });

  const invalidSortRequests = [
    null,
    [],
    'created',
    {},
    { sortKey: 'oldest' },
    { sortKey: 'created', extra: true },
  ];
  for (const [index, value] of invalidSortRequests.entries()) {
    it(`rejects invalid chat-order sort request ${index + 1}`, () => {
      expect(parseSortChatOrderRequest(value)).toBeNull();
    });
  }

  it.each([
    ['created', true],
    ['activity', false],
  ])('parses a %s chat-order sort response', (sortKey, changed) => {
    expect(parseSortChatOrderResponse({ success: true, sortKey, changed })).toEqual({
      success: true,
      sortKey,
      changed,
    });
  });

  const invalidSortResponses = [
    null,
    [],
    { success: false, sortKey: 'created', changed: true },
    { success: true, sortKey: 'oldest', changed: true },
    { success: true, sortKey: 'created' },
    { success: true, sortKey: 'created', changed: 'yes' },
    { success: true, sortKey: 'created', changed: true, extra: true },
  ];
  for (const [index, value] of invalidSortResponses.entries()) {
    it(`rejects invalid chat-order sort response ${index + 1}`, () => {
      expect(parseSortChatOrderResponse(value)).toBeNull();
    });
  }
});
