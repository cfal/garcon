import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { HistoryCache } from '../history-cache.js';

describe('appendMessages', () => {
  const chatId = 'test-chat';
  const ts = '2026-01-01T00:00:00Z';

  let cache;
  let mockRegistry;
  let mockMetadata;
  let mockAgents;

  beforeEach(() => {
    mockRegistry = { getChat: mock(() => null) };
    mockMetadata = { updateFromAppendedMessages: mock(() => undefined) };
    mockAgents = {
      loadMessages: mock(() => Promise.resolve([])),
      isChatRunning: mock(() => false),
    };

    cache = new HistoryCache(mockRegistry, mockMetadata, mockAgents);
  });

  it('appends finalized messages directly', async () => {
    await cache.appendMessages(chatId, [
      { type: 'assistant-message', timestamp: ts, content: 'Hello world' },
    ]);

    const messages = cache.getMessages(chatId);
    expect(messages).toHaveLength(1);
    expect(messages[0].type).toBe('assistant-message');
    expect(messages[0].content).toBe('Hello world');
  });

  it('appends tool-use and tool-result messages', async () => {
    await cache.appendMessages(chatId, [
      { type: 'read-tool-use', timestamp: ts, toolId: 't1', filePath: '/tmp/test.ts' },
      { type: 'tool-result', timestamp: ts, toolId: 't1', content: 'ok', isError: false },
    ]);

    const messages = cache.getMessages(chatId);
    expect(messages).toHaveLength(2);
    expect(messages[0].type).toBe('read-tool-use');
    expect(messages[1].type).toBe('tool-result');
  });

  it('appends thinking messages', async () => {
    await cache.appendMessages(chatId, [
      { type: 'thinking', timestamp: ts, content: 'Reasoning here' },
    ]);

    const messages = cache.getMessages(chatId);
    expect(messages).toHaveLength(1);
    expect(messages[0].type).toBe('thinking');
    expect(messages[0].content).toBe('Reasoning here');
  });

  it('appends multiple messages in a batch', async () => {
    await cache.appendMessages(chatId, [
      { type: 'thinking', timestamp: ts, content: 'Think' },
      { type: 'assistant-message', timestamp: ts, content: 'Response' },
      { type: 'bash-tool-use', timestamp: ts, toolId: 't1', command: 'ls' },
    ]);

    const messages = cache.getMessages(chatId);
    expect(messages).toHaveLength(3);
    expect(messages[0].type).toBe('thinking');
    expect(messages[1].type).toBe('assistant-message');
    expect(messages[2].type).toBe('bash-tool-use');
  });

  it('deduplicates repeated live appends incrementally', async () => {
    await cache.appendMessages(chatId, [
      { type: 'assistant-message', timestamp: ts, content: 'Already seen' },
      { type: 'bash-tool-use', timestamp: ts, toolId: 'tool-1', command: 'pwd' },
    ]);

    await cache.appendMessages(chatId, [
      { type: 'assistant-message', timestamp: ts, content: 'Already seen' },
      { type: 'bash-tool-use', timestamp: ts, toolId: 'tool-1', command: 'pwd' },
      { type: 'assistant-message', timestamp: '2026-01-01T00:00:01Z', content: 'New reply' },
    ]);

    const messages = cache.getMessages(chatId);
    expect(messages.map((message) => message.content ?? message.command)).toEqual([
      'Already seen',
      'pwd',
      'New reply',
    ]);
  });

  it('calls updateFromAppendedMessages with all messages', async () => {
    mockMetadata.updateFromAppendedMessages.mockClear();

    const messages = [
      { type: 'assistant-message', timestamp: ts, content: 'hi' },
      { type: 'read-tool-use', timestamp: ts, toolId: 't1', filePath: '/tmp/test.ts' },
    ];
    await cache.appendMessages(chatId, messages);

    expect(mockMetadata.updateFromAppendedMessages).toHaveBeenCalledWith(chatId, messages);
  });

  it('handles multiple chats independently', async () => {
    const chatId2 = 'test-chat-2';

    await cache.appendMessages(chatId, [
      { type: 'assistant-message', timestamp: ts, content: 'Chat 1' },
    ]);
    await cache.appendMessages(chatId2, [
      { type: 'assistant-message', timestamp: ts, content: 'Chat 2' },
    ]);

    const chatOneMessages = cache.getMessages(chatId);
    const chatTwoMessages = cache.getMessages(chatId2);
    expect(chatOneMessages).toHaveLength(1);
    expect(chatOneMessages[0].content).toBe('Chat 1');
    expect(chatTwoMessages).toHaveLength(1);
    expect(chatTwoMessages[0].content).toBe('Chat 2');
  });

  it('appends to an uncached chat without loading agent history', async () => {
    await cache.appendMessages(chatId, [
      { type: 'assistant-message', timestamp: ts, content: 'Background update' },
    ]);

    const messages = cache.getMessages(chatId);
    expect(mockAgents.loadMessages).toHaveBeenCalledTimes(0);
    expect(messages.map((message) => message.content)).toEqual(['Background update']);
  });

  it('loads agent history once and merges a live tail without duplicate assistant text', async () => {
    const selectedChatId = 'selected-chat';
    mockRegistry.getChat.mockImplementation((id) => (
      id === selectedChatId ? { agentId: 'codex', agentSessionId: 'thread-1' } : null
    ));
    mockAgents.loadMessages.mockImplementation(() => Promise.resolve([
      { type: 'user-message', timestamp: ts, content: 'Prompt' },
      { type: 'assistant-message', timestamp: ts, content: 'Already present' },
    ]));

    await cache.appendMessages(selectedChatId, [
      { type: 'assistant-message', timestamp: ts, content: 'Already present' },
      { type: 'assistant-message', timestamp: ts, content: 'Live tail' },
    ]);
    const messages = await cache.ensureLoaded(selectedChatId);
    await cache.ensureLoaded(selectedChatId);

    expect(mockAgents.loadMessages).toHaveBeenCalledTimes(1);
    expect(messages.map((message) => message.content)).toEqual([
      'Prompt',
      'Already present',
      'Live tail',
    ]);
  });

  it('loads an uncached chat before returning a paginated page', async () => {
    const selectedChatId = 'uncached-page-chat';
    mockRegistry.getChat.mockImplementation((id) => (
      id === selectedChatId ? { agentId: 'codex', agentSessionId: 'thread-1' } : null
    ));
    mockAgents.loadMessages.mockImplementation(() => Promise.resolve([
      { type: 'user-message', timestamp: '2026-01-01T00:00:00Z', content: 'Prompt' },
      { type: 'assistant-message', timestamp: '2026-01-01T00:00:01Z', content: 'First reply' },
      { type: 'assistant-message', timestamp: '2026-01-01T00:00:02Z', content: 'Second reply' },
    ]));

    const page = await cache.getPaginatedMessages(selectedChatId, 2, 0);

    expect(mockAgents.loadMessages).toHaveBeenCalledTimes(1);
    expect(page.total).toBe(3);
    expect(page.hasMore).toBe(true);
    expect(page.messages.map((message) => message.content)).toEqual(['First reply', 'Second reply']);
  });

  it('keeps repeated assistant messages with identical content at different timestamps', async () => {
    const selectedChatId = 'repeated-content-chat';
    mockRegistry.getChat.mockImplementation((id) => (
      id === selectedChatId ? { agentId: 'codex', agentSessionId: 'thread-1' } : null
    ));
    mockAgents.loadMessages.mockImplementation(() => Promise.resolve([
      { type: 'assistant-message', timestamp: '2026-01-01T00:00:01Z', content: 'Done.' },
      { type: 'assistant-message', timestamp: '2026-01-01T00:00:02Z', content: 'Done.' },
    ]));

    const messages = await cache.ensureLoaded(selectedChatId);

    expect(messages.map((message) => message.content)).toEqual(['Done.', 'Done.']);
    expect(messages.map((message) => message.timestamp)).toEqual([
      '2026-01-01T00:00:01Z',
      '2026-01-01T00:00:02Z',
    ]);
  });

  it('deduplicates agent-history user echoes through shared request identity', async () => {
    const selectedChatId = 'cursor-chat';
    mockRegistry.getChat.mockImplementation((id) => (
      id === selectedChatId ? { agentId: 'cursor', agentSessionId: 'cursor-session-1' } : null
    ));
    mockAgents.loadMessages.mockImplementation(() => Promise.resolve([
      {
        type: 'user-message',
        timestamp: ts,
        content: 'Prompt',
        metadata: {
          upstreamRequestId: 'cursor-req-1',
          clientRequestId: 'req-1',
        },
      },
      { type: 'assistant-message', timestamp: ts, content: 'Reply' },
    ]));

    await cache.appendMessages(selectedChatId, [
      {
        type: 'user-message',
        timestamp: '2026-01-01T00:00:01Z',
        content: 'Prompt',
        metadata: {
          clientRequestId: 'req-1',
          messageId: 'msg-1',
        },
      },
      { type: 'assistant-message', timestamp: '2026-01-01T00:00:02Z', content: 'Live tail' },
    ]);
    const messages = await cache.ensureLoaded(selectedChatId);

    expect(messages.filter((message) => message.type === 'user-message')).toHaveLength(1);
    expect(messages.map((message) => message.content)).toEqual([
      'Prompt',
      'Reply',
      'Live tail',
    ]);
  });

  it('does not deduplicate user messages by matching text alone', async () => {
    const selectedChatId = 'cursor-chat-text';
    mockRegistry.getChat.mockImplementation((id) => (
      id === selectedChatId ? { agentId: 'cursor', agentSessionId: 'cursor-session-1' } : null
    ));
    mockAgents.loadMessages.mockImplementation(() => Promise.resolve([
      { type: 'user-message', timestamp: ts, content: 'Prompt' },
      { type: 'assistant-message', timestamp: ts, content: 'Reply' },
    ]));

    await cache.appendMessages(selectedChatId, [
      {
        type: 'user-message',
        timestamp: '2026-01-01T00:00:01Z',
        content: 'Prompt',
        metadata: {
          clientRequestId: 'req-1',
          messageId: 'msg-1',
        },
      },
    ]);
    const messages = await cache.ensureLoaded(selectedChatId);

    expect(messages.filter((message) => message.type === 'user-message')).toHaveLength(2);
  });

  it('keeps repeated client user messages when they have distinct client identities', async () => {
    await cache.appendMessages(chatId, [
      {
        type: 'user-message',
        timestamp: ts,
        content: 'Repeat prompt',
        metadata: {
          clientRequestId: 'req-1',
          messageId: 'msg-1',
        },
      },
      {
        type: 'user-message',
        timestamp: '2026-01-01T00:00:01Z',
        content: 'Repeat prompt',
        metadata: {
          clientRequestId: 'req-2',
          messageId: 'msg-2',
        },
      },
    ]);

    expect(cache.getMessages(chatId)).toHaveLength(2);
  });

  it('deduplicates tool-use messages by toolId when merging history and tail', async () => {
    const selectedChatId = 'tool-chat';
    mockRegistry.getChat.mockImplementation((id) => (
      id === selectedChatId ? { agentId: 'codex', agentSessionId: 'thread-1' } : null
    ));
    mockAgents.loadMessages.mockImplementation(() => Promise.resolve([
      { type: 'bash-tool-use', timestamp: ts, toolId: 'tool-1', command: 'ls' },
    ]));

    await cache.appendMessages(selectedChatId, [
      { type: 'bash-tool-use', timestamp: ts, toolId: 'tool-1', command: 'ls' },
      { type: 'bash-tool-use', timestamp: ts, toolId: 'tool-2', command: 'pwd' },
    ]);
    const messages = await cache.ensureLoaded(selectedChatId);

    expect(messages.map((message) => message.toolId)).toEqual(['tool-1', 'tool-2']);
  });

  it('keeps live messages appended while a full load is in flight', async () => {
    const selectedChatId = 'in-flight-chat';
    let releaseLoad;
    let loadStarted;
    const started = new Promise((resolve) => {
      loadStarted = resolve;
    });
    mockRegistry.getChat.mockImplementation((id) => (
      id === selectedChatId ? { agentId: 'codex', agentSessionId: 'thread-1' } : null
    ));
    mockAgents.loadMessages.mockImplementation(async () => {
      loadStarted();
      await new Promise((resolve) => {
        releaseLoad = resolve;
      });
      return [{ type: 'assistant-message', timestamp: ts, content: 'Loaded history' }];
    });

    const pending = cache.ensureLoaded(selectedChatId);
    await started;
    await cache.appendMessages(selectedChatId, [
      { type: 'assistant-message', timestamp: ts, content: 'Arrived live' },
    ]);
    releaseLoad();
    const messages = await pending;

    expect(messages.map((message) => message.content)).toEqual(['Loaded history', 'Arrived live']);
  });
});
