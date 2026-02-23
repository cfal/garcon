import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { HistoryCache } from '../history-cache.js';

describe('appendMessages', () => {
  const chatId = 'test-chat';
  const ts = '2026-01-01T00:00:00Z';

  let cache;
  let mockRegistry;
  let mockMetadata;
  let mockProviders;

  beforeEach(() => {
    mockRegistry = { getChat: mock(() => null) };
    mockMetadata = { updateFromAppendedMessages: mock(() => undefined) };
    mockProviders = {
      loadMessages: mock(() => Promise.resolve([])),
      isChatRunning: mock(() => false),
    };

    cache = new HistoryCache(mockRegistry, mockMetadata, mockProviders);
    cache._cacheByChatId.set(chatId, {
      chatId,
      messages: [],
      lastAccessAt: Date.now(),
    });
  });

  it('appends finalized messages directly', async () => {
    await cache.appendMessages(chatId, [
      { type: 'assistant-message', timestamp: ts, content: 'Hello world' },
    ]);

    const entry = cache._cacheByChatId.get(chatId);
    expect(entry.messages).toHaveLength(1);
    expect(entry.messages[0].type).toBe('assistant-message');
    expect(entry.messages[0].content).toBe('Hello world');
  });

  it('appends tool-use and tool-result messages', async () => {
    await cache.appendMessages(chatId, [
      { type: 'tool-use', timestamp: ts, toolId: 't1', toolName: 'Read', toolInput: '{}' },
      { type: 'tool-result', timestamp: ts, toolId: 't1', content: 'ok', isError: false },
    ]);

    const entry = cache._cacheByChatId.get(chatId);
    expect(entry.messages).toHaveLength(2);
    expect(entry.messages[0].type).toBe('tool-use');
    expect(entry.messages[1].type).toBe('tool-result');
  });

  it('appends thinking messages', async () => {
    await cache.appendMessages(chatId, [
      { type: 'thinking', timestamp: ts, content: 'Reasoning here' },
    ]);

    const entry = cache._cacheByChatId.get(chatId);
    expect(entry.messages).toHaveLength(1);
    expect(entry.messages[0].type).toBe('thinking');
    expect(entry.messages[0].content).toBe('Reasoning here');
  });

  it('appends multiple messages in a batch', async () => {
    await cache.appendMessages(chatId, [
      { type: 'thinking', timestamp: ts, content: 'Think' },
      { type: 'assistant-message', timestamp: ts, content: 'Response' },
      { type: 'tool-use', timestamp: ts, toolId: 't1', toolName: 'Bash', toolInput: '{}' },
    ]);

    const entry = cache._cacheByChatId.get(chatId);
    expect(entry.messages).toHaveLength(3);
    expect(entry.messages[0].type).toBe('thinking');
    expect(entry.messages[1].type).toBe('assistant-message');
    expect(entry.messages[2].type).toBe('tool-use');
  });

  it('calls updateFromAppendedMessages with all messages', async () => {
    mockMetadata.updateFromAppendedMessages.mockClear();

    const messages = [
      { type: 'assistant-message', timestamp: ts, content: 'hi' },
      { type: 'tool-use', timestamp: ts, toolId: 't1', toolName: 'Read', toolInput: '{}' },
    ];
    await cache.appendMessages(chatId, messages);

    expect(mockMetadata.updateFromAppendedMessages).toHaveBeenCalledWith(chatId, messages);
  });

  it('handles multiple chats independently', async () => {
    const chatId2 = 'test-chat-2';
    cache._cacheByChatId.set(chatId2, {
      chatId: chatId2,
      messages: [],
      lastAccessAt: Date.now(),
    });

    await cache.appendMessages(chatId, [
      { type: 'assistant-message', timestamp: ts, content: 'Chat 1' },
    ]);
    await cache.appendMessages(chatId2, [
      { type: 'assistant-message', timestamp: ts, content: 'Chat 2' },
    ]);

    expect(cache._cacheByChatId.get(chatId).messages).toHaveLength(1);
    expect(cache._cacheByChatId.get(chatId).messages[0].content).toBe('Chat 1');
    expect(cache._cacheByChatId.get(chatId2).messages).toHaveLength(1);
    expect(cache._cacheByChatId.get(chatId2).messages[0].content).toBe('Chat 2');
  });
});
