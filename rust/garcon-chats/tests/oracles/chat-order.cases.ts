import { expect, test } from 'bun:test';
import { sortChatIds } from './chat-order.ts';

const metadata = (chatId: string, createdAt: string | null, lastActivity = createdAt) => ({
  chatId, transcriptViewId: null, createdAt, lastActivity, lastMessage: '', firstMessage: '', source: 'live' as const,
});

test('projects creation and activity from the supplied metadata snapshot', () => {
  const ids = ['older-active', 'newer-idle'];
  const byId = Object.fromEntries([
    metadata(ids[0]!, '2025-01-01T00:00:00Z', '2025-01-04T00:00:00Z'),
    metadata(ids[1]!, '2025-01-03T00:00:00Z'),
  ].map(entry => [entry.chatId, entry]));
  expect(sortChatIds('created', ids, byId)).toEqual([...ids].reverse());
  expect(sortChatIds('activity', ids, byId)).toEqual(ids);
});

test('uses the chat ID as fallback and keeps ties stable', () => {
  const ids = ['1735689600000000', '1735776000000000', 'malformed', 'older'];
  const byId = { [ids[0]!]: metadata(ids[0]!, 'unparseable'), older: metadata('older', null) };
  for (const sortKey of ['created', 'activity'] as const) {
    expect(sortChatIds(sortKey, ids, byId)).toEqual([ids[1], ids[0], ids[2], ids[3]]);
  }
  expect(sortChatIds('activity', [], {})).toEqual([]);
  expect(sortChatIds('created', ['z', 'a', 'z'], {})).toEqual(['z', 'a', 'z']);
});
