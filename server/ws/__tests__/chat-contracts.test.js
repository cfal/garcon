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
import { ChatCommandService } from '../../commands/chat-command-service.js';

const mockAgents = {
  getRunningSessions: mock(() => ({ claude: [], codex: [], opencode: [], amp: [], factory: [], 'direct-anthropic-compatible': [], 'direct-openai-compatible': [], 'direct-openai-responses-compatible': [] })),
  resolvePermission: mock(() => undefined),
  updateSessionSettings: mock(() => Promise.resolve(undefined)),
  hasAgent: mock(() => true),
  supportsImages: mock(() => true),
  modelSupportsImages: mock(() => Promise.resolve(true)),
  startSession: mock(() => Promise.resolve(undefined)),
  supportsFork: mock(() => true),
  isAgentSessionRunning: mock(() => false),
  getAgentAuthStatusMap: mock(() => ({})),
  getAgentReadinessMap: mock(() => ({})),
  getAgentCatalogEntries: mock(() => []),
  runSingleQuery: mock(() => Promise.resolve('')),
};

const mockRegistry = {
  getChat: mock(() => null),
  addChat: mock(() => true),
  removeChat: mock(() => true),
  updateChat: mock(() => Promise.resolve(undefined)),
};

const mockQueue = {
  submit: mock(() => Promise.resolve()),
  registerPendingUserInput: mock(() => Promise.resolve()),
  discardPendingUserInput: mock(() => true),
  runAcceptedTurn: mock(() => Promise.resolve()),
  abort: mock(() => Promise.resolve(true)),
  triggerDrain: mock(() => Promise.resolve()),
  readChatQueue: mock(() => Promise.resolve({ entries: [], paused: false })),
  enqueueChat: mock(() => Promise.resolve({ entry: { id: 'q1' }, queue: { entries: [], paused: false } })),
  dequeueChat: mock(() => Promise.resolve({ entries: [], paused: false })),
  clearChatQueue: mock(() => Promise.resolve({ entries: [], paused: false })),
  pauseChatQueue: mock(() => Promise.resolve({ entries: [], paused: true })),
  resumeChatQueue: mock(() => Promise.resolve({ entries: [], paused: false })),
};

const chatEvent = {
  appendSeq: 1,
  seq: 1,
  messageId: 'message-1',
  rev: 1,
  message: { type: 'user-message', content: 'hello', timestamp: '2024-01-01T00:00:00Z' },
};

const mockChatEvents = {
  readPage: mock((_chatId, limit, beforeSeq) => Promise.resolve({
    events: [chatEvent],
    logId: 'log-1',
    lastAppendSeq: 1,
    pageOldestSeq: beforeSeq ?? 1,
    hasMore: false,
    limit: limit || 20,
  })),
  readReplay: mock((_chatId, _logId, _afterAppendSeq) => Promise.resolve({
    logId: 'log-1',
    mode: 'delta',
    events: [chatEvent],
    lastAppendSeq: 1,
  })),
};

const mockNativeReloader = {
  ensureColdLoaded: mock(() => Promise.resolve(undefined)),
  reloadFromNative: mock(() => Promise.resolve({
    logId: 'log-2',
    events: [chatEvent],
    lastAppendSeq: 1,
  })),
};

const mockPendingInputs = {
  register: mock(() => Promise.resolve(undefined)),
  reconcile: mock(() => Promise.resolve(undefined)),
  listForChat: mock(() => []),
  clearChat: mock(() => undefined),
};

const mockSettings = {
  getUiSettings: mock(() => null),
  getChatName: mock(() => null),
  setSessionName: mock(() => Promise.resolve(undefined)),
  setLastChatDefaults: mock(() => Promise.resolve(undefined)),
  ensureInNormal: mock(() => Promise.resolve(undefined)),
  removeFromAllOrderLists: mock(() => Promise.resolve(undefined)),
};

const mockMetadata = {
  addNewChatMetadata: mock(() => undefined),
  getChatMetadata: mock(() => null),
};

const mockCommandLedger = {
  accept: mock(() => { throw new Error('Unexpected command ledger use'); }),
  update: mock(() => { throw new Error('Unexpected command ledger use'); }),
  updateUnlessStatus: mock(() => { throw new Error('Unexpected command ledger use'); }),
};

const mockForkChatFileCopy = mock(() => Promise.resolve({
    sourceChatId: '123',
    chatId: '456',
    agentId: 'claude',
}));

