import { expect, test } from 'bun:test';
import type { ChatListEntry } from '../../../common/chat-list.js';
import type { ChatOrderTimestamps } from '../../../common/chat-order-sort.js';
import { compareChatOrderNewestFirst } from '../../../common/chat-order-sort.js';
import {
  createSearchCorpusChats,
  type SearchCorpusTier,
} from '../../support/search-corpus-fixture.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';

const PAGINATION_CORPUS: SearchCorpusTier = {
  name: 'S',
  denseChats: 105,
  denseRowsPerChat: 1,
  maxChatRows: 1,
  sparseChats: 0,
  bodyBytes: 64,
  oversizedChat: false,
  phraseDecoy: false,
};

function timestamps(entry: ChatListEntry): ChatOrderTimestamps {
  return {
    id: entry.id,
    createdAt: entry.activity.createdAt,
    lastActivityAt: entry.activity.lastActivityAt,
  };
}

test('pages and time-sorts transcript matches across HTTP', async () => {
  await withIntegrationFixture('transcript-search-pagination', async (fixture) => {
    const corpus = await createSearchCorpusChats(fixture, PAGINATION_CORPUS);
    await fixture.client.updateSettings({ features: { transcriptSearch: { enabled: true } } });
    await fixture.client.waitForSearchPhase(['ready'], { timeoutMs: 60_000 });

    const requestedChatIds = [...corpus.denseChatIds, '9999999999999999'];
    const pages = await Promise.all([0, 50, 100].map((offset) => fixture.client.searchChats({
      query: corpus.markerTerm,
      chatIds: requestedChatIds,
      sort: 'relevance',
      offset,
      limit: 50,
    })));

    expect(pages.map((page) => page.page)).toEqual([
      { offset: 0, limit: 50, total: 105, hasMore: true, nextOffset: 50 },
      { offset: 50, limit: 50, total: 105, hasMore: true, nextOffset: 100 },
      { offset: 100, limit: 50, total: 105, hasMore: false, nextOffset: null },
    ]);
    expect(pages.map((page) => page.results.length)).toEqual([50, 50, 5]);
    const pagedIds = pages.flatMap((page) => page.results.map((result) => result.chatId));
    expect(new Set(pagedIds).size).toBe(105);
    expect(pagedIds.every((chatId) => corpus.denseChatIds.includes(chatId))).toBe(true);
    expect(pages.flatMap((page) => page.results).every((result) => (
      result.transcriptViewId.length > 0
      && result.snippets.some((snippet) => snippet.text.includes(corpus.markerTerm))
    ))).toBe(true);

    const entriesById = new Map(
      (await fixture.client.listChats()).sessions.map((entry) => [entry.id, entry]),
    );
    const requestedEntries = corpus.denseChatIds
      .map((chatId) => entriesById.get(chatId))
      .filter((entry): entry is ChatListEntry => Boolean(entry));
    for (const sort of ['activity', 'created'] as const) {
      const compare = compareChatOrderNewestFirst(sort);
      const expected = [...requestedEntries]
        .sort((left, right) => compare(timestamps(left), timestamps(right)))
        .slice(0, 50)
        .map((entry) => entry.id);
      const response = await fixture.client.searchChats({
        query: corpus.markerTerm,
        chatIds: [...requestedChatIds].reverse(),
        sort,
        offset: 0,
        limit: 50,
      });
      expect(response.results.map((result) => result.chatId)).toEqual(expected);
      expect(response.page).toMatchObject({ offset: 0, total: 105, nextOffset: 50 });
    }
  });
}, 180_000);
