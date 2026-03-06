// Contract tests for the chat WebSocket message handler.
// Verifies dispatch routing and response shapes for all message types.
// Dependencies injected via constructor are mocked as plain objects;
// sendWebSocketJson remains a module mock because chat.js imports it
// at the top level.

import { describe, it, expect, mock, beforeEach } from 'bun:test';

mock.module('../utils.js', () => ({
  sendWebSocketJson: mock(() => undefined),
}));

import { ChatHandler } from '../chat.js';
import { sendWebSocketJson } from '../utils.js';

const mockProviders = {
  getRunningSessions: mock(() => ({ claude: [], codex: [], opencode: [] })),
  resolvePermission: mock(() => undefined),
  setPermissionMode: mock(() => Promise.resolve(undefined)),
  setModel: mock(() => Promise.resolve(undefined)),
};

const mockRegistry = {
  getChat: mock(() => null),
  updateChat: mock(() => Promise.resolve(undefined)),
};

const mockQueue = {
  submit: mock(() => Promise.resolve()),
  abort: mock(() => Promise.resolve(true)),
  triggerDrain: mock(() => Promise.resolve()),
  readChatQueue: mock(() => Promise.resolve({ entries: [], paused: false })),
  enqueueChat: mock(() => Promise.resolve({ entry: { id: 'q1' }, queue: { entries: [], paused: false } })),
  dequeueChat: mock(() => Promise.resolve({ entries: [], paused: false })),
  clearChatQueue: mock(() => Promise.resolve({ entries: [], paused: false })),
  pauseChatQueue: mock(() => Promise.resolve({ entries: [], paused: true })),
  resumeChatQueue: mock(() => Promise.resolve({ entries: [], paused: false })),
};

const mockHistoryCache = {
  appendMessages: mock(() => Promise.resolve(undefined)),
  ensureLoaded: mock(() => Promise.resolve([])),
  getPaginatedMessages: mock((chatId, limit, offset) => ({
    messages: [{ type: 'user-message', content: 'hello', timestamp: '2024-01-01T00:00:00Z' }],
    total: 1,
    hasMore: false,
    offset: offset || 0,
    limit: limit || 20,
  })),
};

const injectedMocks = [
  mockProviders.getRunningSessions, mockProviders.resolvePermission,
  mockProviders.setPermissionMode, mockProviders.setModel,
  mockRegistry.getChat, mockRegistry.updateChat,
  mockQueue.submit, mockQueue.abort, mockQueue.triggerDrain,
  mockQueue.readChatQueue, mockQueue.enqueueChat, mockQueue.dequeueChat,
  mockQueue.clearChatQueue, mockQueue.pauseChatQueue, mockQueue.resumeChatQueue,
  mockHistoryCache.appendMessages, mockHistoryCache.ensureLoaded,
  mockHistoryCache.getPaginatedMessages,
];

const moduleMocks = [sendWebSocketJson];

const chatHandlerInstance = new ChatHandler(
  mockProviders, mockQueue, mockHistoryCache, mockRegistry,
);
const chatHandler = chatHandlerInstance.createHandler();

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

