import { describe, it, expect, beforeEach, mock } from 'bun:test';

mock.module('../../lib/http-request.js', () => ({
  parseJsonBody: mock(() => undefined),
}));

mock.module('../../providers/loaders/claude-history-loader.js', () => ({
  getClaudeSessionMessagesFromNativePath: mock(() => undefined),
}));

mock.module('../../chats/resolve-native-path.js', () => ({
  resolveMissingNativePath: mock(() => Promise.resolve(null)),
}));

mock.module('../../chats/title-generator.js', () => ({
  maybeGenerateChatTitle: mock(() => Promise.resolve(undefined)),
}));

import createChatRoutes from '../chats.js';

const registry = {
  getChat: mock(() => undefined),
  addChat: mock(() => undefined),
  updateChat: mock(() => undefined),
  removeChat: mock(() => undefined),
  listAllChats: mock(() => ({})),
};
const settings = {
  getChatName: mock(() => null),
  setSessionName: mock(() => Promise.resolve(undefined)),
  removeSessionName: mock(() => Promise.resolve(undefined)),
  getPinnedChatIds: mock(() => Promise.resolve([])),
  getNormalChatIds: mock(() => Promise.resolve([])),
  getArchivedChatIds: mock(() => Promise.resolve([])),
  removeFromAllOrderLists: mock(() => Promise.resolve(undefined)),
  insertNormalChatIdTop: mock(() => Promise.resolve(undefined)),
  ensureInNormal: mock(() => Promise.resolve(undefined)),
  togglePin: mock(() => Promise.resolve({ isPinned: true })),
  toggleArchive: mock(() => Promise.resolve({ isArchived: true })),
};
const queue = { deleteChatQueueFile: mock(() => Promise.resolve(undefined)) };
const pathCache = { isProjectPathAvailable: mock(() => Promise.resolve(true)) };
const metadata = {
  addNewChatMetadata: mock(() => undefined),
  listAllChatMetadata: mock(() => new Map()),
  getChatMetadata: mock(() => null),
};
const historyCache = {
  ensureLoaded: mock(() => undefined),
  getPaginatedMessages: mock(() => undefined),
  appendMessages: mock(() => Promise.resolve(undefined)),
};
const providers = {
  startSession: mock(() => undefined),
  isProviderSessionRunning: mock(() => false),
};

const chatsRoutes = createChatRoutes(registry, settings, queue, pathCache, metadata, historyCache, providers);

const allMocks = [
  registry.getChat,
  settings.getPinnedChatIds, settings.getNormalChatIds, settings.getArchivedChatIds,
  settings.togglePin, settings.toggleArchive,
];

describe('POST /api/chats/archive', () => {
  const handler = chatsRoutes['/api/v1/chats/archive'].POST;

  beforeEach(() => {
    allMocks.forEach(m => m.mockClear());
  });

  it('returns 400 when chatId is missing', async () => {
    const url = new URL('http://localhost/api/chats/archive');
    const request = new Request(url, { method: 'POST' });

    const response = await handler(request, url);
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe('chatId query parameter is required');
  });

  it('returns 404 when session not found', async () => {
    registry.getChat.mockImplementation(() => null);

    const url = new URL('http://localhost/api/chats/archive?chatId=999');
    const request = new Request(url, { method: 'POST' });

    const response = await handler(request, url);
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error).toBe('Session not found');
  });

  it('delegates to settings.toggleArchive and returns result', async () => {
    registry.getChat.mockImplementation(() => ({ provider: 'claude', projectPath: '/proj' }));
    settings.toggleArchive.mockImplementation(() => Promise.resolve({ isArchived: true }));

    const url = new URL('http://localhost/api/chats/archive?chatId=500');
    const request = new Request(url, { method: 'POST' });

    const response = await handler(request, url);
    const body = await response.json();

    expect(body.success).toBe(true);
    expect(body.isArchived).toBe(true);
    expect(settings.toggleArchive).toHaveBeenCalledWith('500');
  });

  it('returns isArchived false when unarchiving', async () => {
    registry.getChat.mockImplementation(() => ({ provider: 'claude', projectPath: '/proj' }));
    settings.toggleArchive.mockImplementation(() => Promise.resolve({ isArchived: false }));

    const url = new URL('http://localhost/api/chats/archive?chatId=500');
    const request = new Request(url, { method: 'POST' });

    const response = await handler(request, url);
    const body = await response.json();

    expect(body.success).toBe(true);
    expect(body.isArchived).toBe(false);
    expect(settings.toggleArchive).toHaveBeenCalledWith('500');
  });
});

