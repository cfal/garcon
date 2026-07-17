import { beforeEach, describe, expect, it, mock } from 'bun:test';

mock.module('../utils.js', () => ({
  sendWebSocketJson: mock(() => undefined),
}));

import { ChatHandler } from '../chat.js';
import { sendWebSocketJson } from '../utils.js';
import { ChatRunningError } from '../../chats/errors.js';

const chatViewMessage = {
  seq: 1,
  message: { type: 'user-message', content: 'hello', timestamp: '2024-01-01T00:00:00Z' },
};

const mockAgents = {
  getRunningSessions: mock(() => ({ claude: [] })),
};

const mockRegistry = {
  getChat: mock(() => ({ agentId: 'claude', nativePath: '/tmp/session.jsonl', agentSessionId: 'abc' })),
};

const mockChatViews = {
  readReplay: mock(() => ({
    generationId: 'generation-1',
    mode: 'delta',
    messages: [chatViewMessage],
    lastSeq: 1,
  })),
};

const mockNativeReloader = {
  reloadFromNative: mock(() => Promise.resolve({
    generationId: 'generation-2',
    messages: [chatViewMessage],
    lastSeq: 1,
    pageOldestSeq: 1,
    hasMore: false,
    mode: 'manual-reload',
  })),
};

const mockQueue = {
  readChatQueue: mock(() => Promise.resolve(storedQueue())),
};

function storedQueue() {
  return {
    entries: [],
    recentlyDispatched: [],
    appliedCommands: [],
    pause: null,
    version: 3,
    updatedAt: '2024-01-01T00:00:00.000Z',
  };
}

const injectedMocks = [
  mockAgents.getRunningSessions,
  mockRegistry.getChat,
  mockChatViews.readReplay,
  mockNativeReloader.reloadFromNative,
  mockQueue.readChatQueue,
];

const moduleMocks = [sendWebSocketJson];

function createHandler() {
  const instance = new ChatHandler({
    agents: mockAgents,
    chatViews: mockChatViews,
    nativeReloader: mockNativeReloader,
    queue: mockQueue,
    registry: mockRegistry,
  });
  return instance.createHandler();
}

function createMockWs() {
  return {
    subscribe: mock(() => undefined),
    publish: mock(() => undefined),
  };
}

function lastSentPayload() {
  const calls = sendWebSocketJson.mock.calls;
  return calls.length > 0 ? calls[calls.length - 1][1] : null;
}

function lastPublishedPayload(ws) {
  const calls = ws.publish.mock.calls;
  return calls.length > 0 ? JSON.parse(calls[calls.length - 1][1]) : null;
}

