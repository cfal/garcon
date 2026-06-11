import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { HistoryCache } from '../history-cache.js';

describe('pruneHistoryCache', () => {
  let cache;
  let isChatRunningMock;

  beforeEach(() => {
    isChatRunningMock = mock(() => false);

    cache = createHistoryCache();
  });

  function createHistoryCache(options = {}) {
    return new HistoryCache(
      { getChat: mock(() => null) },
      { updateFromAppendedMessages: mock(() => undefined) },
      {
        loadMessages: mock(() => Promise.resolve([])),
        isChatRunning: isChatRunningMock,
      },
      options,
    );
  }

  it('evicts stale non-active entries even when under the cache limit', () => {
    const now = 10_000;
    cache = createHistoryCache({
      now: () => now,
      staleNonActiveMs: 1_000,
      initialEntries: [
        {
          chatId: 'stale-1',
          messages: [],
          lastAccessAt: now - 1_001,
        },
        {
          chatId: 'fresh-1',
          messages: [],
          lastAccessAt: now,
        },
      ],
    });

    cache.prune();

    expect(cache.getMessages('stale-1')).toBeNull();
    expect(cache.getMessages('fresh-1')).not.toBeNull();
  });

  it('never evicts active entries by TTL', () => {
    const now = 10_000;
    cache = createHistoryCache({
      now: () => now,
      staleNonActiveMs: 1_000,
      initialEntries: [{
        chatId: 'active-stale',
        messages: [],
        lastAccessAt: now - 1_001,
      }],
    });

    isChatRunningMock.mockImplementation(() => true);

    cache.prune();

    expect(cache.getMessages('active-stale')).not.toBeNull();
  });

  it('evicts LRU non-active entries when over the cache limit', () => {
    const now = 10_000;
    cache = createHistoryCache({
      now: () => now,
      cacheLimit: 3,
      initialEntries: Array.from({ length: 5 }, (_, i) => ({
        chatId: `chat-${i}`,
        messages: [],
        lastAccessAt: now + i,
      })),
    });

    cache.prune();

    expect(cache.getMessages('chat-0')).toBeNull();
    expect(cache.getMessages('chat-1')).toBeNull();
    expect(cache.getMessages('chat-2')).not.toBeNull();
    expect(cache.getMessages('chat-3')).not.toBeNull();
    expect(cache.getMessages('chat-4')).not.toBeNull();
  });
});
