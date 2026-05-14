import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

const testBasePath = path.join(os.tmpdir(), 'garcon-chats-start-test');

mock.module('../../lib/http-request.js', () => ({
  parseJsonBody: mock(() => Promise.resolve({})),
}));

mock.module('../../chats/title-generator.js', () => ({
  maybeGenerateChatTitle: mock(() => Promise.resolve(undefined)),
}));

mock.module('../../config.js', () => ({
  getProjectBasePath: mock(() => testBasePath),
}));

import createChatRoutes from '../chats.js';
import { parseJsonBody } from '../../lib/http-request.js';

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
  getPinnedChatIds: mock(() => Promise.resolve([])),
  getNormalChatIds: mock(() => Promise.resolve([])),
  getArchivedChatIds: mock(() => Promise.resolve([])),
  reorderWindow: mock(() => Promise.resolve({ success: true })),
  reorderRelative: mock(() => Promise.resolve({ success: true })),
};

const queue = { deleteChatQueueFile: mock(() => Promise.resolve(undefined)) };
const pathCache = { isProjectPathAvailable: mock(() => Promise.resolve(true)) };
const metadata = {
  addNewChatMetadata: mock(() => undefined),
  listAllChatMetadata: mock(() => new Map()),
  getChatMetadata: mock(() => null),
};
const historyCache = {
  ensureLoaded: mock(() => Promise.resolve(undefined)),
  getPaginatedMessages: mock(() => ({ messages: [], total: 0, hasMore: false, offset: 0, limit: 20 })),
  appendMessages: mock(() => Promise.resolve(undefined)),
};
const providers = {
  startSession: mock(() => Promise.resolve(undefined)),
  getModels: mock(() => Promise.resolve([])),
  isHarnessSessionRunning: mock(() => false),
  hasHarness: mock(() => true),
  modelSupportsImages: mock(() => Promise.resolve(false)),
};

const routes = createChatRoutes(registry, settings, queue, pathCache, metadata, historyCache, providers);
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
    historyCache.appendMessages.mockClear();
    providers.startSession.mockClear();
    providers.getModels.mockClear();
    providers.hasHarness.mockClear();
    providers.hasHarness.mockImplementation(() => true);
    providers.modelSupportsImages.mockClear();
  });

  afterEach(async () => {
    await fs.rm(testBasePath, { recursive: true, force: true });
  });

  it('persists top-level startup defaults before starting the harness session', async () => {
    const projectPath = path.join(testBasePath, 'project-a');
    await fs.mkdir(projectPath, { recursive: true });
    parseJsonBody.mockImplementation(() => Promise.resolve({
      chatId: '123',
      provider: 'codex',
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
      provider: 'codex',
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
	    expect(providers.startSession).toHaveBeenCalledWith('123', 'hello', expect.objectContaining({
	      images: [],
	      projectPath,
	      clientRequestId: expect.any(String),
	      turnId: expect.any(String),
	    }));
  });

  it('keeps the attempted defaults even when provider startup fails', async () => {
    const projectPath = path.join(testBasePath, 'project-b');
    await fs.mkdir(projectPath, { recursive: true });
    parseJsonBody.mockImplementation(() => Promise.resolve({
      chatId: '456',
      provider: 'claude',
      projectPath,
      model: 'opus',
      permissionMode: 'default',
      thinkingMode: 'none',
      claudeThinkingMode: 'on',
      command: 'hello again',
      options: {},
      tags: ['claude'],
    }));
    providers.startSession.mockImplementationOnce(() => Promise.reject(new Error('boom')));

    const response = await handler(new Request('http://localhost/api/v1/chats/start', { method: 'POST' }));
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).toBe('boom');
    expect(settings.setLastChatDefaults).toHaveBeenCalledWith({
      provider: 'claude',
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
      provider: 'factory',
      projectPath,
      model: 'glm-5',
      permissionMode: 'default',
      thinkingMode: 'none',
      command: 'review the diagram',
      options: { images: [{ data: 'data:image/png;base64,abc', name: 'diagram.png' }] },
      tags: ['factory'],
    }));
    providers.getModels.mockResolvedValueOnce([
      { value: 'glm-5', label: 'Droid Core (GLM-5)', supportsImages: false },
    ]);

    const response = await handler(new Request('http://localhost/api/v1/chats/start', { method: 'POST' }));
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body.error).toBe('Images unsupported for harness: factory');
    expect(providers.startSession).not.toHaveBeenCalled();
  });

  it('normalizes invalid mode values from the REST payload before persisting them', async () => {
    const projectPath = path.join(testBasePath, 'project-d');
    await fs.mkdir(projectPath, { recursive: true });
    parseJsonBody.mockImplementation(() => Promise.resolve({
      chatId: '790',
      provider: 'claude',
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

  it('rejects missing providers instead of defaulting to Claude', async () => {
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
    expect(body.error).toBe('provider is required');
    expect(registry.addChat).not.toHaveBeenCalled();
    expect(providers.startSession).not.toHaveBeenCalled();
  });

  it('rejects unsupported providers instead of defaulting to Claude', async () => {
    const projectPath = path.join(testBasePath, 'project-f');
    await fs.mkdir(projectPath, { recursive: true });
    providers.hasHarness.mockImplementation((harnessId) => harnessId !== 'unknown-provider');
    parseJsonBody.mockImplementation(() => Promise.resolve({
      chatId: '792',
      provider: 'unknown-provider',
      projectPath,
      model: 'opus',
      command: 'hello',
      options: {},
    }));

    const response = await handler(new Request('http://localhost/api/v1/chats/start', { method: 'POST' }));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe('Unsupported harness: unknown-provider');
    expect(registry.addChat).not.toHaveBeenCalled();
    expect(providers.startSession).not.toHaveBeenCalled();
  });
});
