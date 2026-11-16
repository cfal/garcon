import { describe, expect, it } from 'bun:test';
import { parseSetChatParentRequest, parseSetChatParentResponse } from '../chat-parent-contracts.ts';

const chatId = '1783725900000200';
const parentChatId = '1783725900000201';

describe('chat parent contracts', () => {
  it.each([null, parentChatId])('accepts explicit desired parent %s', (parent) => {
    const request = { chatId, parentChatId: parent };
    expect(parseSetChatParentRequest(request)).toEqual(request);
    const response = { success: true, chatId, parentChat: parent === null ? null : { chatId: parent, relation: 'delegation' }, changed: true };
    expect(parseSetChatParentResponse(response)).toEqual(response);
  });

  it.each([
    {}, { chatId }, { chatId, parentChatId: '' }, { chatId, parentChatId: 'title' },
    { chatId: 1783725900000200, parentChatId }, { chatId: '9999999999999999', parentChatId },
    { chatId, parentChatId, relation: 'fork' }, { chatId, parentChatId, parentChat: null },
  ])('rejects invalid request %j', (input) => {
    expect(parseSetChatParentRequest(input)).toBeNull();
  });

  it('rejects malformed acknowledgements and provenance fields', () => {
    const response = { success: true, chatId, parentChat: { chatId: parentChatId, relation: 'delegation' }, changed: false };
    for (const patch of [
      { success: false }, { changed: undefined }, { chatId: 'title' }, { extra: true },
      { parentChat: undefined }, { parentChat: { ...response.parentChat, ordinal: 0 } },
      { parentChat: { ...response.parentChat, relation: 'fork', ordinal: 0, transcriptViewId: 'view' } },
      { parentChat: { chatId, relation: 'delegation' } },
    ]) expect(parseSetChatParentResponse({ ...response, ...patch })).toBeNull();
  });
});
