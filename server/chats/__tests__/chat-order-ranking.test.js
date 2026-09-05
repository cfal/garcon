import { describe, expect, it } from 'bun:test';
import { buildChatOrderComparator } from '../chat-order-ranking.ts';

function metadata(chatId, createdAt, lastActivity = createdAt) {
  return {
    chatId,
    createdAt,
    lastActivity,
    lastMessage: '',
    firstMessage: '',
    source: 'live',
  };
}

describe('buildChatOrderComparator', () => {
  it('adapts metadata creation and activity timestamps', () => {
    const byId = new Map([
      ['older-active', metadata(
        'older-active',
        '2025-01-01T00:00:00.000Z',
        '2025-01-04T00:00:00.000Z',
      )],
      ['newer-idle', metadata(
        'newer-idle',
        '2025-01-03T00:00:00.000Z',
        '2025-01-03T00:00:00.000Z',
      )],
    ]);

    expect(['older-active', 'newer-idle'].sort(buildChatOrderComparator('created', byId)))
      .toEqual(['newer-idle', 'older-active']);
    expect(['older-active', 'newer-idle'].sort(buildChatOrderComparator('activity', byId)))
      .toEqual(['older-active', 'newer-idle']);
  });

  it('falls back to the chat id when metadata is missing', () => {
    const ids = ['1735689600000000', '1735776000000000'];

    expect(ids.sort(buildChatOrderComparator('created', new Map())))
      .toEqual(['1735776000000000', '1735689600000000']);
  });

  it('reads metadata by reference from the supplied map', () => {
    const byId = new Map([
      ['a', metadata('a', '2025-01-02T00:00:00.000Z')],
      ['b', metadata('b', '2025-01-01T00:00:00.000Z')],
    ]);
    const compare = buildChatOrderComparator('created', byId);
    byId.set('b', metadata('b', '2025-01-03T00:00:00.000Z'));

    expect(['a', 'b'].sort(compare)).toEqual(['b', 'a']);
  });
});