describe('POST /api/chats/pin', () => {
  const handler = chatsRoutes['/api/v1/chats/pin'].POST;

  beforeEach(() => {
    allMocks.forEach(m => m.mockClear());
  });

  it('delegates to settings.togglePin and returns result', async () => {
    registry.getChat.mockImplementation(() => ({ provider: 'claude', projectPath: '/proj' }));
    settings.togglePin.mockImplementation(() => Promise.resolve({ isPinned: true }));

    const url = new URL('http://localhost/api/chats/pin?chatId=500');
    const request = new Request(url, { method: 'POST' });

    const response = await handler(request, url);
    const body = await response.json();

    expect(body.success).toBe(true);
    expect(body.isPinned).toBe(true);
    expect(settings.togglePin).toHaveBeenCalledWith('500');
  });

  it('returns isPinned false when unpinning', async () => {
    registry.getChat.mockImplementation(() => ({ provider: 'claude', projectPath: '/proj' }));
    settings.togglePin.mockImplementation(() => Promise.resolve({ isPinned: false }));

    const url = new URL('http://localhost/api/chats/pin?chatId=500');
    const request = new Request(url, { method: 'POST' });

    const response = await handler(request, url);
    const body = await response.json();

    expect(body.success).toBe(true);
    expect(body.isPinned).toBe(false);
    expect(settings.togglePin).toHaveBeenCalledWith('500');
  });
});

describe('GET /api/chats archive fields', () => {
  const handler = chatsRoutes['/api/v1/chats'].GET;

  beforeEach(() => {
    allMocks.forEach(m => m.mockClear());
  });

  it('includes isArchived field on sessions', async () => {
    registry.listAllChats.mockImplementation(() => ({
      '100': { provider: 'claude', projectPath: '/proj', tags: [] },
    }));
    metadata.listAllChatMetadata.mockImplementation(() => new Map());
    settings.getChatName.mockImplementation(() => null);
    settings.getPinnedChatIds.mockImplementation(() => Promise.resolve([]));
    settings.getNormalChatIds.mockImplementation(() => Promise.resolve([]));
    settings.getArchivedChatIds.mockImplementation(() => Promise.resolve(['100']));

    const response = await handler();
    const body = await response.json();

    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0].isArchived).toBe(true);
  });

  it('returns sessions in pinned, normal, archived order', async () => {
    registry.listAllChats.mockImplementation(() => ({
      '100': { provider: 'claude', projectPath: '/proj', tags: [] },
      '200': { provider: 'claude', projectPath: '/proj', tags: [] },
      '300': { provider: 'claude', projectPath: '/proj', tags: [] },
    }));
    metadata.listAllChatMetadata.mockImplementation(() => new Map());
    settings.getChatName.mockImplementation(() => null);
    settings.getPinnedChatIds.mockImplementation(() => Promise.resolve(['300']));
    settings.getNormalChatIds.mockImplementation(() => Promise.resolve(['200']));
    settings.getArchivedChatIds.mockImplementation(() => Promise.resolve(['100']));

    const response = await handler();
    const body = await response.json();

    expect(body.sessions).toHaveLength(3);
    expect(body.sessions[0].id).toBe('300');
    expect(body.sessions[0].isPinned).toBe(true);
    expect(body.sessions[1].id).toBe('200');
    expect(body.sessions[1].isPinned).toBe(false);
    expect(body.sessions[1].isArchived).toBe(false);
    expect(body.sessions[2].id).toBe('100');
    expect(body.sessions[2].isArchived).toBe(true);
  });
});
