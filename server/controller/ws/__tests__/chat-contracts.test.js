import { beforeEach, describe, expect, it, mock } from 'bun:test';

mock.module('../utils.js', () => ({
  sendWebSocketJson: mock(() => true),
}));

import { ChatHandler } from '../chat.js';
import { sendWebSocketJson } from '../utils.js';
import { ChatRunningError, TranscriptHistoryUnavailableError } from '../../chats/errors.js';
import { StaleTranscriptViewError } from '../../ledger/errors.js';

const chatViewMessage = {
  ordinal: 1,
  message: { type: 'user-message', content: 'hello', timestamp: '2024-01-01T00:00:00Z' },
};

const mockProcessing = {
  phase: mock(() => null),
  snapshot: mock(() => [{ chatId: 'chat-running', phase: 'running' }]),
};

const mockRegistry = {
  getChat: mock(() => ({
    agentId: 'claude',
    nativePath: '/tmp/session.jsonl',
    agentSessionId: 'abc',
    agentOwnershipEpoch: 'epoch-1',
  })),
};

const mockTransientFeeds = {
  snapshot: mock(({ chatId, transcriptViewId }) => ({
    serverInstanceId: 'server-instance-test',
    chatId,
    transcriptViewId,
    transientRevision: 0,
    rows: [],
  })),
};

const mockChatViews = {
  readReplay: mock(() => ({
    transcriptViewId: 'view-1',
    messages: [chatViewMessage],
    firstOrdinal: 2,
    lastOrdinal: 2,
    nextAfterOrdinal: 2,
    throughOrdinal: 2,
    hasMore: false,
  })),
  resendCandidates: mock(() => []),
};

const mockTranscriptReload = mock(() => Promise.resolve({
  transcriptViewId: 'view-2',
  messages: [chatViewMessage],
  lastOrdinal: 1,
  pageOldestOrdinal: 1,
  pageNewestOrdinal: 1,
  hasMore: false,
}));

const mockQueue = {
  readChatExecutionControl: mock(() => Promise.resolve(storedQueue())),
};

function storedQueue() {
  return {
    serverInstanceId: 'server-instance-test',
    entries: [],
    controlEntries: [],
    recentlyDispatched: [],
    appliedCommands: [],
    pause: null,
    reorderRevision: 0,
    version: 3,
    updatedAt: '2024-01-01T00:00:00.000Z',
  };
}

const injectedMocks = [
  mockProcessing.phase,
  mockProcessing.snapshot,
  mockRegistry.getChat,
  mockChatViews.readReplay,
  mockChatViews.resendCandidates,
  mockTranscriptReload,
  mockQueue.readChatExecutionControl,
  mockTransientFeeds.snapshot,
];

const moduleMocks = [sendWebSocketJson];