describe('chat WebSocket handler', () => {
  let ws;
  let chatHandler;

  beforeEach(() => {
    injectedMocks.forEach((fn) => fn.mockClear());
    moduleMocks.forEach((fn) => fn.mockClear());
    mockRegistry.getChat.mockReturnValue({ agentId: 'claude', nativePath: '/tmp/session.jsonl', agentSessionId: 'abc' });
    mockAgents.getRunningSessions.mockReturnValue({ claude: [] });
    mockQueue.readChatQueue.mockResolvedValue(storedQueue());
    mockChatViews.readReplay.mockReturnValue({
      generationId: 'generation-1',
      mode: 'delta',
      messages: [chatViewMessage],
      lastSeq: 1,
    });
    mockNativeReloader.reloadFromNative.mockResolvedValue({
      generationId: 'generation-2',
      messages: [chatViewMessage],
      lastSeq: 1,
      pageOldestSeq: 1,
      hasMore: false,
      mode: 'manual-reload',
    });
    ws = createMockWs();
    chatHandler = createHandler();
  });

  it('subscribes the socket to the chat topic on open', () => {
    chatHandler.open(ws);
    expect(ws.subscribe).toHaveBeenCalledWith('chat');
  });

  it('responds with a provider-agnostic processing snapshot and per-chat queue outcomes', async () => {
    mockAgents.getRunningSessions.mockReturnValue({
      claude: [{ id: ' chat-2 ', status: 'running' }, { id: 'chat-1' }],
      codex: [{ id: 'chat-2', startedAt: '2024-01-01T00:00:00.000Z' }],
    });

    await chatHandler.message(ws, {
      type: 'reconnect-state-query',
      clientRequestId: 'req-reconnect-1',
      queueChatIds: ['chat-1', 'chat-2'],
    });

    expect(mockQueue.readChatQueue).toHaveBeenCalledTimes(2);
    expect(lastSentPayload()).toEqual({
      type: 'reconnect-state',
      clientRequestId: 'req-reconnect-1',
      processing: { outcome: 'snapshot', runningChatIds: ['chat-1', 'chat-2'] },
      queueResults: [
        { chatId: 'chat-1', outcome: 'snapshot', queue: expect.objectContaining({ version: 3 }) },
        { chatId: 'chat-2', outcome: 'snapshot', queue: expect.objectContaining({ version: 3 }) },
      ],
    });
  });

  it('returns queue outcomes when the processing snapshot is unavailable', async () => {
    mockAgents.getRunningSessions.mockImplementation(() => {
      throw new Error('runtime unavailable');
    });

    await chatHandler.message(ws, {
      type: 'reconnect-state-query',
      clientRequestId: 'req-reconnect-unavailable',
      queueChatIds: ['chat-1'],
    });

    expect(lastSentPayload()).toMatchObject({
      type: 'reconnect-state',
      clientRequestId: 'req-reconnect-unavailable',
      processing: { outcome: 'unavailable' },
      queueResults: [{ chatId: 'chat-1', outcome: 'snapshot' }],
    });
  });

  it('does not publish a partial processing snapshot for malformed provider groups', async () => {
    mockAgents.getRunningSessions.mockReturnValue({ claude: { id: 'chat-1' } });

    await chatHandler.message(ws, {
      type: 'reconnect-state-query',
      clientRequestId: 'req-reconnect-malformed',
      queueChatIds: [],
    });

    expect(lastSentPayload()).toEqual({
      type: 'reconnect-state',
      clientRequestId: 'req-reconnect-malformed',
      processing: { outcome: 'unavailable' },
      queueResults: [],
    });
  });

  it('returns explicit not-found and unavailable reconnect queue outcomes', async () => {
    mockRegistry.getChat.mockImplementation((chatId) => (
      chatId === 'deleted-chat'
        ? null
        : { agentId: 'claude', nativePath: '/tmp/session.jsonl', agentSessionId: 'abc' }
    ));
    mockQueue.readChatQueue.mockImplementation((chatId) => (
      chatId === 'unavailable-chat'
        ? Promise.reject(new Error('disk unavailable'))
        : Promise.resolve(storedQueue())
    ));

    await chatHandler.message(ws, {
      type: 'reconnect-state-query',
      clientRequestId: 'req-reconnect-2',
      queueChatIds: ['chat-1', 'deleted-chat', 'unavailable-chat'],
    });

    expect(mockQueue.readChatQueue).toHaveBeenCalledTimes(2);
    expect(lastSentPayload()).toMatchObject({
      type: 'reconnect-state',
      queueResults: [
        { chatId: 'chat-1', outcome: 'snapshot' },
        { chatId: 'deleted-chat', outcome: 'not-found' },
        { chatId: 'unavailable-chat', outcome: 'unavailable' },
      ],
    });
  });

  it('responds to application heartbeat pings', async () => {
    await chatHandler.message(ws, {
      type: 'ws-ping',
      clientRequestId: 'req-ping-1',
      sentAt: 1234,
    });

    expect(lastSentPayload()).toMatchObject({
      type: 'ws-pong',
      clientRequestId: 'req-ping-1',
      sentAt: 1234,
    });
    expect(typeof lastSentPayload().serverTime).toBe('string');
  });

  it('sends ws-fault for missing chatId', async () => {
    await chatHandler.message(ws, {
      type: 'chat-subscribe',
      clientRequestId: 'req-missing-chat',
    });

    expect(lastSentPayload()).toMatchObject({ type: 'ws-fault' });
    expect(lastSentPayload().error).toContain('Missing chatId');
  });

  it('replays same-generation deltas for a subscribe cursor', async () => {
    await chatHandler.message(ws, {
      type: 'chat-subscribe',
      chatId: '123',
      clientRequestId: 'req-sub-1',
      generationId: 'generation-1',
      afterSeq: 1,
    });

    expect(mockChatViews.readReplay).toHaveBeenCalledWith('123', 'generation-1', 1);
    expect(lastSentPayload()).toMatchObject({
      type: 'chat-subscribed',
      clientRequestId: 'req-sub-1',
      chatId: '123',
      generationId: 'generation-1',
      mode: 'delta',
      messages: [chatViewMessage],
      lastSeq: 1,
    });
  });

  it('returns snapshot-required with null generationId when no view is loaded', async () => {
    mockChatViews.readReplay.mockReturnValueOnce(null);

    await chatHandler.message(ws, {
      type: 'chat-subscribe',
      chatId: '123',
      clientRequestId: 'req-sub-unloaded',
      generationId: 'generation-1',
      afterSeq: 1,
    });

    expect(lastSentPayload()).toMatchObject({
      type: 'chat-subscribed',
      clientRequestId: 'req-sub-unloaded',
      chatId: '123',
      generationId: null,
      mode: 'snapshot-required',
      messages: [],
      lastSeq: 0,
    });
  });

  it('forwards snapshot-required replay results', async () => {
    mockChatViews.readReplay.mockReturnValueOnce({
      generationId: 'generation-2',
      mode: 'snapshot-required',
      messages: [],
      lastSeq: 3,
    });

    await chatHandler.message(ws, {
      type: 'chat-subscribe',
      chatId: '123',
      clientRequestId: 'req-sub-ahead',
      generationId: 'generation-1',
      afterSeq: 99,
    });

    expect(lastSentPayload()).toMatchObject({
      type: 'chat-subscribed',
      clientRequestId: 'req-sub-ahead',
      generationId: 'generation-2',
      mode: 'snapshot-required',
      messages: [],
      lastSeq: 3,
    });
  });

  it('reloads from native and broadcasts a lightweight generation reset', async () => {
    await chatHandler.message(ws, {
      type: 'chat-reload',
      chatId: '123',
      clientRequestId: 'req-reload-1',
    });

    expect(mockNativeReloader.reloadFromNative).toHaveBeenCalledWith('123', 'manual-reload');
    expect(lastSentPayload()).toMatchObject({
      type: 'chat-reloaded',
      clientRequestId: 'req-reload-1',
      chatId: '123',
      generationId: 'generation-2',
      messages: [chatViewMessage],
      lastSeq: 1,
      pageOldestSeq: 1,
      hasMore: false,
    });
    expect(lastPublishedPayload(ws)).toMatchObject({
      type: 'chat-generation-reset',
      chatId: '123',
      generationId: 'generation-2',
      reason: 'manual-reload',
      lastSeq: 1,
    });
    expect(ws.publish.mock.calls[0][0]).toBe('chat');
  });

  it('returns retryable CHAT_RUNNING for running-chat reload failures', async () => {
    mockNativeReloader.reloadFromNative.mockRejectedValueOnce(
      new ChatRunningError('123'),
    );

    await chatHandler.message(ws, {
      type: 'chat-reload',
      chatId: '123',
      clientRequestId: 'req-reload-running',
    });

    expect(lastSentPayload()).toMatchObject({
      type: 'client-request-error',
      clientRequestId: 'req-reload-running',
      code: 'CHAT_RUNNING',
      retryable: true,
    });
  });
});
