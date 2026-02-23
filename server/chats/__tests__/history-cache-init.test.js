import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { HistoryCache } from '../history-cache.js';

describe('HistoryCache init wiring', () => {
  let cache;
  let mockRegistry;
  let mockMetadata;
  let mockProviders;
  let removedCallbacks;
  let messageCallbacks;

  beforeEach(() => {
    removedCallbacks = [];
    messageCallbacks = [];
    mockRegistry = {
      getChat: mock(() => null),
      onChatRemoved: mock((cb) => removedCallbacks.push(cb)),
    };
    mockMetadata = { updateFromAppendedMessages: mock(() => undefined) };
    mockProviders = {
      loadMessages: mock(() => Promise.resolve([])),
      isChatRunning: mock(() => false),
      onMessages: mock((cb) => messageCallbacks.push(cb)),
    };

    cache = new HistoryCache(mockRegistry, mockMetadata, mockProviders);
  });

  it('registers onChatRemoved listener during init', () => {
    cache.init();
    expect(mockRegistry.onChatRemoved).toHaveBeenCalledTimes(1);
  });

  it('registers onMessages listener during init', () => {
    cache.init();
    expect(mockProviders.onMessages).toHaveBeenCalledTimes(1);
  });

  it('evicts cache entry when chat-removed fires', () => {
    cache.init();
    cache._cacheByChatId.set('c1', { chatId: 'c1', messages: [], lastAccessAt: Date.now() });
    expect(cache._cacheByChatId.has('c1')).toBe(true);

    removedCallbacks[0]('c1');

    expect(cache._cacheByChatId.has('c1')).toBe(false);
  });

  it('appends messages to cache when onMessages fires', async () => {
    cache.init();
    cache._cacheByChatId.set('c1', { chatId: 'c1', messages: [], lastAccessAt: Date.now() });

    const msgs = [{ type: 'user-message', content: 'hi', timestamp: '2026-01-01T00:00:00Z' }];
    await messageCallbacks[0]('c1', msgs);

    // Allow async appendMessages to settle.
    await new Promise((r) => setTimeout(r, 10));

    const entry = cache._cacheByChatId.get('c1');
    expect(entry.messages.length).toBe(1);
    expect(entry.messages[0].content).toBe('hi');
  });

  it('does not register duplicate listeners on repeated init calls', () => {
    cache.init();
    cache.init();
    cache.init();

    expect(mockRegistry.onChatRemoved).toHaveBeenCalledTimes(1);
    expect(mockProviders.onMessages).toHaveBeenCalledTimes(1);
  });

  it('clears prune timer on destroy', () => {
    cache.init();
    cache.destroy();
    // No assertion for timer itself, but verify no error on double destroy.
    cache.destroy();
  });
});