const injectedMocks = [
  mockAgents.getRunningSessions, mockAgents.resolvePermission,
  mockAgents.updateSessionSettings,
  mockAgents.hasAgent, mockAgents.supportsImages, mockAgents.modelSupportsImages,
  mockAgents.startSession,
  mockAgents.supportsFork,
  mockAgents.isAgentSessionRunning,
  mockAgents.getAgentAuthStatusMap, mockAgents.getAgentReadinessMap,
  mockAgents.getAgentCatalogEntries, mockAgents.runSingleQuery,
  mockRegistry.getChat, mockRegistry.addChat, mockRegistry.removeChat,
  mockRegistry.updateChat,
  mockQueue.submit, mockQueue.registerPendingUserInput, mockQueue.discardPendingUserInput,
  mockQueue.runAcceptedTurn, mockQueue.abort, mockQueue.triggerDrain,
  mockQueue.readChatQueue, mockQueue.enqueueChat, mockQueue.dequeueChat,
  mockQueue.clearChatQueue, mockQueue.pauseChatQueue, mockQueue.resumeChatQueue,
  mockChatEvents.readPage, mockChatEvents.readReplay,
  mockNativeReloader.ensureColdLoaded, mockNativeReloader.reloadFromNative,
  mockPendingInputs.register, mockPendingInputs.reconcile,
  mockPendingInputs.listForChat, mockPendingInputs.clearChat,
  mockSettings.getUiSettings, mockSettings.getChatName,
  mockSettings.setSessionName, mockSettings.setLastChatDefaults,
  mockSettings.ensureInNormal, mockSettings.removeFromAllOrderLists,
  mockMetadata.addNewChatMetadata, mockMetadata.getChatMetadata,
  mockCommandLedger.accept, mockCommandLedger.update,
  mockCommandLedger.updateUnlessStatus,
  mockForkChatFileCopy,
];

const moduleMocks = [sendWebSocketJson];

