import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { HistoryCache } from '../history-cache.js';

describe('HistoryCache init wiring', () => {
  let cache;
  let mockRegistry;
  let mockMetadata;
  let mockAgents;
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
    mockAgents = {
      loadMessages: mock(() => Promise.resolve([])),
      isChatRunning: mock(() => false),
      onMessages: mock((cb) => messageCallbacks.push(cb)),
    };

    cache = new HistoryCache(mockRegistry, mockMetadata, mockAgents);
  });

  it('registers onChatRemoved listener during init', () => {
    cache.init();
    expect(mockRegistry.onChatRemoved).toHaveBeenCalledTimes(1);
  });

  it('registers onMessages listener during init', () => {
    cache.init();
    expect(mockAgents.onMessages).toHaveBeenCalledTimes(1);
  });

  it('evicts cache entry when chat-removed fires', async () => {
    cache.init();
    await cache.appendMessages('c1', [
      { type: 'assistant-message', content: 'cached', timestamp: '2026-01-01T00:00:00Z' },
    ]);
    expect(cache.getMessages('c1')).not.toBeNull();

    removedCallbacks[0]('c1');

    expect(cache.getMessages('c1')).toBeNull();
  });

  it('appends messages to cache when onMessages fires', async () => {
    cache.init();
    mockRegistry.getChat.mockImplementation((chatId) => (
      chatId === 'c1' ? { agentId: 'claude', agentSessionId: 'session-1' } : null
    ));

    const msgs = [{ type: 'user-message', content: 'hi', timestamp: '2026-01-01T00:00:00Z' }];
    messageCallbacks[0]('c1', msgs);

    await Promise.resolve();

    const messages = cache.getMessages('c1');
    expect(messages.length).toBe(1);
    expect(messages[0].content).toBe('hi');
  });

  it('ignores agent messages for removed or unknown chats', async () => {
    cache.init();

    messageCallbacks[0]('missing-chat', [
      { type: 'assistant-message', content: 'late message', timestamp: '2026-01-01T00:00:00Z' },
    ]);

    await Promise.resolve();

    expect(cache.getMessages('missing-chat')).toBeNull();
    expect(mockMetadata.updateFromAppendedMessages).not.toHaveBeenCalled();
  });

  it('does not register duplicate listeners on repeated init calls', () => {
    cache.init();
    cache.init();
    cache.init();

    expect(mockRegistry.onChatRemoved).toHaveBeenCalledTimes(1);
    expect(mockAgents.onMessages).toHaveBeenCalledTimes(1);
  });

  it('clears prune timer on destroy', () => {
    cache.init();
    cache.destroy();
    // No assertion for timer itself, but verify no error on double destroy.
    cache.destroy();
  });
});