function createHandler() {
  const instance = new ChatHandler({
    serverInstanceId: 'server-instance-test',
    processing: mockProcessing,
    chatViews: mockChatViews,
    transcriptReload: mockTranscriptReload,
    queue: mockQueue,
    transientFeeds: mockTransientFeeds,
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
    sendWebSocketJson.mockImplementation(() => true);
    mockProcessing.snapshot.mockReturnValue([{ chatId: 'chat-running', phase: 'running' }]);
    mockProcessing.phase.mockReturnValue(null);
    mockRegistry.getChat.mockReturnValue({
      agentId: 'claude',
      nativePath: '/tmp/session.jsonl',
      agentSessionId: 'abc',
      agentOwnershipEpoch: 'epoch-1',
    });
    mockQueue.readChatExecutionControl.mockResolvedValue(storedQueue());
    mockChatViews.readReplay.mockReturnValue({
      transcriptViewId: 'view-1',
      messages: [chatViewMessage],
      firstOrdinal: 2,
      lastOrdinal: 2,
      nextAfterOrdinal: 2,
      throughOrdinal: 2,
      hasMore: false,
    });
    mockChatViews.resendCandidates.mockReturnValue([]);
    mockTranscriptReload.mockResolvedValue({
      transcriptViewId: 'view-2',
      messages: [chatViewMessage],
      lastOrdinal: 1,
      pageOldestOrdinal: 1,
      pageNewestOrdinal: 1,
      hasMore: false,
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
      serverInstanceId: 'server-instance-test',
      processing: {
        outcome: 'snapshot',
        chats: [{ chatId: 'chat-running', phase: 'running' }],
      },
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
    mockProcessing.snapshot.mockReturnValue([]);

    await chatHandler.message(ws, {
      type: 'reconnect-state-query',
      clientRequestId: 'req-reconnect-empty',
      controlChatIds: [],
    });

    expect(lastSentPayload()).toEqual({
      type: 'reconnect-state',
      clientRequestId: 'req-reconnect-empty',
      serverInstanceId: 'server-instance-test',
      processing: { outcome: 'snapshot', chats: [] },
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
      serverInstanceId: 'server-instance-test',
      processing: {
        outcome: 'snapshot',
        chats: [{ chatId: 'chat-running', phase: 'running' }],
      },
      controlResults: [
        { chatId: 'chat-1', outcome: 'snapshot' },
        { chatId: 'deleted-chat', outcome: 'not-found' },
        { chatId: 'unavailable-chat', outcome: 'unavailable' },
      ],
    });
  });

  it('preserves queue outcomes when the processing projection is unavailable', async () => {
    mockProcessing.snapshot.mockImplementation(() => {
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
      serverInstanceId: 'server-instance-test',
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
    let chats = [{ chatId: 'chat-before', phase: 'running' }];
    mockProcessing.snapshot.mockImplementation(() => chats);
    mockQueue.readChatExecutionControl.mockReturnValue(heldQueue.promise);

    const response = chatHandler.message(ws, {
      type: 'reconnect-state-query',
      clientRequestId: 'req-reconnect-late-capture',
      controlChatIds: ['chat-1'],
    });
    await Promise.resolve();
    expect(mockProcessing.snapshot).not.toHaveBeenCalled();

    chats = [{ chatId: 'chat-after', phase: 'stopping' }];
    heldQueue.resolve(storedQueue());
    await response;

    expect(lastSentPayload()).toMatchObject({
      type: 'reconnect-state',
      serverInstanceId: 'server-instance-test',
      processing: {
        outcome: 'snapshot',
        chats: [{ chatId: 'chat-after', phase: 'stopping' }],
      },
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
      processing: {
        outcome: 'snapshot',
        chats: [{ chatId: 'chat-running', phase: 'running' }],
      },
    });

    expect(lastSentPayload()).toMatchObject({
      type: 'ws-pong',
      clientRequestId: 'req-ping-1',
      sentAt: 1234,
      serverInstanceId: 'server-instance-test',
      processing: {
        outcome: 'snapshot',
        chats: [{ chatId: 'chat-running', phase: 'running' }],
      },
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

  it('answers a malformed correlated subscribe instead of replaying or staying silent', async () => {
    await chatHandler.message(ws, {
      type: 'chat-subscribe',
      chatId: '123',
      clientRequestId: 'req-sub-invalid-cursor',
      transcriptViewId: 'view-1',
      afterOrdinal: 'not-an-ordinal',
    });

    expect(mockChatViews.readReplay).not.toHaveBeenCalled();
    expect(lastSentPayload()).toMatchObject({
      type: 'client-request-error',
      clientRequestId: 'req-sub-invalid-cursor',
      requestType: 'chat-subscribe',
      code: 'REQUEST_VALIDATION_FAILED',
      retryable: false,
      chatId: '123',
    });
  });

  it('replays view-qualified deltas for a subscribe cursor', async () => {
    mockChatViews.resendCandidates.mockReturnValueOnce([
      { ordinal: 1, content: 'hello', attachmentNames: [] },
    ]);
    await chatHandler.message(ws, {
      type: 'chat-subscribe',
      chatId: '123',
      clientRequestId: 'req-sub-1',
      transcriptViewId: 'view-1',
      afterOrdinal: 1,
    });

    expect(mockChatViews.readReplay).toHaveBeenCalledWith('123', 'view-1', 1);
    expect(lastSentPayload()).toMatchObject({
      type: 'chat-subscribed',
      clientRequestId: 'req-sub-1',
      chatId: '123',
      transcriptViewId: 'view-1',
      messages: [chatViewMessage],
      firstOrdinal: 2,
      lastOrdinal: 2,
      resendCandidates: [{ ordinal: 1, content: 'hello', attachmentNames: [] }],
      transientFeed: { transcriptViewId: 'view-1', rows: [] },
    });
  });

  it('captures a bounded replay watermark and returns its continuation fields', async () => {
    const replayMessage = { ...chatViewMessage, ordinal: 11 };
    mockChatViews.readReplay.mockReturnValueOnce({
      transcriptViewId: 'view-1',
      messages: [replayMessage],
      firstOrdinal: 11,
      lastOrdinal: 200,
      nextAfterOrdinal: 200,
      throughOrdinal: 600,
      hasMore: true,
    });

    await chatHandler.message(ws, {
      type: 'chat-subscribe',
      chatId: '123',
      clientRequestId: 'req-sub-bounded-first',
      transcriptViewId: 'view-1',
      afterOrdinal: 10,
    });

    expect(mockChatViews.readReplay).toHaveBeenCalledWith('123', 'view-1', 10);
    expect(lastSentPayload()).toMatchObject({
      type: 'chat-subscribed',
      clientRequestId: 'req-sub-bounded-first',
      chatId: '123',
      transcriptViewId: 'view-1',
      nextAfterOrdinal: 200,
      throughOrdinal: 600,
      hasMore: true,
    });
  });

  it('rejects a replay row that cannot fit in one bounded response frame', async () => {
    mockChatViews.readReplay.mockReturnValueOnce({
      transcriptViewId: 'view-1',
      messages: [{
        ordinal: 2,
        message: {
          type: 'assistant-message',
          content: 'x'.repeat(1024 * 1024),
          timestamp: '2024-01-01T00:00:00Z',
        },
      }],
      firstOrdinal: 2,
      lastOrdinal: 2,
      nextAfterOrdinal: 2,
      throughOrdinal: 2,
      hasMore: false,
    });

    await chatHandler.message(ws, {
      type: 'chat-subscribe',
      chatId: '123',
      clientRequestId: 'req-sub-oversized-row',
      transcriptViewId: 'view-1',
      afterOrdinal: 1,
    });

    expect(sendWebSocketJson).toHaveBeenCalledTimes(1);
    expect(lastSentPayload()).toMatchObject({
      type: 'client-request-error',
      clientRequestId: 'req-sub-oversized-row',
      requestType: 'chat-subscribe',
      code: 'HISTORY_LOAD_FAILED',
      retryable: false,
      chatId: '123',
      message: 'A transcript replay row exceeds the WebSocket response limit',
    });
    expect(Buffer.byteLength(JSON.stringify(lastSentPayload()), 'utf8')).toBeLessThan(1024);
  });

  it('rejects a replay request when its response is dropped by the socket', async () => {
    sendWebSocketJson.mockImplementation(() => false);

    await expect(chatHandler.message(ws, {
      type: 'chat-subscribe',
      chatId: '123',
      clientRequestId: 'req-sub-dropped',
      transcriptViewId: 'view-1',
      afterOrdinal: 10,
    })).rejects.toThrow();

    expect(mockChatViews.readReplay).toHaveBeenCalledWith('123', 'view-1', 10);
    expect(sendWebSocketJson).toHaveBeenCalledWith(
      ws,
      expect.objectContaining({
        type: 'chat-subscribed',
        clientRequestId: 'req-sub-dropped',
      }),
    );
  });

  it('[TLV5-REPLAY.02-CONTRACT-01] repeats the captured replay watermark on continuation requests', async () => {
    mockChatViews.readReplay.mockReturnValueOnce({
      transcriptViewId: 'view-1',
      messages: [],
      firstOrdinal: 201,
      lastOrdinal: 400,
      nextAfterOrdinal: 400,
      throughOrdinal: 600,
      hasMore: true,
    });

    await chatHandler.message(ws, {
      type: 'chat-subscribe',
      chatId: '123',
      clientRequestId: 'req-sub-bounded-next',
      transcriptViewId: 'view-1',
      afterOrdinal: 200,
      throughOrdinal: 600,
    });

    expect(mockChatViews.readReplay).toHaveBeenCalledWith('123', 'view-1', 200, 600);
    expect(lastSentPayload()).toMatchObject({
      type: 'chat-subscribed',
      clientRequestId: 'req-sub-bounded-next',
      chatId: '123',
      transcriptViewId: 'view-1',
      messages: [],
      nextAfterOrdinal: 400,
      throughOrdinal: 600,
      hasMore: true,
    });
  });

  it('suppresses resend candidates while the chat is processing', async () => {
    mockProcessing.phase.mockReturnValueOnce('running');
    mockChatViews.resendCandidates.mockReturnValueOnce([
      { ordinal: 1, content: 'hello', attachmentNames: [] },
    ]);

    await chatHandler.message(ws, {
      type: 'chat-subscribe',
      chatId: '123',
      clientRequestId: 'req-sub-running',
      transcriptViewId: 'view-1',
      afterOrdinal: 1,
    });

    expect(lastSentPayload()).toMatchObject({
      type: 'chat-subscribed',
      resendCandidates: [],
    });
    expect(mockChatViews.resendCandidates).not.toHaveBeenCalled();
  });

  it('returns a typed stale-view error when replay addresses a replaced view', async () => {
    mockChatViews.readReplay.mockRejectedValueOnce(
      new StaleTranscriptViewError('123', 'view-1', 'view-2'),
    );

    await chatHandler.message(ws, {
      type: 'chat-subscribe',
      chatId: '123',
      clientRequestId: 'req-sub-stale',
      transcriptViewId: 'view-1',
      afterOrdinal: 99,
    });

    expect(lastSentPayload()).toMatchObject({
      type: 'client-request-error',
      clientRequestId: 'req-sub-stale',
      chatId: '123',
      code: 'STALE_TRANSCRIPT_VIEW',
      retryable: false,
    });
  });

  it('[TLV5-L11.01-WS-CONTRACT-01] reports a fenced replay with a fixed non-retryable error', async () => {
    const sentinel = '/sentinel-root/chat-sentinel/ledger.sqlite';
    mockChatViews.readReplay.mockRejectedValueOnce(
      new TranscriptHistoryUnavailableError({
        kind: 'degraded',
        errorCode: 'LEDGER_FENCED',
        retryable: false,
      }, { cause: new Error(sentinel) }),
    );

    await chatHandler.message(ws, {
      type: 'chat-subscribe',
      chatId: '123',
      clientRequestId: 'req-sub-fenced',
      transcriptViewId: 'view-1',
      afterOrdinal: 0,
    });

    expect(lastSentPayload()).toEqual({
      type: 'client-request-error',
      clientRequestId: 'req-sub-fenced',
      requestType: 'chat-subscribe',
      code: 'HISTORY_LOAD_FAILED',
      message: 'The transcript ledger is unavailable',
      retryable: false,
      chatId: '123',
    });
    expect(JSON.stringify(lastSentPayload())).not.toContain(sentinel);
  });

  it('returns the replacement transcript after a manual native reload', async () => {
    await chatHandler.message(ws, {
      type: 'chat-reload',
      chatId: '123',
      clientRequestId: 'req-reload-1',
    });

    expect(mockTranscriptReload).toHaveBeenCalledWith('123');
    expect(lastSentPayload()).toMatchObject({
      type: 'chat-reloaded',
      clientRequestId: 'req-reload-1',
      chatId: '123',
      transcriptViewId: 'view-2',
      messages: [chatViewMessage],
      lastOrdinal: 1,
      pageOldestOrdinal: 1,
      pageNewestOrdinal: 1,
      hasMore: false,
    });
    expect(ws.publish).not.toHaveBeenCalled();
  });

  it('returns retryable CHAT_RUNNING for running-chat reload failures', async () => {
    mockTranscriptReload.mockRejectedValueOnce(
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

  it('returns retryable HISTORY_LOAD_FAILED when native history is not present yet', async () => {
    mockTranscriptReload.mockRejectedValueOnce(
      Object.assign(new Error('native history is not present yet'), { code: 'ENOENT' }),
    );

    await chatHandler.message(ws, {
      type: 'chat-reload',
      chatId: '123',
      clientRequestId: 'req-reload-history-pending',
    });

    expect(lastSentPayload()).toMatchObject({
      type: 'client-request-error',
      clientRequestId: 'req-reload-history-pending',
      requestType: 'chat-reload',
      chatId: '123',
      code: 'HISTORY_LOAD_FAILED',
      retryable: true,
    });
  });
});