const chatHandlerInstance = new ChatHandler({
  agents: mockAgents,
  queue: mockQueue,
  chatEvents: mockChatEvents,
  nativeReloader: mockNativeReloader,
  registry: mockRegistry,
  pendingInputs: mockPendingInputs,
  commands: new ChatCommandService({
    chats: mockRegistry,
    queue: mockQueue,
    ledger: mockCommandLedger,
    settings: mockSettings,
    metadata: mockMetadata,
    agents: mockAgents,
    pendingInputs: mockPendingInputs,
    forkChatFileCopy: mockForkChatFileCopy,
  }),
});
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
    mockForkChatFileCopy.mockImplementation(() => Promise.resolve({
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
      mockRegistry.getChat.mockImplementation((chatId) => (
        chatId === '123' ? { agentId: 'claude', agentSessionId: 'session-123', model: 'opus' } : null
      ));
      await chatHandler.message(ws, {
        type: 'agent-run',
        chatId: '123',
        command: 'hello',
        permissionMode: 'default',
        thinkingMode: 'none',
        model: 'opus',
      });
      expect(mockQueue.submit).toHaveBeenCalledWith('123', 'hello', expect.objectContaining({
        permissionMode: 'default',
        thinkingMode: 'none',
        model: 'opus',
      }));
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
      mockRegistry.getChat.mockImplementation((chatId) => (
        chatId === '123' ? { agentId: 'claude', agentSessionId: 'session-123', model: 'opus' } : null
      ));
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
      mockRegistry.getChat.mockImplementation((chatId) => (
        chatId === '123' ? { agentId: 'claude', agentSessionId: 'session-123', model: 'opus' } : null
      ));
      await chatHandler.message(ws, {
        type: 'agent-run',
        chatId: '123',
        command: '',
        permissionMode: 'default',
        thinkingMode: 'none',
        model: 'opus',
        images: [{ data: 'data:image/png;base64,abc', name: 'a.png' }],
      });
      expect(mockQueue.submit).toHaveBeenCalledWith('123', '', expect.objectContaining({
        images: [{ data: 'data:image/png;base64,abc', name: 'a.png' }],
        permissionMode: 'default',
        thinkingMode: 'none',
        model: 'opus',
      }));
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

      expect(mockForkChatFileCopy).toHaveBeenCalledWith({
        sourceSession,
        sourceChatId: '123',
        targetChatId: '456',
        registry: mockRegistry,
        settings: mockSettings,
        metadata: mockMetadata,
        forkAgentSession: undefined,
        supportsFork: expect.any(Function),
      });
      expect(sendWebSocketJson.mock.calls[0][1]).toMatchObject({
        type: 'chat-fork-created',
        sourceChatId: '123',
        chatId: '456',
      });
      expect(mockQueue.submit).toHaveBeenCalledWith('456', 'continue in fork', expect.objectContaining({
        permissionMode: 'default',
        thinkingMode: 'none',
        model: 'opus',
      }));
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

      expect(mockForkChatFileCopy).not.toHaveBeenCalled();
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

      expect(mockForkChatFileCopy).not.toHaveBeenCalled();
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
      mockForkChatFileCopy.mockImplementationOnce(async () => {
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

    it('forwards the same permissionRequestId for different chats independently', async () => {
      await chatHandler.message(ws, {
        type: 'permission-decision',
        chatId: '123',
        permissionRequestId: 'dedup-cross-chat',
        allow: true,
        alwaysAllow: false,
      });
      await chatHandler.message(ws, {
        type: 'permission-decision',
        chatId: '456',
        permissionRequestId: 'dedup-cross-chat',
        allow: false,
        alwaysAllow: false,
      });
      expect(mockAgents.resolvePermission).toHaveBeenCalledTimes(2);
    });

    it('accepts the same permissionRequestId after the dedup window expires', async () => {
      const originalDateNow = Date.now;
      let now = 1_700_000_000_000;
      Date.now = () => now;
      try {
        const msg = {
          type: 'permission-decision',
          chatId: '123',
          permissionRequestId: 'dedup-expiry-1',
          allow: true,
          alwaysAllow: false,
        };

        await chatHandler.message(ws, msg);
        expect(mockAgents.resolvePermission).toHaveBeenCalledTimes(1);

        mockAgents.resolvePermission.mockClear();
        now += 30_001;
        await chatHandler.message(ws, msg);
        expect(mockAgents.resolvePermission).toHaveBeenCalledTimes(1);
      } finally {
        Date.now = originalDateNow;
      }
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
    it('applies a typed permission mode patch', async () => {
      await chatHandler.message(ws, {
        type: 'permission-mode-set',
        chatId: '123',
        mode: 'bypassPermissions',
      });
      expect(mockAgents.updateSessionSettings).toHaveBeenCalledWith('123', { permissionMode: 'bypassPermissions' });
    });

    it('ignores non-string mode values', async () => {
      await chatHandler.message(ws, {
        type: 'permission-mode-set',
        chatId: '123',
        mode: 42,
      });
      expect(mockAgents.updateSessionSettings).not.toHaveBeenCalled();
    });
  });

  describe('thinking-mode-set', () => {
    it('applies a typed thinking mode patch', async () => {
      await chatHandler.message(ws, {
        type: 'thinking-mode-set',
        chatId: '123',
        mode: 'think-hard',
      });
      expect(mockAgents.updateSessionSettings).toHaveBeenCalledWith('123', { thinkingMode: 'think-hard' });
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
      expect(mockAgents.updateSessionSettings).not.toHaveBeenCalled();
    });
  });

  describe('claude-thinking-mode-set', () => {
		it('applies a typed Claude thinking mode patch', async () => {
	  await chatHandler.message(ws, {
	    type: 'claude-thinking-mode-set',
	    chatId: '123',
	    mode: 'off',
	  });
		  expect(mockAgents.updateSessionSettings).toHaveBeenCalledWith('123', { claudeThinkingMode: 'off' });
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
      expect(mockAgents.updateSessionSettings).toHaveBeenCalledWith('123', { model: 'opus' });
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
      expect(mockAgents.updateSessionSettings).toHaveBeenCalledWith('123', {
        model: 'zai_openai:glm-5.1',
        apiProviderId: 'zai',
        modelEndpointId: 'zai_openai',
        modelProtocol: 'openai-compatible',
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
      expect(mockAgents.updateSessionSettings).toHaveBeenCalledWith('123', {
        model: 'opus',
        apiProviderId: null,
        modelEndpointId: null,
        modelProtocol: null,
      });
    });
  });

  describe('chats-running-query', () => {
    it('responds with chat-sessions-running shape', async () => {
      await chatHandler.message(ws, {
        type: 'chats-running-query',
        clientRequestId: 'req-running-1',
      });
      const payload = lastSentPayload();
      expect(payload).toMatchObject({
        type: 'chat-sessions-running',
        clientRequestId: 'req-running-1',
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

    it('returns event page for a valid chat', async () => {
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
      expect(mockPendingInputs.reconcile).toHaveBeenCalledWith('123');
      expect(mockChatEvents.readPage).toHaveBeenCalledWith('123', 20, undefined);
      const payload = lastSentPayload();
      expect(payload).toMatchObject({
        type: 'chat-log-response',
        clientRequestId: 'req-msg-2',
        chatId: '123',
        logId: 'log-1',
        pendingUserInputs: [],
        lastAppendSeq: 1,
      });
      expect(payload.events.length).toBe(1);
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

    it('respects limit and beforeSeq params', async () => {
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
        beforeSeq: 10,
      });
      expect(mockPendingInputs.reconcile).toHaveBeenCalledWith('123');
      expect(mockChatEvents.readPage).toHaveBeenCalledWith('123', 50, 10);
    });

    it('clamps invalid limit params', async () => {
      mockRegistry.getChat.mockReturnValue({
        agentId: 'claude',
        nativePath: '/tmp/session.jsonl',
        agentSessionId: 'abc',
      });
      await chatHandler.message(ws, {
        type: 'chat-log-query',
        chatId: '123',
        clientRequestId: 'req-msg-4b',
        limit: '999999',
      });
      expect(mockChatEvents.readPage).toHaveBeenCalledWith('123', 200, undefined);
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

  describe('chat-subscribe', () => {
    it('replays event deltas for the requested cursor', async () => {
      mockRegistry.getChat.mockReturnValue({
        agentId: 'claude',
        nativePath: '/tmp/test.jsonl',
        agentSessionId: 'x',
      });
      await chatHandler.message(ws, {
        type: 'chat-subscribe',
        chatId: '123',
        clientRequestId: 'req-sub-1',
        logId: 'log-1',
        afterAppendSeq: 1,
      });

      expect(mockNativeReloader.ensureColdLoaded).toHaveBeenCalledWith('123');
      expect(mockChatEvents.readReplay).toHaveBeenCalledWith('123', 'log-1', 1);
      expect(lastSentPayload()).toMatchObject({
        type: 'chat-subscribed',
        clientRequestId: 'req-sub-1',
        chatId: '123',
        logId: 'log-1',
        mode: 'delta',
        lastAppendSeq: 1,
      });
    });

    it('returns client-request-error for unknown chatId', async () => {
      mockRegistry.getChat.mockReturnValue(null);
      await chatHandler.message(ws, {
        type: 'chat-subscribe',
        chatId: 'missing',
        clientRequestId: 'req-sub-2',
      });

      expect(lastSentPayload()).toMatchObject({
        type: 'client-request-error',
        clientRequestId: 'req-sub-2',
        code: 'SESSION_NOT_FOUND',
      });
    });
  });

  describe('chat-reload', () => {
    it('reloads from native and sends a correlated reload response', async () => {
      mockRegistry.getChat.mockReturnValue({
        agentId: 'claude',
        nativePath: '/tmp/test.jsonl',
        agentSessionId: 'x',
      });
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
        logId: 'log-2',
        lastAppendSeq: 1,
      });
    });

    it('rejects manual reload while the chat is running', async () => {
      mockRegistry.getChat.mockReturnValue({
        agentId: 'claude',
        nativePath: '/tmp/test.jsonl',
        agentSessionId: 'x',
      });
      mockNativeReloader.reloadFromNative.mockRejectedValueOnce(
        new Error('Cannot manually reload running chat'),
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

  describe('queue-enqueue', () => {
    it('calls enqueueChat and asks the queue to drain', async () => {
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
      expect(mockQueue.triggerDrain).toHaveBeenCalledWith('123');
    });

    it('delegates persisted drain settings to QueueManager', async () => {
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

      expect(mockQueue.triggerDrain).toHaveBeenCalledWith('123');
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

    it('does not validate persisted settings in the websocket transport', async () => {
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
      expect(mockQueue.triggerDrain).toHaveBeenCalledWith('123');
      expect(sendWebSocketJson).not.toHaveBeenCalled();
    });
  });

  describe('dequeue-enqueue', () => {
    it('calls dequeueChat with chatId and entryId', async () => {
      mockRegistry.getChat.mockReturnValue({ agentId: 'claude', projectPath: '/repo', model: 'opus' });
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
      mockRegistry.getChat.mockReturnValue({ agentId: 'claude', projectPath: '/repo', model: 'opus' });
      await chatHandler.message(ws, {
        type: 'queue-clear',
        chatId: '123',
      });
      expect(mockQueue.clearChatQueue).toHaveBeenCalledWith('123');
    });
  });

  describe('queue-pause', () => {
    it('calls pauseChatQueue', async () => {
      mockRegistry.getChat.mockReturnValue({ agentId: 'claude', projectPath: '/repo', model: 'opus' });
      await chatHandler.message(ws, {
        type: 'queue-pause',
        chatId: '123',
      });
      expect(mockQueue.pauseChatQueue).toHaveBeenCalledWith('123');
    });
  });

  describe('queue-resume', () => {
    it('calls resumeChatQueue and asks the queue to drain', async () => {
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
      expect(mockQueue.triggerDrain).toHaveBeenCalledWith('123');
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
