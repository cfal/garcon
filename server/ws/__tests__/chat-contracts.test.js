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
  getRunningChatIdsSnapshot: mock(() => ['chat-running']),
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
  readChatExecutionControl: mock(() => Promise.resolve(storedQueue())),
};

const mockPendingInputs = {
  listForTransport: mock(() => []),
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
  mockAgents.getRunningChatIdsSnapshot,
  mockRegistry.getChat,
  mockChatViews.readReplay,
  mockNativeReloader.reloadFromNative,
  mockQueue.readChatExecutionControl,
  mockPendingInputs.listForTransport,
];

const moduleMocks = [sendWebSocketJson];

function createHandler() {
  const instance = new ChatHandler({
    agents: mockAgents,
    chatViews: mockChatViews,
    nativeReloader: mockNativeReloader,
    queue: mockQueue,
    pendingInputs: mockPendingInputs,
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

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('chat WebSocket handler', () => {
  let ws;
  let chatHandler;

  beforeEach(() => {
    injectedMocks.forEach((fn) => fn.mockClear());
    moduleMocks.forEach((fn) => fn.mockClear());
    mockAgents.getRunningChatIdsSnapshot.mockReturnValue(['chat-running']);
    mockRegistry.getChat.mockReturnValue({ agentId: 'claude', nativePath: '/tmp/session.jsonl', agentSessionId: 'abc' });
    mockQueue.readChatExecutionControl.mockResolvedValue(storedQueue());
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

  it('responds with a processing snapshot and per-chat queue outcomes for reconnect', async () => {
    await chatHandler.message(ws, {
      type: 'reconnect-state-query',
      clientRequestId: 'req-reconnect-1',
      controlChatIds: ['chat-1', 'chat-2'],
    });

    expect(mockQueue.readChatExecutionControl).toHaveBeenCalledTimes(2);
    expect(lastSentPayload()).toEqual({
      type: 'reconnect-state',
      clientRequestId: 'req-reconnect-1',
      processing: { outcome: 'snapshot', runningChatIds: ['chat-running'] },
      controlResults: [
        { chatId: 'chat-1', outcome: 'snapshot', control: expect.objectContaining({ version: 3 }) },
        { chatId: 'chat-2', outcome: 'snapshot', control: expect.objectContaining({ version: 3 }) },
      ],
    });
  });

  it('omits the server-only pause stack from reconnect execution-control snapshots', async () => {
    mockQueue.readChatExecutionControl.mockResolvedValue({
      ...storedQueue(),
      pause: {
        kind: 'manual',
        id: 'pause-manual',
        pausedAt: '2024-01-01T00:00:00.000Z',
      },
      resumePauses: [{
        kind: 'provider-error',
        id: 'pause-provider',
        pausedAt: '2023-12-31T23:59:00.000Z',
        entryId: 'entry-1',
        errorCode: 'PROVIDER_FAILED',
        message: 'provider failed',
      }],
    });

    await chatHandler.message(ws, {
      type: 'reconnect-state-query',
      clientRequestId: 'req-reconnect-hidden-pauses',
      controlChatIds: ['chat-1'],
    });

    const control = lastSentPayload().controlResults[0].control;
    expect(control.queue.pause).toMatchObject({
      kind: 'manual',
      id: 'pause-manual',
    });
    expect(control.queue).not.toHaveProperty('resumePauses');
  });

  it('returns an authoritative empty processing snapshot', async () => {
    mockAgents.getRunningChatIdsSnapshot.mockReturnValue([]);

    await chatHandler.message(ws, {
      type: 'reconnect-state-query',
      clientRequestId: 'req-reconnect-empty',
      controlChatIds: [],
    });

    expect(lastSentPayload()).toEqual({
      type: 'reconnect-state',
      clientRequestId: 'req-reconnect-empty',
      processing: { outcome: 'snapshot', runningChatIds: [] },
      controlResults: [],
    });
  });

  it('returns explicit not-found and unavailable reconnect queue outcomes', async () => {
    mockRegistry.getChat.mockImplementation((chatId) => (
      chatId === 'deleted-chat'
        ? null
        : { agentId: 'claude', nativePath: '/tmp/session.jsonl', agentSessionId: 'abc' }
    ));
    mockQueue.readChatExecutionControl.mockImplementation((chatId) => (
      chatId === 'unavailable-chat'
        ? Promise.reject(new Error('disk unavailable'))
        : Promise.resolve(storedQueue())
    ));

    await chatHandler.message(ws, {
      type: 'reconnect-state-query',
      clientRequestId: 'req-reconnect-2',
      controlChatIds: ['chat-1', 'deleted-chat', 'unavailable-chat'],
    });

    expect(mockQueue.readChatExecutionControl).toHaveBeenCalledTimes(2);
    expect(lastSentPayload()).toMatchObject({
      type: 'reconnect-state',
      processing: { outcome: 'snapshot', runningChatIds: ['chat-running'] },
      controlResults: [
        { chatId: 'chat-1', outcome: 'snapshot' },
        { chatId: 'deleted-chat', outcome: 'not-found' },
        { chatId: 'unavailable-chat', outcome: 'unavailable' },
      ],
    });
  });

  it('preserves queue outcomes when the processing projection is unavailable', async () => {
    mockAgents.getRunningChatIdsSnapshot.mockImplementation(() => {
      throw new Error('mapping incomplete');
    });
    mockRegistry.getChat.mockImplementation((chatId) => (
      chatId === 'deleted-chat'
        ? null
        : { agentId: 'claude', nativePath: '/tmp/session.jsonl', agentSessionId: 'abc' }
    ));
    mockQueue.readChatExecutionControl.mockImplementation((chatId) => (
      chatId === 'unavailable-chat'
        ? Promise.reject(new Error('disk unavailable'))
        : Promise.resolve(storedQueue())
    ));

    await chatHandler.message(ws, {
      type: 'reconnect-state-query',
      clientRequestId: 'req-reconnect-processing-unavailable',
      controlChatIds: ['chat-1', 'deleted-chat', 'unavailable-chat'],
    });

    expect(lastSentPayload()).toMatchObject({
      type: 'reconnect-state',
      clientRequestId: 'req-reconnect-processing-unavailable',
      processing: { outcome: 'unavailable' },
      controlResults: [
        { chatId: 'chat-1', outcome: 'snapshot' },
        { chatId: 'deleted-chat', outcome: 'not-found' },
        { chatId: 'unavailable-chat', outcome: 'unavailable' },
      ],
    });
  });

  it('captures processing after asynchronous queue reads finish', async () => {
    const heldQueue = deferred();
    let runningChatIds = ['chat-before'];
    mockAgents.getRunningChatIdsSnapshot.mockImplementation(() => runningChatIds);
    mockQueue.readChatExecutionControl.mockReturnValue(heldQueue.promise);

    const response = chatHandler.message(ws, {
      type: 'reconnect-state-query',
      clientRequestId: 'req-reconnect-late-capture',
      controlChatIds: ['chat-1'],
    });
    await Promise.resolve();
    expect(mockAgents.getRunningChatIdsSnapshot).not.toHaveBeenCalled();

    runningChatIds = ['chat-after'];
    heldQueue.resolve(storedQueue());
    await response;

    expect(lastSentPayload()).toMatchObject({
      type: 'reconnect-state',
      processing: { outcome: 'snapshot', runningChatIds: ['chat-after'] },
    });
  });

  it('sends an immediate correlated error for unexpected reconnect failures', async () => {
    mockRegistry.getChat.mockImplementation(() => {
      throw new Error('registry unavailable');
    });

    await chatHandler.message(ws, {
      type: 'reconnect-state-query',
      clientRequestId: 'req-reconnect-failed',
      controlChatIds: ['chat-1'],
    });

    expect(lastSentPayload()).toEqual({
      type: 'client-request-error',
      clientRequestId: 'req-reconnect-failed',
      requestType: 'reconnect-state-query',
      code: 'INTERNAL_ERROR',
      message: 'Failed to reconcile reconnect state',
      retryable: true,
    });
  });

  it('sends an uncorrelated fault when a failed reconnect request has no ID', async () => {
    mockRegistry.getChat.mockImplementation(() => {
      throw new Error('registry unavailable');
    });

    await chatHandler.message(ws, {
      type: 'reconnect-state-query',
      controlChatIds: ['chat-1'],
    });

    expect(lastSentPayload()).toEqual({
      type: 'ws-fault',
      error: 'Failed to reconcile reconnect state',
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
    const pendingInput = {
      chatId: '123',
      clientRequestId: 'req-unconfirmed',
      content: 'unconfirmed while disconnected',
      createdAt: '2024-01-01T00:00:00.000Z',
      deliveryStatus: 'unconfirmed',
    };
    mockPendingInputs.listForTransport.mockReturnValueOnce([pendingInput]);
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
      pendingUserInputs: [pendingInput],
    });
    expect(mockPendingInputs.listForTransport).toHaveBeenCalledWith('123');
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
      pendingUserInputs: [],
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
    expect(ws.publish.mock.calls[0][2]).toBe(true);
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
