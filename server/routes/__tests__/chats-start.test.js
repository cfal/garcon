import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

const testBasePath = path.join(os.tmpdir(), 'garcon-chats-start-test');

class MalformedJsonError extends Error {
  constructor() { super('Malformed JSON'); this.name = 'MalformedJsonError'; }
}

mock.module('../../lib/http-request.js', () => ({
  parseJsonBody: mock(() => Promise.resolve({})),
  MalformedJsonError,
}));

mock.module('../../chats/title-generator.js', () => ({
  maybeGenerateChatTitle: mock(() => Promise.resolve(undefined)),
}));

mock.module('../../config.js', () => ({
  getProjectBasePath: mock(() => testBasePath),
}));

import createChatRoutes from '../chats.js';
import { parseJsonBody } from '../../lib/http-request.js';
import { createRouteCommandLedger, createRouteCommandService, createRoutePendingInputs } from './chat-routes-test-utils.js';

const registry = {
  getChat: mock(() => undefined),
  addChat: mock(() => true),
  updateChat: mock(() => undefined),
  removeChat: mock(() => undefined),
  listAllChats: mock(() => ({})),
};

const settings = {
  getChatName: mock(() => null),
  ensureInNormal: mock(() => Promise.resolve(undefined)),
  setLastChatDefaults: mock(() => Promise.resolve(undefined)),
  removeFromAllOrderLists: mock(() => Promise.resolve(undefined)),
  removeSessionName: mock(() => Promise.resolve(undefined)),
  togglePin: mock(() => Promise.resolve({ isPinned: true })),
  toggleArchive: mock(() => Promise.resolve({ isArchived: true })),
  getPinnedChatIds: mock(() => []),
  getNormalChatIds: mock(() => []),
  getArchivedChatIds: mock(() => []),
  reorderWindow: mock(() => Promise.resolve({ success: true })),
  reorderRelative: mock(() => Promise.resolve({ success: true })),
};

