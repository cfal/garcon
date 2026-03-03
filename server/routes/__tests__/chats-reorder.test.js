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
import { parseJsonBody } from '../../lib/http-native.js';

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
};

const chatsRoutes = createChatRoutes(registry, settings, queue, pathCache, metadata, historyCache, providers);

const allMocks = [
  settings.reorderWindow, settings.reorderRelative,
  parseJsonBody, registry.getChat,
];

describe('POST /api/chats/reorder (window-based)', () => {
  const handler = chatsRoutes['/api/v1/chats/reorder'].POST;

  beforeEach(() => {
    allMocks.forEach(m => m.mockClear());
  });

  it('rejects invalid list value', async () => {
    parseJsonBody.mockResolvedValue({ list: 'invalid', oldOrder: [], newOrder: [] });

    const request = new Request('http://localhost/api/chats/reorder', { method: 'POST' });
    const response = await handler(request);
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error).toBe('list must be "pinned", "normal", or "archived"');
  });

  it('rejects missing oldOrder or newOrder', async () => {
    parseJsonBody.mockResolvedValue({ list: 'pinned' });

    const request = new Request('http://localhost/api/chats/reorder', { method: 'POST' });
    const response = await handler(request);
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe('oldOrder and newOrder must be arrays');
  });

  it('propagates store validation error for empty oldOrder', async () => {
    parseJsonBody.mockResolvedValue({ list: 'pinned', oldOrder: [], newOrder: [] });
    settings.reorderWindow.mockResolvedValue({ success: false, error: 'oldOrder must not be empty' });

    const request = new Request('http://localhost/api/chats/reorder', { method: 'POST' });
    const response = await handler(request);
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe('oldOrder must not be empty');
  });

  it('propagates store validation error for length mismatch', async () => {
    parseJsonBody.mockResolvedValue({ list: 'pinned', oldOrder: ['a', 'b'], newOrder: ['a'] });
    settings.reorderWindow.mockResolvedValue({ success: false, error: 'oldOrder and newOrder must have the same length' });

    const request = new Request('http://localhost/api/chats/reorder', { method: 'POST' });
    const response = await handler(request);
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe('oldOrder and newOrder must have the same length');
  });

  it('propagates store validation error for set mismatch', async () => {
    parseJsonBody.mockResolvedValue({ list: 'pinned', oldOrder: ['a', 'b'], newOrder: ['a', 'c'] });
    settings.reorderWindow.mockResolvedValue({ success: false, error: 'oldOrder and newOrder must contain the same IDs' });

    const request = new Request('http://localhost/api/chats/reorder', { method: 'POST' });
    const response = await handler(request);
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe('oldOrder and newOrder must contain the same IDs');
  });

  it('propagates store validation error for IDs not in target list', async () => {
    parseJsonBody.mockResolvedValue({ list: 'pinned', oldOrder: ['a', 'x'], newOrder: ['x', 'a'] });
    settings.reorderWindow.mockResolvedValue({ success: false, error: 'ID "x" is not in the pinned list' });

    const request = new Request('http://localhost/api/chats/reorder', { method: 'POST' });
    const response = await handler(request);
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe('ID "x" is not in the pinned list');
  });

  it('propagates store validation error for non-contiguous oldOrder', async () => {
    parseJsonBody.mockResolvedValue({ list: 'pinned', oldOrder: ['a', 'c'], newOrder: ['c', 'a'] });
    settings.reorderWindow.mockResolvedValue({ success: false, error: 'oldOrder is not a contiguous subsequence of the current list' });

    const request = new Request('http://localhost/api/chats/reorder', { method: 'POST' });
    const response = await handler(request);
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe('oldOrder is not a contiguous subsequence of the current list');
  });

  it('delegates pinned reorder to settings.reorderWindow', async () => {
    settings.reorderWindow.mockResolvedValue({ success: true });
    parseJsonBody.mockResolvedValue({
      list: 'pinned',
      oldOrder: ['a', 'b', 'c'],
      newOrder: ['c', 'a', 'b'],
    });

    const request = new Request('http://localhost/api/chats/reorder', { method: 'POST' });
    const response = await handler(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(settings.reorderWindow).toHaveBeenCalledWith('pinned', ['a', 'b', 'c'], ['c', 'a', 'b']);
  });

  it('delegates normal reorder to settings.reorderWindow', async () => {
    settings.reorderWindow.mockResolvedValue({ success: true });
    parseJsonBody.mockResolvedValue({
      list: 'normal',
      oldOrder: ['x', 'y', 'z'],
      newOrder: ['z', 'x', 'y'],
    });

    const request = new Request('http://localhost/api/chats/reorder', { method: 'POST' });
    const response = await handler(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(settings.reorderWindow).toHaveBeenCalledWith('normal', ['x', 'y', 'z'], ['z', 'x', 'y']);
  });

  it('delegates archived reorder to settings.reorderWindow', async () => {
    settings.reorderWindow.mockResolvedValue({ success: true });
    parseJsonBody.mockResolvedValue({
      list: 'archived',
      oldOrder: ['m', 'n', 'o'],
      newOrder: ['o', 'n', 'm'],
    });

    const request = new Request('http://localhost/api/chats/reorder', { method: 'POST' });
    const response = await handler(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(settings.reorderWindow).toHaveBeenCalledWith('archived', ['m', 'n', 'o'], ['o', 'n', 'm']);
  });

  it('handles malformed JSON', async () => {
    parseJsonBody.mockRejectedValue(new Error('Malformed JSON'));

    const request = new Request('http://localhost/api/chats/reorder', { method: 'POST' });
    const response = await handler(request);
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe('Malformed JSON');
  });
});

describe('POST /api/chats/reorder-quick', () => {
  const handler = chatsRoutes['/api/v1/chats/reorder-quick'].POST;

  beforeEach(() => {
    allMocks.forEach(m => m.mockClear());
  });

  it('rejects missing chatId', async () => {
    parseJsonBody.mockResolvedValue({ chatIdAbove: 'a' });

    const request = new Request('http://localhost/api/chats/reorder-quick', { method: 'POST' });
    const response = await handler(request);
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe('chatId is required');
  });

  it('rejects when both chatIdAbove and chatIdBelow are provided', async () => {
    parseJsonBody.mockResolvedValue({ chatId: 'a', chatIdAbove: 'b', chatIdBelow: 'c' });

    const request = new Request('http://localhost/api/chats/reorder-quick', { method: 'POST' });
    const response = await handler(request);
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe('Exactly one of chatIdAbove or chatIdBelow must be provided');
  });

  it('rejects when neither chatIdAbove nor chatIdBelow are provided', async () => {
    parseJsonBody.mockResolvedValue({ chatId: 'a' });

    const request = new Request('http://localhost/api/chats/reorder-quick', { method: 'POST' });
    const response = await handler(request);
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe('Exactly one of chatIdAbove or chatIdBelow must be provided');
  });

  it('rejects when chat not found', async () => {
    registry.getChat.mockImplementation(() => null);
    parseJsonBody.mockResolvedValue({ chatId: 'a', chatIdAbove: 'b' });

    const request = new Request('http://localhost/api/chats/reorder-quick', { method: 'POST' });
    const response = await handler(request);
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error).toBe('Chat not found');
  });

  it('propagates store error for cross-group reorder', async () => {
    registry.getChat.mockImplementation(() => ({ provider: 'claude' }));
    settings.reorderRelative.mockResolvedValue({ success: false, error: 'Cross-group reorder is not allowed' });
    parseJsonBody.mockResolvedValue({ chatId: 'a', chatIdAbove: 'b' });

    const request = new Request('http://localhost/api/chats/reorder-quick', { method: 'POST' });
    const response = await handler(request);
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe('Cross-group reorder is not allowed');
  });

  it('delegates chatIdAbove reorder to settings.reorderRelative', async () => {
    registry.getChat.mockImplementation(() => ({ provider: 'claude' }));
    settings.reorderRelative.mockResolvedValue({ success: true });
    parseJsonBody.mockResolvedValue({ chatId: 'c', chatIdAbove: 'a' });

    const request = new Request('http://localhost/api/chats/reorder-quick', { method: 'POST' });
    const response = await handler(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(settings.reorderRelative).toHaveBeenCalledWith('c', 'a', 'below');
  });

  it('delegates chatIdBelow reorder to settings.reorderRelative', async () => {
    registry.getChat.mockImplementation(() => ({ provider: 'claude' }));
    settings.reorderRelative.mockResolvedValue({ success: true });
    parseJsonBody.mockResolvedValue({ chatId: 'z', chatIdBelow: 'x' });

    const request = new Request('http://localhost/api/chats/reorder-quick', { method: 'POST' });
    const response = await handler(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(settings.reorderRelative).toHaveBeenCalledWith('z', 'x', 'above');
  });

  it('handles malformed JSON', async () => {
    parseJsonBody.mockRejectedValue(new Error('Malformed JSON'));

    const request = new Request('http://localhost/api/chats/reorder-quick', { method: 'POST' });
    const response = await handler(request);
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe('Malformed JSON');
  });
});
