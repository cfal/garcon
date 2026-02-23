import { describe, it, expect, beforeEach, mock } from 'bun:test';

mock.module('../../lib/http-native.js', () => ({
  parseJsonBody: mock(() => undefined),
}));

mock.module('../../providers/loaders/claude-history-loader.js', () => ({
  getClaudeSessionMessagesFromNativePath: mock(() => undefined),
}));

mock.module('../../projects/codex.js', () => ({
  findCodexSessionFileBySessionId: mock(() => undefined),
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
  ensureLoaded: mock(() => undefined),
  getPaginatedMessages: mock(() => undefined),
  appendMessages: mock(() => Promise.resolve(undefined)),
};
const providers = {
  startSession: mock(() => undefined),
  isProviderSessionRunning: mock(() => false),
  supportsFork: mock(() => false),
};

const chatsRoutes = createChatRoutes(registry, settings, queue, pathCache, metadata, historyCache, providers);

const allMocks = [
  registry.listAllChats, metadata.listAllChatMetadata, registry.getChat, registry.removeChat,
  settings.getChatName, settings.removeSessionName, settings.removeFromAllOrderLists, settings.getNormalChatIds,
];

describe('GET /api/chats title resolution', () => {
  const handler = chatsRoutes['/api/v1/chats'].GET;

  beforeEach(() => {
    allMocks.forEach(m => m.mockClear());
  });

  it('uses override title when session name exists', async () => {
    registry.listAllChats.mockImplementation(() => ({
      '100': { provider: 'claude', projectPath: '/proj', tags: [] },
    }));
    const metaMap = new Map();
    metaMap.set('100', { firstMessage: 'fallback message', createdAt: null, lastActivity: null, lastMessage: '' });
    metadata.listAllChatMetadata.mockImplementation(() => metaMap);
    settings.getChatName.mockImplementation(() => 'Custom Title');
    settings.getNormalChatIds.mockImplementation(() => Promise.resolve(['100']));

    const response = await handler();
    const body = await response.json();

    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0].title).toBe('Custom Title');
    expect(settings.getChatName).toHaveBeenCalledWith('100');
  });

  it('falls back to firstMessage when no override exists', async () => {
    registry.listAllChats.mockImplementation(() => ({
      '200': { provider: 'claude', projectPath: '/proj', tags: [] },
    }));
    const metaMap = new Map();
    metaMap.set('200', { firstMessage: 'Hello world', createdAt: null, lastActivity: null, lastMessage: '' });
    metadata.listAllChatMetadata.mockImplementation(() => metaMap);
    settings.getChatName.mockImplementation(() => null);
    settings.getNormalChatIds.mockImplementation(() => Promise.resolve(['200']));

    const response = await handler();
    const body = await response.json();

    expect(body.sessions[0].title).toBe('Hello world');
  });

  it('falls back to "New Session" when no override or metadata', async () => {
    registry.listAllChats.mockImplementation(() => ({
      '300': { provider: 'claude', projectPath: '/proj', tags: [] },
    }));
    metadata.listAllChatMetadata.mockImplementation(() => new Map());
    settings.getChatName.mockImplementation(() => null);
    settings.getNormalChatIds.mockImplementation(() => Promise.resolve(['300']));

    const response = await handler();
    const body = await response.json();

    expect(body.sessions[0].title).toBe('New Session');
  });
});

describe('DELETE /api/chats session name cleanup', () => {
  const handler = chatsRoutes['/api/v1/chats'].DELETE;

  beforeEach(() => {
    allMocks.forEach(m => m.mockClear());
  });

  it('removes session name when deleting a chat', async () => {
    registry.getChat.mockImplementation(() => Promise.resolve({ provider: 'claude', projectPath: '/proj' }));

    const url = new URL('http://localhost/api/chats?chatId=500');
    const request = new Request(url, { method: 'DELETE' });

    const response = await handler(request, url);
    const body = await response.json();

    expect(body.success).toBe(true);
    expect(settings.removeSessionName).toHaveBeenCalledWith('500');
    expect(registry.removeChat).toHaveBeenCalledWith('500');
  });

  it('cleans up all order list references when deleting a chat', async () => {
    registry.getChat.mockImplementation(() => Promise.resolve({ provider: 'claude', projectPath: '/proj' }));

    const url = new URL('http://localhost/api/chats?chatId=500');
    const request = new Request(url, { method: 'DELETE' });

    await handler(request, url);

    expect(settings.removeFromAllOrderLists).toHaveBeenCalledWith('500');
  });
});