const queue = {
  deleteChatQueueFile: mock(() => Promise.resolve(undefined)),
  registerPendingUserInput: mock(() => Promise.resolve(undefined)),
};
const pathCache = { isProjectPathAvailable: mock(() => Promise.resolve(true)) };
const metadata = {
  addNewChatMetadata: mock(() => undefined),
  listAllChatMetadata: mock(() => new Map()),
  getChatMetadata: mock(() => null),
};
const chatEvents = {
  readPage: mock(() => Promise.resolve({ events: [], logId: 'log-1', lastAppendSeq: 0, pageOldestSeq: 0, hasMore: false })),
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

const routes = createChatRoutes({
  registry,
  settings,
  queue,
  pathCache,
  metadata,
  chatEvents,
  agents,
  pendingInputs,
  commandService: createRouteCommandService({
    registry,
    queue,
    settings,
    metadata,
    agents,
    commandLedger,
    pendingInputs,
  }),
});
const handler = routes['/api/v1/chats/start'].POST;

describe('POST /api/v1/chats/start', () => {
  beforeEach(async () => {
    await fs.rm(testBasePath, { recursive: true, force: true });
    await fs.mkdir(testBasePath, { recursive: true });
    parseJsonBody.mockClear();
    registry.getChat.mockClear();
    registry.addChat.mockClear();
    registry.removeChat.mockClear();
    settings.ensureInNormal.mockClear();
    settings.removeFromAllOrderLists.mockClear();
    settings.setLastChatDefaults.mockClear();
    metadata.addNewChatMetadata.mockClear();
    chatEvents.readPage.mockClear();
    queue.registerPendingUserInput.mockClear();
    agents.startSession.mockClear();
    agents.getModels.mockClear();
    agents.hasAgent.mockClear();
    agents.hasAgent.mockImplementation(() => true);
    agents.modelSupportsImages.mockClear();
  });

  afterEach(async () => {
    await fs.rm(testBasePath, { recursive: true, force: true });
  });

  it('persists top-level startup defaults before starting the agent session', async () => {
    const projectPath = path.join(testBasePath, 'project-a');
    await fs.mkdir(projectPath, { recursive: true });
    parseJsonBody.mockImplementation(() => Promise.resolve({
      chatId: '123',
      agentId: 'codex',
      projectPath,
      model: 'gpt-5.4',
      permissionMode: 'acceptEdits',
      thinkingMode: 'think-hard',
      claudeThinkingMode: 'off',
      command: 'hello',
      options: { images: [] },
      tags: ['codex'],
    }));

    const response = await handler(new Request('http://localhost/api/v1/chats/start', { method: 'POST' }));
    const body = await response.json();

	    expect(response.status).toBe(202);
	    expect(body.success).toBe(true);
	    expect(body.commandType).toBe('chat-start');
    expect(settings.setLastChatDefaults).toHaveBeenCalledWith({
      agentId: 'codex',
      projectPath,
      model: 'gpt-5.4',
      apiProviderId: null,
      modelEndpointId: null,
      modelProtocol: null,
      permissionMode: 'acceptEdits',
      thinkingMode: 'think-hard',
      claudeThinkingMode: 'off',
      ampAgentMode: 'smart',
    });
	    expect(agents.startSession).toHaveBeenCalledWith('123', 'hello', expect.objectContaining({
	      images: [],
	      projectPath,
	      clientRequestId: expect.any(String),
	      turnId: expect.any(String),
	    }));
  });

  it('keeps the attempted defaults even when agent startup fails', async () => {
    const projectPath = path.join(testBasePath, 'project-b');
    await fs.mkdir(projectPath, { recursive: true });
    parseJsonBody.mockImplementation(() => Promise.resolve({
      chatId: '456',
      agentId: 'claude',
      projectPath,
      model: 'opus',
      permissionMode: 'default',
      thinkingMode: 'none',
      claudeThinkingMode: 'on',
      command: 'hello again',
      options: {},
      tags: ['claude'],
    }));
    agents.startSession.mockImplementationOnce(() => Promise.reject(new Error('boom')));

    const response = await handler(new Request('http://localhost/api/v1/chats/start', { method: 'POST' }));
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).toBe('Internal server error');
    expect(settings.setLastChatDefaults).toHaveBeenCalledWith({
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
    expect(settings.removeFromAllOrderLists).toHaveBeenCalledWith('456');
  });

  it('rejects image attachments when the selected factory model does not support images', async () => {
    const projectPath = path.join(testBasePath, 'project-c');
    await fs.mkdir(projectPath, { recursive: true });
    parseJsonBody.mockImplementation(() => Promise.resolve({
      chatId: '789',
      agentId: 'factory',
      projectPath,
      model: 'glm-5',
      permissionMode: 'default',
      thinkingMode: 'none',
      command: 'review the diagram',
      options: { images: [{ data: 'data:image/png;base64,abc', name: 'diagram.png' }] },
      tags: ['factory'],
    }));
    agents.getModels.mockResolvedValueOnce([
      { value: 'glm-5', label: 'Droid Core (GLM-5)', supportsImages: false },
    ]);

    const response = await handler(new Request('http://localhost/api/v1/chats/start', { method: 'POST' }));
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body.error).toBe('Images unsupported for agent: factory');
    expect(agents.startSession).not.toHaveBeenCalled();
  });

  it('normalizes invalid mode values from the REST payload before persisting them', async () => {
    const projectPath = path.join(testBasePath, 'project-d');
    await fs.mkdir(projectPath, { recursive: true });
    parseJsonBody.mockImplementation(() => Promise.resolve({
      chatId: '790',
      agentId: 'claude',
      projectPath,
      model: 'opus',
      permissionMode: 'bogus',
      thinkingMode: 'very-hard',
      claudeThinkingMode: 'sometimes',
      command: 'normalize this',
      options: {},
      tags: ['claude'],
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
    expect(settings.setLastChatDefaults).toHaveBeenCalledWith(expect.objectContaining({
      permissionMode: 'default',
      thinkingMode: 'none',
      claudeThinkingMode: 'auto',
    }));
  });

  it('rejects missing agents instead of defaulting to Claude', async () => {
    const projectPath = path.join(testBasePath, 'project-e');
    await fs.mkdir(projectPath, { recursive: true });
    parseJsonBody.mockImplementation(() => Promise.resolve({
      chatId: '791',
      projectPath,
      model: 'opus',
      command: 'hello',
      options: {},
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
      chatId: '792',
      agentId: 'unknown-provider',
      projectPath,
      model: 'opus',
      command: 'hello',
      options: {},
    }));

    const response = await handler(new Request('http://localhost/api/v1/chats/start', { method: 'POST' }));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe('Unsupported agent: unknown-provider');
    expect(registry.addChat).not.toHaveBeenCalled();
    expect(agents.startSession).not.toHaveBeenCalled();
  });
});
