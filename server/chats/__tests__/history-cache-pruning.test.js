import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { HistoryCache, _CACHE_LIMIT, _STALE_NON_ACTIVE_MS } from '../history-cache.js';

describe('pruneHistoryCache', () => {
  let cache;
  let isChatRunningMock;

  beforeEach(() => {
    isChatRunningMock = mock(() => false);

    cache = new HistoryCache(
      { getChat: mock(() => null) },
      { updateFromAppendedMessages: mock(() => undefined) },
      {
        loadMessages: mock(() => Promise.resolve([])),
        isChatRunning: isChatRunningMock,
      },
    );
  });

  it('evicts stale non-active entries even when under CACHE_LIMIT', async () => {
    const staleTime = Date.now() - _STALE_NON_ACTIVE_MS - 1000;

    cache._cacheByChatId.set('stale-1', {
      chatId: 'stale-1',
      messages: [],
      lastAccessAt: staleTime,
    });
    cache._cacheByChatId.set('fresh-1', {
      chatId: 'fresh-1',
      messages: [],
      lastAccessAt: Date.now(),
    });

    expect(cache._cacheByChatId.size).toBeLessThanOrEqual(_CACHE_LIMIT);

    await cache.prune();

    expect(cache._cacheByChatId.has('stale-1')).toBe(false);
    expect(cache._cacheByChatId.has('fresh-1')).toBe(true);
  });

  it('never evicts active entries by TTL', async () => {
    const staleTime = Date.now() - _STALE_NON_ACTIVE_MS - 1000;

    cache._cacheByChatId.set('active-stale', {
      chatId: 'active-stale',
      messages: [],
      lastAccessAt: staleTime,
    });

    isChatRunningMock.mockImplementation(() => true);

    await cache.prune();

    expect(cache._cacheByChatId.has('active-stale')).toBe(true);
  });

  it('evicts LRU non-active entries when over CACHE_LIMIT', async () => {
    const now = Date.now();
    // Fill cache beyond limit with fresh entries.
    for (let i = 0; i < _CACHE_LIMIT + 5; i++) {
      cache._cacheByChatId.set(`chat-${i}`, {
        chatId: `chat-${i}`,
        messages: [],
        lastAccessAt: now + i,
      });
    }

    expect(cache._cacheByChatId.size).toBe(_CACHE_LIMIT + 5);

    await cache.prune();

    // LRU entries evicted until back at or below limit. The 5 oldest
    // were removed; remaining entries are the most recently accessed.
    expect(cache._cacheByChatId.size).toBe(_CACHE_LIMIT);
    expect(cache._cacheByChatId.has('chat-0')).toBe(false);
    expect(cache._cacheByChatId.has('chat-4')).toBe(false);
    expect(cache._cacheByChatId.has('chat-5')).toBe(true);
  });
});
