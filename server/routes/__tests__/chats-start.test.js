import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

const testBasePath = path.join(os.tmpdir(), 'garcon-chats-start-test');
const CHAT_ID = '1783725900000100';

class MalformedJsonError extends Error {
  constructor() { super('Malformed JSON'); this.name = 'MalformedJsonError'; }
}

mock.module('../../lib/http-request.js', () => ({
  parseJsonBody: mock(() => Promise.resolve({})),
  MalformedJsonError,
}));

mock.module('../../chats/title-generator.js', () => ({
  maybeGenerateChatTitle: mock(() => Promise.resolve(undefined)),
  generateChatTitleFromMessage: mock(() => Promise.resolve({ chatId: '123', title: 'Generated Title' })),
  TitleGenerationError: class TitleGenerationError extends Error {},
}));

mock.module('../../config.js', () => ({
  getProjectBasePath: mock(() => testBasePath),
  isHttpCompressionEnabled: mock(() => true),
}));

import createChatRoutes from '../chats.js';
import { parseJsonBody } from '../../lib/http-request.js';
import { createRouteChatListProjector, createRouteCommandLedger, createRouteCommandService, createRoutePathCache, createRoutePendingInputs } from './chat-routes-test-utils.js';

const testChats = new Map();
const normalChatIds = [];
const registry = {
  getChat: mock((chatId) => testChats.get(chatId)),
  addChat: mock((chat) => {
    testChats.set(chat.id, chat);
    return true;
  }),
  updateChat: mock(() => undefined),
  removeChat: mock((chatId) => testChats.delete(chatId)),
  listAllChats: mock(() => ({})),
};

const settings = {
  getChatName: mock(() => null),
  ensureInNormal: mock((chatId) => {
    const existingIndex = normalChatIds.indexOf(chatId);
    if (existingIndex >= 0) normalChatIds.splice(existingIndex, 1);
    normalChatIds.unshift(chatId);
    return Promise.resolve(undefined);
  }),
  recordChatStartup: mock(() => Promise.resolve(undefined)),
  removeFromAllOrderLists: mock(() => Promise.resolve(undefined)),
  removeSessionName: mock(() => Promise.resolve(undefined)),
  togglePin: mock(() => Promise.resolve({ isPinned: true })),
  toggleArchive: mock(() => Promise.resolve({ isArchived: true })),
  getPinnedChatIds: mock(() => []),
  getNormalChatIds: mock(() => [...normalChatIds]),
  getArchivedChatIds: mock(() => []),
  reorderWindow: mock(() => Promise.resolve({ success: true })),
  reorderRelative: mock(() => Promise.resolve({ success: true })),
};

const queue = {
  deleteChatQueueFile: mock(() => Promise.resolve(undefined)),
  registerPendingUserInput: mock(() => Promise.resolve(undefined)),
  discardPendingUserInput: mock(() => true),
  reserveDirectTurn: mock((chatId) => ({ chatId, reservationId: `reservation-${chatId}` })),
  releaseDirectTurn: mock(() => Promise.resolve(undefined)),
  completeDirectTurn: mock(() => Promise.resolve(undefined)),
  failDirectTurn: mock(() => Promise.resolve(undefined)),
};
const pathCache = createRoutePathCache();
const metadata = {
  addNewChatMetadata: mock(() => undefined),
  listAllChatMetadata: mock(() => new Map()),
  getChatMetadata: mock(() => null),
};
const chatViews = {
  getOrCreatePage: mock(() => Promise.resolve({ messages: [], generationId: 'generation-1', lastSeq: 0, pageOldestSeq: 0, hasMore: false })),
};
const agents = {
  startSession: mock(() => Promise.resolve(undefined)),
  getModels: mock(() => Promise.resolve([])),
  isAgentSessionRunning: mock(() => false),
  hasAgent: mock(() => true),
  supportsFork: mock(() => true),
  supportsImages: mock(() => false),
  modelSupportsImages: mock(() => Promise.resolve(false)),
};

const commandLedger = createRouteCommandLedger('chats-start');
const pendingInputs = createRoutePendingInputs();
const chatListProjector = createRouteChatListProjector({ registry, settings, metadata, agents, pathCache });

const routes = createChatRoutes({
  registry,
  settings,
  queue,
  pathCache,
  metadata,
  chatViews,
  agents,
	pendingInputs,
	chatListProjector,
  commandService: createRouteCommandService({
    registry,
    queue,
    settings,
    metadata,
    agents,
    commandLedger,
		pendingInputs,
		pathCache,
		chatListProjector,
  }),
});
const handler = routes['/api/v1/chats/start'].POST;

