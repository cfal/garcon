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
  getRunningSessions: mock(() => ({
    claude: [],
    codex: [],
    opencode: [],
    amp: [],
    factory: [],
    'direct-anthropic-compatible': [],
    'direct-openai-compatible': [],
    'direct-openai-responses-compatible': [],
  })),
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

const injectedMocks = [
  mockAgents.getRunningSessions,
  mockRegistry.getChat,
  mockChatViews.readReplay,
  mockNativeReloader.reloadFromNative,
];

const moduleMocks = [sendWebSocketJson];

function createHandler(overrides = {}) {
  const instance = new ChatHandler({
    agents: mockAgents,
    chatViews: mockChatViews,
    nativeReloader: mockNativeReloader,
    registry: mockRegistry,
    ...overrides,
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

  it('responds with running sessions', async () => {
    await chatHandler.message(ws, {
      type: 'chats-running-query',
      clientRequestId: 'req-running-1',
    });

    expect(lastSentPayload()).toMatchObject({
      type: 'chat-sessions-running',
      clientRequestId: 'req-running-1',
      sessions: mockAgents.getRunningSessions(),
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

  it('updates browser notification presence without sending a response', async () => {
    const browserPresence = { update: mock(() => undefined) };
    chatHandler = createHandler({ browserPresence });

    await chatHandler.message(ws, {
      type: 'browser-notification-presence',
      clientId: 'client-1',
      endpointHash: 'endpoint-hash-1',
      selectedChatId: 'chat-1',
      visibility: 'visible',
      hasFocus: true,
      displayMode: 'standalone',
      sentAt: 1234,
    });

    expect(browserPresence.update).toHaveBeenCalledWith(expect.objectContaining({
      clientId: 'client-1',
      endpointHash: 'endpoint-hash-1',
      selectedChatId: 'chat-1',
    }));
    expect(sendWebSocketJson).not.toHaveBeenCalled();
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
