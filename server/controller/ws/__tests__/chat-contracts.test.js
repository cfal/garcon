import { beforeEach, describe, expect, it, mock } from 'bun:test';

mock.module('../utils.js', () => ({
  sendWebSocketJson: mock(() => true),
}));

import { ChatHandler } from '../chat.js';
import { sendWebSocketJson } from '../utils.js';
import { TranscriptHistoryUnavailableError } from '../../chats/errors.js';
import { DomainError } from '../../../common/domain-error.js';

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
  mockTranscriptReload,
  mockQueue.readChatExecutionControl,
];

const moduleMocks = [sendWebSocketJson];

function createHandler() {
  const instance = new ChatHandler({
    serverInstanceId: 'server-instance-test',
    processing: mockProcessing,
    transcriptReload: mockTranscriptReload,
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

function sentPayloads() {
  return sendWebSocketJson.mock.calls.map(([, payload]) => JSON.parse(JSON.stringify(payload)));
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
    mockTranscriptReload.mockResolvedValue({
      transcriptViewId: 'view-2',
      lastOrdinal: 1,
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

  for (const type of ['chat-reload']) {
    for (const chatId of [undefined, null, '', 123]) {
      for (const cursor of [{}, { transcriptViewId: 'view-1', afterOrdinal: 0 }]) {
        it(`correlates ${type} with invalid chatId ${chatId} and cursor ${JSON.stringify(cursor)}`, async () => {
          await chatHandler.message(ws, {
            type, chatId, clientRequestId: 'req-missing-chat', ...cursor,
          });
          expect(lastSentPayload()).toMatchObject({
            type: 'client-request-error', clientRequestId: 'req-missing-chat',
            requestType: type, code: 'MISSING_CHAT_ID', retryable: false,
          });
        });
      }
    }
    it(`retains a global fault for uncorrelatable ${type}`, async () => {
      await chatHandler.message(ws, { type });
      expect(lastSentPayload()).toMatchObject({ type: 'ws-fault' });
    });
  }

  it('does not use a reload cancellation target as request correlation', async () => {
    await chatHandler.message(ws, { type: 'chat-reload-cancel', reloadRequestId: 'req-reload' });
    expect(lastSentPayload()).toMatchObject({ type: 'ws-fault' });
    expect(lastSentPayload().clientRequestId).toBeUndefined();
  });

  it('does not serve the retired raw subscribe protocol', async () => {
    await chatHandler.message(ws, { type: 'chat-subscribe', chatId: '123', clientRequestId: 'retired', transcriptViewId: 'view-1', afterOrdinal: 0 });
    expect(sendWebSocketJson).not.toHaveBeenCalled();
  });

  it('returns the replacement transcript after a manual native reload', async () => {
    await chatHandler.message(ws, {
      type: 'chat-reload',
      chatId: '123',
      clientRequestId: 'req-reload-1',
    });

    expect(mockTranscriptReload).toHaveBeenCalledWith('123', {
      signal: expect.any(AbortSignal),
      onProgress: expect.any(Function),
    });
    expect(lastSentPayload()).toMatchObject({
      type: 'chat-reloaded',
      clientRequestId: 'req-reload-1',
      chatId: '123',
      transcriptViewId: 'view-2',
      lastOrdinal: 1,
    });
    expect(lastSentPayload()).not.toHaveProperty('messages');
    expect(ws.publish).not.toHaveBeenCalled();
  });

  it('acknowledges a reload at once and reports each phase before the result', async () => {
    mockTranscriptReload.mockImplementationOnce(async (_chatId, { onProgress }) => {
      onProgress({ phase: 'reading', rows: 0 });
      onProgress({ phase: 'reading', rows: 250 });
      onProgress({ phase: 'saving', rows: 500 });
      return {
        transcriptViewId: 'view-2',
          lastOrdinal: 1,
            };
    });

    await chatHandler.message(ws, { type: 'chat-reload', chatId: '123', clientRequestId: 'req-progress' });

    expect(sentPayloads().map(({ type, phase, rows }) => ({ type, phase, rows }))).toEqual([
      { type: 'chat-reload-progress', phase: 'preparing', rows: 0 },
      { type: 'chat-reload-progress', phase: 'reading', rows: 0 },
      { type: 'chat-reload-progress', phase: 'saving', rows: 500 },
      { type: 'chat-reloaded', phase: undefined, rows: undefined },
    ]);
    expect(sentPayloads()[0]).toMatchObject({ clientRequestId: 'req-progress', chatId: '123' });
  });

  it('repeats the latest reload progress every second while the reload runs', async () => {
    const pending = deferred();
    mockTranscriptReload.mockImplementationOnce(async (_chatId, { onProgress }) => {
      onProgress({ phase: 'reading', rows: 40 });
      onProgress({ phase: 'reading', rows: 90 });
      return pending.promise;
    });

    const reloading = chatHandler.message(ws, {
      type: 'chat-reload', chatId: '123', clientRequestId: 'req-slow',
    });
    await Bun.sleep(1_100);
    pending.resolve({
      transcriptViewId: 'view-2',
      lastOrdinal: 1,
    });
    await reloading;

    const progress = sentPayloads().filter((payload) => payload.type === 'chat-reload-progress');
    expect(progress.map(({ phase, rows }) => [phase, rows])).toEqual([
      ['preparing', 0],
      ['reading', 40],
      ['reading', 90],
    ]);
    expect(lastSentPayload()).toMatchObject({ type: 'chat-reloaded', clientRequestId: 'req-slow' });
  });

  it('cancels a reload only for the requesting socket and reports the cancellation', async () => {
    let signal;
    const entered = deferred();
    mockTranscriptReload.mockImplementationOnce(async (_chatId, options) => {
      signal = options.signal;
      entered.resolve();
      await new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      });
    });

    const reloading = chatHandler.message(ws, {
      type: 'chat-reload', chatId: '123', clientRequestId: 'req-cancel',
    });
    await entered.promise;
    await chatHandler.message(createMockWs(), {
      type: 'chat-reload-cancel', chatId: '123', reloadRequestId: 'req-cancel',
    });
    await chatHandler.message(ws, {
      type: 'chat-reload-cancel', chatId: 'other-chat', reloadRequestId: 'req-cancel',
    });
    expect(signal.aborted).toBe(false);

    await chatHandler.message(ws, {
      type: 'chat-reload-cancel', chatId: '123', reloadRequestId: 'req-cancel',
    });
    await reloading;

    expect(signal.aborted).toBe(true);
    expect(lastSentPayload()).toEqual({
      type: 'client-request-error',
      clientRequestId: 'req-cancel',
      requestType: 'chat-reload',
      code: 'REQUEST_CANCELLED',
      message: 'Reload cancelled',
      retryable: true,
      chatId: '123',
    });
  });

  it('keeps reloading when a progress frame cannot be delivered', async () => {
    sendWebSocketJson.mockImplementationOnce(() => false);

    await chatHandler.message(ws, { type: 'chat-reload', chatId: '123', clientRequestId: 'req-dropped' });

    expect(mockTranscriptReload).toHaveBeenCalledTimes(1);
    expect(lastSentPayload()).toMatchObject({ type: 'chat-reloaded', clientRequestId: 'req-dropped' });
  });

  it('returns retryable CHAT_RUNNING for running-chat reload failures', async () => {
    mockTranscriptReload.mockRejectedValueOnce(
      new DomainError('CHAT_RUNNING', 'Cannot reload running chat: 123', 409, true),
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
