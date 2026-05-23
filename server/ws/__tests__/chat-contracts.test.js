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

const mockAgents = {
  getRunningSessions: mock(() => ({ claude: [], codex: [], opencode: [], amp: [], factory: [], 'direct-anthropic-compatible': [], 'direct-openai-compatible': [], 'direct-openai-responses-compatible': [] })),
  resolvePermission: mock(() => undefined),
  setPermissionMode: mock(() => Promise.resolve(undefined)),
  setThinkingMode: mock(() => Promise.resolve(undefined)),
  setClaudeThinkingMode: mock(() => Promise.resolve(undefined)),
  setAmpAgentMode: mock(() => Promise.resolve(undefined)),
  setModel: mock(() => Promise.resolve(undefined)),
  supportsFork: mock(() => true),
  isAgentSessionRunning: mock(() => false),
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

const mockPendingInputs = {
  reconcile: mock(() => Promise.resolve(undefined)),
  listForChat: mock(() => []),
};

const mockForkDeps = {
  settings: {},
  metadata: {},
  forkChatFileCopy: mock(() => Promise.resolve({
    sourceChatId: '123',
    chatId: '456',
    agentId: 'claude',
  })),
};

const injectedMocks = [
  mockAgents.getRunningSessions, mockAgents.resolvePermission,
  mockAgents.setPermissionMode, mockAgents.setThinkingMode,
  mockAgents.setClaudeThinkingMode, mockAgents.setModel,
  mockAgents.supportsFork,
  mockAgents.isAgentSessionRunning,
  mockRegistry.getChat, mockRegistry.updateChat,
  mockQueue.submit, mockQueue.abort, mockQueue.triggerDrain,
  mockQueue.readChatQueue, mockQueue.enqueueChat, mockQueue.dequeueChat,
  mockQueue.clearChatQueue, mockQueue.pauseChatQueue, mockQueue.resumeChatQueue,
  mockHistoryCache.appendMessages, mockHistoryCache.ensureLoaded,
  mockHistoryCache.getPaginatedMessages,
  mockPendingInputs.reconcile, mockPendingInputs.listForChat,
  mockForkDeps.forkChatFileCopy,
];

const moduleMocks = [sendWebSocketJson];

const chatHandlerInstance = new ChatHandler(
  mockAgents, mockQueue, mockHistoryCache, mockRegistry, mockPendingInputs, mockForkDeps,
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
    mockAgents.isAgentSessionRunning.mockImplementation(() => false);
    mockAgents.supportsFork.mockImplementation(() => true);
    mockForkDeps.forkChatFileCopy.mockImplementation(() => Promise.resolve({
      sourceChatId: '123',
      chatId: '456',
      agentId: 'claude',
    }));
    mockPendingInputs.listForChat.mockReturnValue([]);
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
        command: 'hello',
        permissionMode: 'default',
        thinkingMode: 'none',
        model: 'opus',
      });
      expect(mockQueue.submit).toHaveBeenCalledWith('123', 'hello', {
        permissionMode: 'default',
        thinkingMode: 'none',
        claudeThinkingMode: undefined,
        model: 'opus',
      });
    });

    it('rejects agent-run payloads with missing chatId', async () => {
      await chatHandler.message(ws, {
        type: 'agent-run',
        command: 'hello',
        permissionMode: 'default',
        thinkingMode: 'none',
        model: 'opus',
      });
      const payload = lastSentPayload();
      expect(payload).toMatchObject({ type: 'ws-fault' });
      expect(payload.error).toContain('chatId');
    });

    it('sends agent-run-failed for invalid session ID format', async () => {
      await chatHandler.message(ws, {
        type: 'agent-run',
        chatId: 'not-numeric',
        command: 'hello',
        permissionMode: 'default',
        thinkingMode: 'none',
        model: 'opus',
      });
      const payload = lastSentPayload();
      expect(payload).toMatchObject({
        type: 'agent-run-failed',
        chatId: 'not-numeric',
      });
      expect(payload.error).toBeDefined();
    });

    it('sends agent-run-failed when queue.submit throws', async () => {
      mockQueue.submit.mockRejectedValueOnce(new Error('agent timeout'));
      await chatHandler.message(ws, {
        type: 'agent-run',
        chatId: '123',
        command: 'hello',
        permissionMode: 'default',
        thinkingMode: 'none',
        model: 'opus',
      });
      const payload = lastSentPayload();
      expect(payload).toMatchObject({
        type: 'agent-run-failed',
        chatId: '123',
      });
      expect(payload.error).toBe('agent timeout');
    });

    it('rejects malformed agent-run payloads before queue submission', async () => {
      await chatHandler.message(ws, {
        type: 'agent-run',
        chatId: '123',
        command: 'hello',
        permissionMode: '',
        thinkingMode: 'none',
        model: 'opus',
      });
      const payload = lastSentPayload();
      expect(mockQueue.submit).not.toHaveBeenCalled();
      expect(payload).toMatchObject({ type: 'ws-fault' });
      expect(payload.error).toContain('permissionMode');
    });

    it('accepts image-only agent-run payloads', async () => {
      await chatHandler.message(ws, {
        type: 'agent-run',
        chatId: '123',
        command: '',
        permissionMode: 'default',
        thinkingMode: 'none',
        model: 'opus',
        images: [{ data: 'data:image/png;base64,abc', name: 'a.png' }],
      });
      expect(mockQueue.submit).toHaveBeenCalledWith('123', '', {
        images: [{ data: 'data:image/png;base64,abc', name: 'a.png' }],
        permissionMode: 'default',
        thinkingMode: 'none',
        claudeThinkingMode: undefined,
        model: 'opus',
      });
    });

    it('rejects agent-run payloads with neither command nor images', async () => {
      await chatHandler.message(ws, {
        type: 'agent-run',
        chatId: '123',
        command: '   ',
        permissionMode: 'default',
        thinkingMode: 'none',
        model: 'opus',
        images: [],
      });
      const payload = lastSentPayload();
      expect(mockQueue.submit).not.toHaveBeenCalled();
      expect(payload).toMatchObject({ type: 'ws-fault' });
      expect(payload.error).toContain('command or images required');
    });
  });

  describe('fork-run', () => {
    it('forks the source chat, notifies the client, and submits the fork turn', async () => {
      const sourceSession = {
        agentId: 'claude',
        agentSessionId: 'source-session',
        projectPath: '/repo',
        model: 'opus',
      };
      mockRegistry.getChat.mockImplementation((chatId) => {
        if (chatId === '123') return sourceSession;
        return null;
      });

      await chatHandler.message(ws, {
        type: 'fork-run',
        sourceChatId: '123',
        chatId: '456',
        command: 'continue in fork',
        permissionMode: 'default',
        thinkingMode: 'none',
        model: 'opus',
      });

      expect(mockForkDeps.forkChatFileCopy).toHaveBeenCalledWith({
        sourceSession,
        sourceChatId: '123',
        targetChatId: '456',
        registry: mockRegistry,
        settings: mockForkDeps.settings,
        metadata: mockForkDeps.metadata,
        forkAgentSession: undefined,
      });
      expect(sendWebSocketJson.mock.calls[0][1]).toMatchObject({
        type: 'chat-fork-created',
        sourceChatId: '123',
        chatId: '456',
      });
      expect(mockQueue.submit).toHaveBeenCalledWith('456', 'continue in fork', {
        permissionMode: 'default',
        thinkingMode: 'none',
        model: 'opus',
      });
    });

    it('rejects unsupported source agents', async () => {
      mockAgents.supportsFork.mockImplementation(() => false);
      mockRegistry.getChat.mockImplementation((chatId) => {
        if (chatId === '123') return { agentId: 'opencode', agentSessionId: 'source-session' };
        return null;
      });

      await chatHandler.message(ws, {
        type: 'fork-run',
        sourceChatId: '123',
        chatId: '456',
        command: 'continue in fork',
      });

      expect(mockForkDeps.forkChatFileCopy).not.toHaveBeenCalled();
      expect(mockQueue.submit).not.toHaveBeenCalled();
      const payload = lastSentPayload();
      expect(payload).toMatchObject({
        type: 'agent-run-failed',
        chatId: '123',
      });
      expect(payload.error).toContain('unsupported');
    });

    it('rejects a source chat that is currently processing', async () => {
      mockRegistry.getChat.mockImplementation((chatId) => {
        if (chatId === '123') return { agentId: 'claude', agentSessionId: 'source-session' };
        return null;
      });
      mockAgents.isAgentSessionRunning.mockImplementation(() => true);

      await chatHandler.message(ws, {
        type: 'fork-run',
        sourceChatId: '123',
        chatId: '456',
        command: 'continue in fork',
      });

      expect(mockForkDeps.forkChatFileCopy).not.toHaveBeenCalled();
      expect(mockQueue.submit).not.toHaveBeenCalled();
      const payload = lastSentPayload();
      expect(payload).toMatchObject({
        type: 'agent-run-failed',
        chatId: '123',
      });
      expect(payload.error).toContain('processing');
    });

    it('reports target turn failures against the forked chat after creation', async () => {
      let targetCreated = false;
      mockRegistry.getChat.mockImplementation((chatId) => {
        if (chatId === '123') return { agentId: 'claude', agentSessionId: 'source-session' };
        if (chatId === '456' && targetCreated) return { agentId: 'claude', agentSessionId: 'fork-session' };
        return null;
      });
      mockForkDeps.forkChatFileCopy.mockImplementationOnce(async () => {
        targetCreated = true;
        return {
          sourceChatId: '123',
          chatId: '456',
          agentId: 'claude',
        };
      });
      mockQueue.submit.mockRejectedValueOnce(new Error('fork turn failed'));

      await chatHandler.message(ws, {
        type: 'fork-run',
        sourceChatId: '123',
        chatId: '456',
        command: 'continue in fork',
      });

      const payload = lastSentPayload();
      expect(payload).toMatchObject({
        type: 'agent-run-failed',
        chatId: '456',
        error: 'fork turn failed',
      });
    });
  });

  describe('agent-stop', () => {
    it('delegates to queue.abort', async () => {
      await chatHandler.message(ws, {
        type: 'agent-stop',
        chatId: '123',
        agentId: 'claude',
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
      expect(mockAgents.resolvePermission).toHaveBeenCalledWith('123', 'claude-abc123', expect.objectContaining({
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
      expect(mockAgents.resolvePermission).toHaveBeenCalledWith('456', 'opencode-xyz789', {
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
      expect(mockAgents.resolvePermission).toHaveBeenCalledWith('789', 'opencode-reject-1', {
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
      expect(mockAgents.resolvePermission).toHaveBeenCalledTimes(1);

      mockAgents.resolvePermission.mockClear();
      await chatHandler.message(ws, msg);
      expect(mockAgents.resolvePermission).not.toHaveBeenCalled();
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
      expect(mockAgents.resolvePermission).toHaveBeenCalledTimes(2);
    });

    it('is a no-op when permissionRequestId is missing', async () => {
      mockAgents.resolvePermission.mockClear();
      await chatHandler.message(ws, {
        type: 'permission-decision',
        chatId: '123',
        allow: true,
      });
      expect(mockAgents.resolvePermission).not.toHaveBeenCalled();
    });

    it('is a no-op when chatId is missing', async () => {
      mockAgents.resolvePermission.mockClear();
      await chatHandler.message(ws, {
        type: 'permission-decision',
        permissionRequestId: 'dedup-test-3',
        allow: true,
      });
      expect(mockAgents.resolvePermission).not.toHaveBeenCalled();
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
      expect(mockAgents.setPermissionMode).toHaveBeenCalledWith('123', 'bypassPermissions');
    });

    it('ignores non-string mode values', async () => {
      await chatHandler.message(ws, {
        type: 'permission-mode-set',
        chatId: '123',
        mode: 42,
      });
      expect(mockRegistry.updateChat).not.toHaveBeenCalled();
      expect(mockAgents.setPermissionMode).not.toHaveBeenCalled();
    });
  });

  describe('thinking-mode-set', () => {
    it('persists thinking mode to registry and agent session', async () => {
      await chatHandler.message(ws, {
        type: 'thinking-mode-set',
        chatId: '123',
        mode: 'think-hard',
      });
      expect(mockRegistry.updateChat).toHaveBeenCalledWith('123', { thinkingMode: 'think-hard' });
      expect(mockAgents.setThinkingMode).toHaveBeenCalledWith('123', 'think-hard');
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
      expect(mockAgents.setThinkingMode).not.toHaveBeenCalled();
    });
  });

  describe('claude-thinking-mode-set', () => {
	it('persists Claude thinking mode to registry and agent session', async () => {
	  await chatHandler.message(ws, {
	    type: 'claude-thinking-mode-set',
	    chatId: '123',
	    mode: 'off',
	  });
	  expect(mockRegistry.updateChat).toHaveBeenCalledWith('123', { claudeThinkingMode: 'off' });
	  expect(mockAgents.setClaudeThinkingMode).toHaveBeenCalledWith('123', 'off');
	});

	it('sends error for missing chatId', async () => {
	  await chatHandler.message(ws, {
	    type: 'claude-thinking-mode-set',
	    mode: 'auto',
	  });
	  const payload = lastSentPayload();
	  expect(payload).toMatchObject({ type: 'ws-fault' });
	  expect(payload.error).toContain('Missing chatId');
	});
  });

  describe('model-set', () => {
    it('updates only the model when API provider metadata is omitted', async () => {
      await chatHandler.message(ws, {
        type: 'model-set',
        chatId: '123',
        model: 'opus',
      });
      expect(mockRegistry.updateChat).toHaveBeenCalledWith('123', { model: 'opus' });
      expect(mockAgents.setModel).toHaveBeenCalledWith('123', 'opus', undefined);
    });

    it('updates API provider metadata when provided', async () => {
      await chatHandler.message(ws, {
        type: 'model-set',
        chatId: '123',
        model: 'zai_openai:glm-5.1',
        apiProviderId: 'zai',
        modelEndpointId: 'zai_openai',
        modelProtocol: 'openai-compatible',
      });
      expect(mockRegistry.updateChat).toHaveBeenCalledWith('123', {
        model: 'zai_openai:glm-5.1',
        apiProviderId: 'zai',
        modelEndpointId: 'zai_openai',
        modelProtocol: 'openai-compatible',
      });
      expect(mockAgents.setModel).toHaveBeenCalledWith('123', 'zai_openai:glm-5.1', {
        apiProviderId: 'zai',
        modelEndpointId: 'zai_openai',
      });
    });

    it('clears API provider metadata when explicit nulls are provided', async () => {
      await chatHandler.message(ws, {
        type: 'model-set',
        chatId: '123',
        model: 'opus',
        apiProviderId: null,
        modelEndpointId: null,
        modelProtocol: null,
      });
      expect(mockRegistry.updateChat).toHaveBeenCalledWith('123', {
        model: 'opus',
        apiProviderId: null,
        modelEndpointId: null,
        modelProtocol: null,
      });
      expect(mockAgents.setModel).toHaveBeenCalledWith('123', 'opus', {
        apiProviderId: null,
        modelEndpointId: null,
      });
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
      expect(payload.sessions).toEqual({ claude: [], codex: [], opencode: [], amp: [], factory: [], 'direct-anthropic-compatible': [], 'direct-openai-compatible': [], 'direct-openai-responses-compatible': [] });
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
        agentId: 'claude',
        nativePath: '/tmp/session.jsonl',
        agentSessionId: 'abc',
      });
      await chatHandler.message(ws, {
        type: 'chat-log-query',
        chatId: '123',
        clientRequestId: 'req-msg-2',
      });
      expect(mockHistoryCache.ensureLoaded).toHaveBeenCalledWith('123');
      expect(mockPendingInputs.reconcile).toHaveBeenCalledWith('123');
      expect(mockHistoryCache.getPaginatedMessages).toHaveBeenCalledWith('123', 20, 0);
      const payload = lastSentPayload();
      expect(payload).toMatchObject({
        type: 'chat-log-response',
        clientRequestId: 'req-msg-2',
        chatId: '123',
        pendingUserInputs: [],
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
        agentId: 'claude',
        nativePath: '/tmp/session.jsonl',
        agentSessionId: 'abc',
      });
      await chatHandler.message(ws, {
        type: 'chat-log-query',
        chatId: '123',
        clientRequestId: 'req-msg-4',
        limit: 50,
        offset: 10,
      });
      expect(mockPendingInputs.reconcile).toHaveBeenCalledWith('123');
      expect(mockHistoryCache.getPaginatedMessages).toHaveBeenCalledWith('123', 50, 10);
    });

    it('includes clientRequestId in response', async () => {
      mockRegistry.getChat.mockReturnValue({
        agentId: 'claude',
        nativePath: '/tmp/test.jsonl',
        agentSessionId: 'x',
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
        agentId: 'claude',
        nativePath: '/tmp/test.jsonl',
        agentSessionId: 'x',
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
    it('calls enqueueChat and drains with persisted chat settings', async () => {
      mockRegistry.getChat.mockReturnValue({
        projectPath: '/repo',
        permissionMode: 'default',
        thinkingMode: 'none',
        model: 'opus',
      });
      await chatHandler.message(ws, {
        type: 'queue-enqueue',
        chatId: '123',
        content: 'queued text',
      });
      expect(mockQueue.enqueueChat).toHaveBeenCalledWith('123', 'queued text');
      expect(mockQueue.triggerDrain).toHaveBeenCalledWith('123', {
        permissionMode: 'default',
        thinkingMode: 'none',
        claudeThinkingMode: 'auto',
        ampAgentMode: 'smart',
        model: 'opus',
      });
    });

    it('normalizes invalid persisted drain settings before triggering the next turn', async () => {
      mockRegistry.getChat.mockReturnValue({
        projectPath: '/repo',
        permissionMode: 'bogus',
        thinkingMode: 'very-hard',
        claudeThinkingMode: 'sometimes',
        model: 'opus',
      });

      await chatHandler.message(ws, {
        type: 'queue-enqueue',
        chatId: '123',
        content: 'queued text',
      });

      expect(mockQueue.triggerDrain).toHaveBeenCalledWith('123', {
        permissionMode: 'default',
        thinkingMode: 'none',
        claudeThinkingMode: 'auto',
        ampAgentMode: 'smart',
        model: 'opus',
      });
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

    it('fails fast when persisted drain settings are missing', async () => {
      mockRegistry.getChat.mockReturnValue({
        projectPath: '/repo',
        permissionMode: 'default',
        thinkingMode: 'none',
      });
      await chatHandler.message(ws, {
        type: 'queue-enqueue',
        chatId: '123',
        content: 'queued text',
      });
      const payload = lastSentPayload();
      expect(mockQueue.triggerDrain).not.toHaveBeenCalled();
      expect(payload).toMatchObject({ type: 'ws-fault' });
      expect(payload.error).toContain('missing model');
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
    it('calls resumeChatQueue and triggerDrain with persisted chat settings', async () => {
      mockRegistry.getChat.mockReturnValue({
        projectPath: '/repo',
        permissionMode: 'default',
        thinkingMode: 'none',
        model: 'opus',
      });
      await chatHandler.message(ws, {
        type: 'queue-resume',
        chatId: '123',
      });
      expect(mockQueue.resumeChatQueue).toHaveBeenCalledWith('123');
      expect(mockQueue.triggerDrain).toHaveBeenCalledWith('123', {
        permissionMode: 'default',
        thinkingMode: 'none',
        claudeThinkingMode: 'auto',
        ampAgentMode: 'smart',
        model: 'opus',
      });
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