describe('chat WebSocket handler', () => {
  let ws;

  beforeEach(() => {
    injectedMocks.forEach(m => m.mockClear());
    moduleMocks.forEach(m => m.mockClear());
    ws = createMockWs();
  });

  describe('open', () => {
    it('subscribes the client to the chat topic', () => {
      chatHandler.open(ws);
      expect(ws.subscribe).toHaveBeenCalledWith('chat');
    });
  });

  describe('agent-run', () => {
    it('delegates to queue.submit with the chat ID', async () => {
      await chatHandler.message(ws, {
        type: 'agent-run',
        chatId: '123',
        provider: 'claude',
        command: 'hello',
        options: { projectPath: '/tmp' },
      });
      expect(mockQueue.submit).toHaveBeenCalledWith('123', 'hello', { projectPath: '/tmp' });
    });

    it('sends error for missing chatId', async () => {
      await chatHandler.message(ws, {
        type: 'agent-run',
        provider: 'claude',
        command: 'hello',
      });
      const payload = lastSentPayload();
      expect(payload).toMatchObject({ type: 'ws-fault' });
      expect(payload.error).toContain('Missing chatId');
    });

    it('sends agent-run-failed for invalid session ID format', async () => {
      await chatHandler.message(ws, {
        type: 'agent-run',
        chatId: 'not-numeric',
        provider: 'claude',
        command: 'hello',
      });
      const payload = lastSentPayload();
      expect(payload).toMatchObject({
        type: 'agent-run-failed',
        chatId: 'not-numeric',
      });
      expect(payload.error).toBeDefined();
    });

    it('sends agent-run-failed when queue.submit throws', async () => {
      mockQueue.submit.mockRejectedValueOnce(new Error('provider timeout'));
      await chatHandler.message(ws, {
        type: 'agent-run',
        chatId: '123',
        provider: 'claude',
        command: 'hello',
      });
      const payload = lastSentPayload();
      expect(payload).toMatchObject({
        type: 'agent-run-failed',
        chatId: '123',
      });
      expect(payload.error).toBe('provider timeout');
    });
  });

  describe('agent-stop', () => {
    it('delegates to queue.abort', async () => {
      await chatHandler.message(ws, {
        type: 'agent-stop',
        chatId: '123',
        provider: 'claude',
      });
      expect(mockQueue.abort).toHaveBeenCalledWith('123');
    });
  });

  describe('permission-decision', () => {
    it('forwards decision to resolvePermission', async () => {
      await chatHandler.message(ws, {
        type: 'permission-decision',
        chatId: '123',
        permissionRequestId: 'claude-abc123',
        allow: true,
        alwaysAllow: false,
      });
      expect(mockProviders.resolvePermission).toHaveBeenCalledWith('123', 'claude-abc123', expect.objectContaining({
        allow: true,
        alwaysAllow: false,
      }));
    });

    it('forwards alwaysAllow=true through decision object', async () => {
      await chatHandler.message(ws, {
        type: 'permission-decision',
        chatId: '456',
        permissionRequestId: 'opencode-xyz789',
        allow: true,
        alwaysAllow: true,
      });
      expect(mockProviders.resolvePermission).toHaveBeenCalledWith('456', 'opencode-xyz789', {
        allow: true,
        alwaysAllow: true,
      });
    });

    it('forwards reject decision with alwaysAllow=false', async () => {
      await chatHandler.message(ws, {
        type: 'permission-decision',
        chatId: '789',
        permissionRequestId: 'opencode-reject-1',
        allow: false,
        alwaysAllow: false,
      });
      expect(mockProviders.resolvePermission).toHaveBeenCalledWith('789', 'opencode-reject-1', {
        allow: false,
        alwaysAllow: false,
      });
    });
  });

  describe('permission-decision deduplication', () => {
    it('drops duplicate permission-decision with same ID', async () => {
      const msg = {
        type: 'permission-decision',
        chatId: '123',
        permissionRequestId: 'dedup-test-1',
        allow: true,
        alwaysAllow: false,
      };
      await chatHandler.message(ws, msg);
      expect(mockProviders.resolvePermission).toHaveBeenCalledTimes(1);

      mockProviders.resolvePermission.mockClear();
      await chatHandler.message(ws, msg);
      expect(mockProviders.resolvePermission).not.toHaveBeenCalled();
    });

    it('forwards different permissionRequestIds independently', async () => {
      await chatHandler.message(ws, {
        type: 'permission-decision',
        chatId: '123',
        permissionRequestId: 'dedup-test-2a',
        allow: true,
        alwaysAllow: false,
      });
      await chatHandler.message(ws, {
        type: 'permission-decision',
        chatId: '123',
        permissionRequestId: 'dedup-test-2b',
        allow: false,
        alwaysAllow: false,
      });
      expect(mockProviders.resolvePermission).toHaveBeenCalledTimes(2);
    });

    it('is a no-op when permissionRequestId is missing', async () => {
      mockProviders.resolvePermission.mockClear();
      await chatHandler.message(ws, {
        type: 'permission-decision',
        chatId: '123',
        allow: true,
      });
      expect(mockProviders.resolvePermission).not.toHaveBeenCalled();
    });

    it('is a no-op when chatId is missing', async () => {
      mockProviders.resolvePermission.mockClear();
      await chatHandler.message(ws, {
        type: 'permission-decision',
        permissionRequestId: 'dedup-test-3',
        allow: true,
      });
      expect(mockProviders.resolvePermission).not.toHaveBeenCalled();
    });
  });

  describe('permission-mode-set', () => {
    it('calls setPermissionMode and persists to registry', async () => {
      await chatHandler.message(ws, {
        type: 'permission-mode-set',
        chatId: '123',
        mode: 'bypassPermissions',
      });
      expect(mockRegistry.updateChat).toHaveBeenCalledWith('123', { permissionMode: 'bypassPermissions' });
      expect(mockProviders.setPermissionMode).toHaveBeenCalledWith('123', 'bypassPermissions');
    });

    it('ignores non-string mode values', async () => {
      await chatHandler.message(ws, {
        type: 'permission-mode-set',
        chatId: '123',
        mode: 42,
      });
      expect(mockRegistry.updateChat).not.toHaveBeenCalled();
      expect(mockProviders.setPermissionMode).not.toHaveBeenCalled();
    });
  });

  describe('thinking-mode-set', () => {
    it('persists thinking mode to registry', async () => {
      await chatHandler.message(ws, {
        type: 'thinking-mode-set',
        chatId: '123',
        mode: 'think-hard',
      });
      expect(mockRegistry.updateChat).toHaveBeenCalledWith('123', { thinkingMode: 'think-hard' });
    });

    it('sends error for missing chatId', async () => {
      await chatHandler.message(ws, {
        type: 'thinking-mode-set',
        mode: 'think',
      });
      const payload = lastSentPayload();
      expect(payload).toMatchObject({ type: 'ws-fault' });
      expect(payload.error).toContain('Missing chatId');
    });

    it('ignores non-string mode values', async () => {
      await chatHandler.message(ws, {
        type: 'thinking-mode-set',
        chatId: '123',
      });
      expect(mockRegistry.updateChat).not.toHaveBeenCalled();
    });
  });

  describe('model-set', () => {
    it('updates chat and calls setModel', async () => {
      await chatHandler.message(ws, {
        type: 'model-set',
        chatId: '123',
        model: 'opus',
      });
      expect(mockRegistry.updateChat).toHaveBeenCalledWith('123', { model: 'opus' });
      expect(mockProviders.setModel).toHaveBeenCalledWith('123', 'opus');
    });
  });

  describe('chats-running-query', () => {
    it('responds with chat-sessions-running shape', async () => {
      await chatHandler.message(ws, {
        type: 'chats-running-query',
      });
      const payload = lastSentPayload();
      expect(payload).toMatchObject({
        type: 'chat-sessions-running',
      });
      expect(payload.sessions).toEqual({ claude: [], codex: [], opencode: [] });
    });
  });

  describe('chat-log-query', () => {
    it('returns client-request-error for unknown chatId', async () => {
      mockRegistry.getChat.mockReturnValue(null);
      await chatHandler.message(ws, {
        type: 'chat-log-query',
        chatId: '999',
        clientRequestId: 'req-msg-1',
      });
      const payload = lastSentPayload();
      expect(payload).toMatchObject({
        type: 'client-request-error',
        clientRequestId: 'req-msg-1',
        chatId: '999',
        code: 'SESSION_NOT_FOUND',
      });
    });

    it('returns messages for a valid chat', async () => {
      mockRegistry.getChat.mockReturnValue({
        provider: 'claude',
        nativePath: '/tmp/session.jsonl',
        providerSessionId: 'abc',
      });
      await chatHandler.message(ws, {
        type: 'chat-log-query',
        chatId: '123',
        clientRequestId: 'req-msg-2',
      });
      expect(mockHistoryCache.ensureLoaded).toHaveBeenCalledWith('123');
      expect(mockHistoryCache.getPaginatedMessages).toHaveBeenCalledWith('123', 20, 0);
      const payload = lastSentPayload();
      expect(payload).toMatchObject({
        type: 'chat-log-response',
        clientRequestId: 'req-msg-2',
        chatId: '123',
      });
      expect(payload.messages.length).toBe(1);
    });

    it('sends error for missing chatId', async () => {
      await chatHandler.message(ws, {
        type: 'chat-log-query',
        clientRequestId: 'req-msg-3',
      });
      const payload = lastSentPayload();
      expect(payload).toMatchObject({ type: 'ws-fault' });
      expect(payload.error).toContain('Missing chatId');
    });

    it('respects limit and offset params', async () => {
      mockRegistry.getChat.mockReturnValue({
        provider: 'claude',
        nativePath: '/tmp/session.jsonl',
        providerSessionId: 'abc',
      });
      await chatHandler.message(ws, {
        type: 'chat-log-query',
        chatId: '123',
        clientRequestId: 'req-msg-4',
        limit: 50,
        offset: 10,
      });
      expect(mockHistoryCache.getPaginatedMessages).toHaveBeenCalledWith('123', 50, 10);
    });

    it('includes clientRequestId in response', async () => {
      mockRegistry.getChat.mockReturnValue({
        provider: 'claude',
        nativePath: '/tmp/test.jsonl',
        providerSessionId: 'x',
      });
      await chatHandler.message(ws, {
        type: 'chat-log-query',
        chatId: '123',
        clientRequestId: 'unique-req-id',
      });
      const payload = lastSentPayload();
      expect(payload.clientRequestId).toBe('unique-req-id');
    });

    it('silently ignores requests without clientRequestId', async () => {
      mockRegistry.getChat.mockReturnValue({
        provider: 'claude',
        nativePath: '/tmp/test.jsonl',
        providerSessionId: 'x',
      });
      sendWebSocketJson.mockClear();
      await chatHandler.message(ws, {
        type: 'chat-log-query',
        chatId: '123',
      });
      // No response sent because clientRequestId is missing
      expect(sendWebSocketJson).not.toHaveBeenCalled();
    });
  });

  describe('queue-enqueue', () => {
    it('calls enqueueChat', async () => {
      await chatHandler.message(ws, {
        type: 'queue-enqueue',
        chatId: '123',
        content: 'queued text',
      });
      expect(mockQueue.enqueueChat).toHaveBeenCalledWith('123', 'queued text');
    });

    it('rejects empty content', async () => {
      await chatHandler.message(ws, {
        type: 'queue-enqueue',
        chatId: '123',
        content: '',
      });
      expect(mockQueue.enqueueChat).not.toHaveBeenCalled();
      const payload = lastSentPayload();
      expect(payload).toMatchObject({ type: 'ws-fault' });
    });
  });

  describe('dequeue-enqueue', () => {
    it('calls dequeueChat with chatId and entryId', async () => {
      await chatHandler.message(ws, {
        type: 'dequeue-enqueue',
        chatId: '123',
        entryId: 'q1',
      });
      expect(mockQueue.dequeueChat).toHaveBeenCalledWith('123', 'q1');
    });

    it('sends ws-fault when entryId is missing', async () => {
      await chatHandler.message(ws, {
        type: 'dequeue-enqueue',
        chatId: '123',
      });
      expect(mockQueue.dequeueChat).not.toHaveBeenCalled();
      const payload = lastSentPayload();
      expect(payload).toMatchObject({ type: 'ws-fault' });
      expect(payload.error).toContain('entryId');
    });
  });

  describe('queue-clear', () => {
    it('calls clearChatQueue', async () => {
      await chatHandler.message(ws, {
        type: 'queue-clear',
        chatId: '123',
      });
      expect(mockQueue.clearChatQueue).toHaveBeenCalledWith('123');
    });
  });

  describe('queue-pause', () => {
    it('calls pauseChatQueue', async () => {
      await chatHandler.message(ws, {
        type: 'queue-pause',
        chatId: '123',
      });
      expect(mockQueue.pauseChatQueue).toHaveBeenCalledWith('123');
    });
  });

  describe('queue-resume', () => {
    it('calls resumeChatQueue and triggerDrain', async () => {
      await chatHandler.message(ws, {
        type: 'queue-resume',
        chatId: '123',
      });
      expect(mockQueue.resumeChatQueue).toHaveBeenCalledWith('123');
      expect(mockQueue.triggerDrain).toHaveBeenCalledWith('123', expect.any(Object));
    });
  });

  describe('queue-query', () => {
    it('responds with queue-state-updated shape', async () => {
      await chatHandler.message(ws, {
        type: 'queue-query',
        chatId: '123',
      });
      expect(mockQueue.readChatQueue).toHaveBeenCalledWith('123');
      const payload = lastSentPayload();
      expect(payload).toMatchObject({
        type: 'queue-state-updated',
        chatId: '123',
      });
      expect(payload.queue).toBeDefined();
    });
  });
});
