import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

const testBasePath = path.join(os.tmpdir(), 'garcon-chats-start-test');

mock.module('../../lib/http-native.js', () => ({
  parseJsonBody: mock(() => Promise.resolve({})),
}));

mock.module('../../chats/title-generator.js', () => ({
  maybeGenerateChatTitle: mock(() => Promise.resolve(undefined)),
}));

mock.module('../../config.js', () => ({
  getProjectBasePath: mock(() => testBasePath),
}));

import createChatRoutes from '../chats.js';
import { parseJsonBody } from '../../lib/http-native.js';

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
  isProviderSessionRunning: mock(() => false),
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
  });

  afterEach(async () => {
    await fs.rm(testBasePath, { recursive: true, force: true });
  });

  it('persists top-level startup defaults before starting the provider session', async () => {
    const projectPath = path.join(testBasePath, 'project-a');
    await fs.mkdir(projectPath, { recursive: true });
    parseJsonBody.mockImplementation(() => Promise.resolve({
      chatId: '123',
      provider: 'codex',
      projectPath,
      model: 'gpt-5.4',
      permissionMode: 'acceptEdits',
      thinkingMode: 'think-hard',
      command: 'hello',
      options: { images: [] },
      tags: ['codex'],
    }));

    const response = await handler(new Request('http://localhost/api/v1/chats/start', { method: 'POST' }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(settings.setLastChatDefaults).toHaveBeenCalledWith({
      provider: 'codex',
      projectPath,
      model: 'gpt-5.4',
      permissionMode: 'acceptEdits',
      thinkingMode: 'think-hard',
    });
    expect(providers.startSession).toHaveBeenCalledWith('123', 'hello', {
      images: [],
      projectPath,
    });
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
      permissionMode: 'default',
      thinkingMode: 'none',
    });
    expect(settings.removeFromAllOrderLists).toHaveBeenCalledWith('456');
  });
});