describe('POST /api/v1/chats/start', () => {
  beforeEach(async () => {
    await fs.rm(testBasePath, { recursive: true, force: true });
    await fs.mkdir(testBasePath, { recursive: true });
    testChats.clear();
    normalChatIds.splice(0);
    parseJsonBody.mockClear();
    registry.getChat.mockClear();
    registry.addChat.mockClear();
    registry.removeChat.mockClear();
    settings.ensureInNormal.mockClear();
    settings.removeFromAllOrderLists.mockClear();
    settings.recordChatStartup.mockClear();
    metadata.addNewChatMetadata.mockClear();
    chatViews.getOrCreatePage.mockClear();
    queue.registerPendingUserInput.mockClear();
    queue.reserveDirectTurn.mockClear();
    queue.releaseDirectTurn.mockClear();
    queue.completeDirectTurn.mockClear();
    queue.failDirectTurn.mockClear();
    agents.startSession.mockClear();
    agents.getModels.mockClear();
    agents.hasAgent.mockClear();
    agents.hasAgent.mockImplementation(() => true);
    agents.modelSupportsImages.mockClear();
  });

  afterEach(async () => {
    await fs.rm(testBasePath, { recursive: true, force: true });
  });

  it('records startup recents before starting the agent session', async () => {
    const projectPath = path.join(testBasePath, 'project-a');
    await fs.mkdir(projectPath, { recursive: true });
    parseJsonBody.mockImplementation(() => Promise.resolve({
      clientRequestId: 'req-start-a',
      clientMessageId: 'msg-start-a',
      chatId: CHAT_ID,
      agentId: 'codex',
      projectPath,
      model: 'gpt-5.4',
      permissionMode: 'acceptEdits',
      thinkingMode: 'medium',
      claudeThinkingMode: 'off',
      command: 'hello',
    }));

    const response = await handler(new Request('http://localhost/api/v1/chats/start', { method: 'POST' }));
    const body = await response.json();

	    expect(response.status).toBe(202);
	    expect(body.success).toBe(true);
	    expect(body.commandType).toBe('chat-start');
    expect(settings.recordChatStartup).toHaveBeenCalledWith({
      agentId: 'codex',
      projectPath,
      model: 'gpt-5.4',
      apiProviderId: null,
      modelEndpointId: null,
      modelProtocol: null,
      permissionMode: 'acceptEdits',
      thinkingMode: 'medium',
      claudeThinkingMode: 'off',
      ampAgentMode: 'smart',
    });
	    expect(agents.startSession).toHaveBeenCalledWith(CHAT_ID, 'hello', expect.objectContaining({
	      projectPath,
	      clientRequestId: 'req-start-a',
	      clientMessageId: 'msg-start-a',
	      turnId: expect.any(String),
	    }));
    expect(queue.reserveDirectTurn).toHaveBeenCalledWith(
      CHAT_ID,
      expect.objectContaining({
        clientRequestId: 'req-start-a',
        turnId: expect.any(String),
      }),
    );
    expect(queue.completeDirectTurn).toHaveBeenCalledTimes(1);
    expect(queue.releaseDirectTurn).not.toHaveBeenCalled();
  });

  it('keeps the attempted defaults even when agent startup fails', async () => {
    const projectPath = path.join(testBasePath, 'project-b');
    await fs.mkdir(projectPath, { recursive: true });
    parseJsonBody.mockImplementation(() => Promise.resolve({
      clientRequestId: 'req-start-b',
      clientMessageId: 'msg-start-b',
      chatId: '1783725900000101',
      agentId: 'claude',
      projectPath,
      model: 'opus',
      permissionMode: 'default',
      thinkingMode: 'none',
      claudeThinkingMode: 'on',
      command: 'hello again',
    }));
    agents.startSession.mockImplementationOnce(() => Promise.reject(new Error('boom')));

    const response = await handler(new Request('http://localhost/api/v1/chats/start', { method: 'POST' }));
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).toBe('Internal server error');
    expect(settings.recordChatStartup).toHaveBeenCalledWith({
      agentId: 'claude',
      projectPath,
      model: 'opus',
      apiProviderId: null,
      modelEndpointId: null,
      modelProtocol: null,
      permissionMode: 'default',
      thinkingMode: 'none',
      claudeThinkingMode: 'on',
      ampAgentMode: 'smart',
    });
    expect(settings.removeFromAllOrderLists).toHaveBeenCalledWith('1783725900000101');
    expect(queue.failDirectTurn).toHaveBeenCalledTimes(1);
  });

  it('rejects image attachments when the selected factory model does not support images', async () => {
    const projectPath = path.join(testBasePath, 'project-c');
    await fs.mkdir(projectPath, { recursive: true });
    parseJsonBody.mockImplementation(() => Promise.resolve({
      clientRequestId: 'req-start-c',
      clientMessageId: 'msg-start-c',
      chatId: '1783725900000102',
      agentId: 'factory',
      projectPath,
      model: 'glm-5',
      permissionMode: 'default',
      thinkingMode: 'none',
      command: 'review the diagram',
      images: [{ data: 'data:image/png;base64,abc', name: 'diagram.png' }],
    }));
    agents.getModels.mockResolvedValueOnce([
      { value: 'glm-5', label: 'Droid Core (GLM-5)', supportsImages: false },
    ]);

    const response = await handler(new Request('http://localhost/api/v1/chats/start', { method: 'POST' }));
    const body = await response.json();

    expect(response.status).toBe(422);
	    expect(body.error).toBe('Attachments unsupported for agent: factory');
    expect(agents.startSession).not.toHaveBeenCalled();
  });

  it('normalizes invalid mode values from the REST payload before persisting them', async () => {
    const projectPath = path.join(testBasePath, 'project-d');
    await fs.mkdir(projectPath, { recursive: true });
    parseJsonBody.mockImplementation(() => Promise.resolve({
      clientRequestId: 'req-start-d',
      clientMessageId: 'msg-start-d',
      chatId: '1783725900000103',
      agentId: 'claude',
      projectPath,
      model: 'opus',
      permissionMode: 'bogus',
      thinkingMode: 'very-hard',
      claudeThinkingMode: 'sometimes',
      command: 'normalize this',
    }));

    const response = await handler(new Request('http://localhost/api/v1/chats/start', { method: 'POST' }));
    const body = await response.json();

	    expect(response.status).toBe(202);
	    expect(body.success).toBe(true);
	    expect(body.commandType).toBe('chat-start');
    expect(registry.addChat).toHaveBeenCalledWith(expect.objectContaining({
      permissionMode: 'default',
      thinkingMode: 'none',
      claudeThinkingMode: 'auto',
    }));
    expect(settings.recordChatStartup).toHaveBeenCalledWith(expect.objectContaining({
      permissionMode: 'default',
      thinkingMode: 'none',
      claudeThinkingMode: 'auto',
    }));
  });

  it('rejects missing agents instead of defaulting to Claude', async () => {
    const projectPath = path.join(testBasePath, 'project-e');
    await fs.mkdir(projectPath, { recursive: true });
    parseJsonBody.mockImplementation(() => Promise.resolve({
      clientRequestId: 'req-start-e',
      clientMessageId: 'msg-start-e',
      chatId: '1783725900000104',
      projectPath,
      model: 'opus',
      command: 'hello',
    }));

    const response = await handler(new Request('http://localhost/api/v1/chats/start', { method: 'POST' }));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe('agentId is required');
    expect(registry.addChat).not.toHaveBeenCalled();
    expect(agents.startSession).not.toHaveBeenCalled();
  });

  it('rejects unsupported agents instead of defaulting to Claude', async () => {
    const projectPath = path.join(testBasePath, 'project-f');
    await fs.mkdir(projectPath, { recursive: true });
    agents.hasAgent.mockImplementation((agentId) => agentId !== 'unknown-provider');
    parseJsonBody.mockImplementation(() => Promise.resolve({
      clientRequestId: 'req-start-f',
      clientMessageId: 'msg-start-f',
      chatId: '1783725900000105',
      agentId: 'unknown-provider',
      projectPath,
      model: 'opus',
      command: 'hello',
    }));

    const response = await handler(new Request('http://localhost/api/v1/chats/start', { method: 'POST' }));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe('Unsupported agent: unknown-provider');
    expect(registry.addChat).not.toHaveBeenCalled();
    expect(agents.startSession).not.toHaveBeenCalled();
  });

  it('rejects the removed options bag instead of silently dropping it', async () => {
    parseJsonBody.mockImplementation(() => Promise.resolve({
      clientRequestId: 'req-options',
      clientMessageId: 'msg-options',
      chatId: CHAT_ID,
      options: { images: [] },
    }));

    const response = await handler(new Request('http://localhost/api/v1/chats/start', { method: 'POST' }));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toMatchObject({
      error: 'options is not supported',
      errorCode: 'VALIDATION_FAILED',
    });
    expect(registry.addChat).not.toHaveBeenCalled();
  });

  it('requires request and message identity', async () => {
    parseJsonBody.mockImplementation(() => Promise.resolve({ chatId: CHAT_ID }));

    const response = await handler(new Request('http://localhost/api/v1/chats/start', { method: 'POST' }));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe('clientRequestId is required');
    expect(registry.addChat).not.toHaveBeenCalled();
  });

  it('rejects oversized numeric chat IDs before persistence', async () => {
    parseJsonBody.mockImplementation(() => Promise.resolve({
      clientRequestId: 'req-oversized',
      clientMessageId: 'msg-oversized',
      chatId: '178372590000007231252',
      agentId: 'claude',
      projectPath: testBasePath,
      model: 'opus',
      command: 'hello',
    }));

    const response = await handler(new Request('http://localhost/api/v1/chats/start', { method: 'POST' }));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.errorCode).toBe('VALIDATION_FAILED');
    expect(registry.addChat).not.toHaveBeenCalled();
  });
});
