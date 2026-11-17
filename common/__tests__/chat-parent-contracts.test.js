import { describe, expect, it } from 'bun:test';
import { parseSetChatParentRequest, parseSetChatParentResponse } from '../chat-parent-contracts.ts';

const chatId = '1783725900000200';
const parentChatId = '1783725900000201';

describe('chat parent contracts', () => {
  it.each([null, parentChatId])('accepts explicit desired parent %s', (parent) => {
    const request = { chatId, parentChatId: parent };
    expect(parseSetChatParentRequest(request)).toEqual(request);
    const response = { success: true, chatId, parentChatId: parent, changed: true };
    expect(parseSetChatParentResponse(response)).toEqual(response);
  });

  it.each([
    {}, { chatId }, { chatId, parentChatId: '' }, { chatId, parentChatId: 'title' },
    { chatId: 1783725900000200, parentChatId }, { chatId: '9999999999999999', parentChatId },
    { chatId, parentChatId, relation: 'fork' }, { chatId, parentChatId, lineage: null },
    { chatId, parentChatId, parentChat: null },
  ])('rejects invalid request %j', (input) => {
    expect(parseSetChatParentRequest(input)).toBeNull();
  });

  it('rejects malformed acknowledgements and provenance fields', () => {
    const response = { success: true, chatId, parentChatId, changed: false };
    for (const patch of [
      { success: false }, { changed: undefined }, { chatId: 'title' }, { extra: true },
      { parentChatId: undefined }, { parentChatId: chatId }, { parentChatId: '' },
      { parentChatId: { chatId: parentChatId, relation: 'delegation' } },
      { parentChat: null }, { lineage: null },
    ]) expect(parseSetChatParentResponse({ ...response, ...patch })).toBeNull();
  });
});
