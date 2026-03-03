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
  resolveMissingNativePath: mock(() => null),
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
  registry.getChat, registry.updateChat, metadata.getChatMetadata,
  registry.listAllChats, metadata.listAllChatMetadata, parseJsonBody,
  settings.getChatName, settings.getPinnedChatIds, settings.getNormalChatIds, settings.getArchivedChatIds,
];

describe('POST /api/chats/read', () => {
  const handler = chatsRoutes['/api/v1/chats/read'].POST;

  beforeEach(() => {
    allMocks.forEach(m => m.mockClear());
  });

  it('processes multiple entries', async () => {
    parseJsonBody.mockResolvedValue({
      entries: [
        { chatId: '100', lastReadAt: '2026-02-25T12:00:00.000Z' },
        { chatId: '200', lastReadAt: '2026-02-25T13:00:00.000Z' },
      ],
    });

    registry.getChat.mockImplementation((id) => {
      if (id === '100') return { provider: 'claude', projectPath: '/proj' };
      if (id === '200') return { provider: 'codex', projectPath: '/proj2' };
      return null;
    });
    registry.updateChat.mockResolvedValue({});

    const request = new Request('http://localhost/api/chats/read', { method: 'POST' });
    const response = await handler(request);
    const body = await response.json();

    expect(body.success).toBe(true);
    expect(body.results).toHaveLength(2);
    expect(body.results[0].chatId).toBe('100');
    expect(body.results[1].chatId).toBe('200');
  });

  it('skips unknown chats', async () => {
    parseJsonBody.mockResolvedValue({
      entries: [
        { chatId: '100', lastReadAt: '2026-02-25T12:00:00.000Z' },
        { chatId: 'unknown', lastReadAt: '2026-02-25T13:00:00.000Z' },
      ],
    });

    registry.getChat.mockImplementation((id) => {
      if (id === '100') return { provider: 'claude', projectPath: '/proj' };
      return null;
    });
    registry.updateChat.mockResolvedValue({});

    const request = new Request('http://localhost/api/chats/read', { method: 'POST' });
    const response = await handler(request);
    const body = await response.json();

    expect(body.results).toHaveLength(1);
    expect(body.results[0].chatId).toBe('100');
  });

  it('returns empty results for empty entries', async () => {
    parseJsonBody.mockResolvedValue({ entries: [] });

    const request = new Request('http://localhost/api/chats/read', { method: 'POST' });
    const response = await handler(request);
    const body = await response.json();

    expect(body.success).toBe(true);
    expect(body.results).toHaveLength(0);
  });

  it('defaults lastReadAt to a shared timestamp when absent', async () => {
    const before = new Date().toISOString();
    parseJsonBody.mockResolvedValue({
      entries: [
        { chatId: '100' },
        { chatId: '200' },
      ],
    });
    registry.getChat.mockImplementation((id) => {
      if (id === '100' || id === '200') return { provider: 'claude', projectPath: '/proj' };
      return null;
    });
    registry.updateChat.mockResolvedValue({});

    const request = new Request('http://localhost/api/chats/read', { method: 'POST' });
    const response = await handler(request);
    const body = await response.json();
    const after = new Date().toISOString();

    expect(body.results).toHaveLength(2);
    // Both entries share the same fallback timestamp.
    expect(body.results[0].lastReadAt).toBe(body.results[1].lastReadAt);
    expect(body.results[0].lastReadAt >= before).toBe(true);
    expect(body.results[0].lastReadAt <= after).toBe(true);
  });

  it('applies monotonic merge (newer wins)', async () => {
    const older = '2026-02-20T00:00:00.000Z';
    const newer = '2026-02-25T00:00:00.000Z';

    parseJsonBody.mockResolvedValue({
      entries: [{ chatId: '100', lastReadAt: newer }],
    });
    registry.getChat.mockReturnValue({ provider: 'claude', projectPath: '/proj', lastReadAt: older });
    registry.updateChat.mockResolvedValue({});

    const request = new Request('http://localhost/api/chats/read', { method: 'POST' });
    const response = await handler(request);
    const body = await response.json();

    expect(body.results[0].lastReadAt).toBe(newer);
    expect(registry.updateChat).toHaveBeenCalledWith('100', { lastReadAt: newer });
  });

  it('applies monotonic merge (older rejected)', async () => {
    const existing = '2026-02-25T00:00:00.000Z';
    const older = '2026-02-20T00:00:00.000Z';

    parseJsonBody.mockResolvedValue({
      entries: [{ chatId: '100', lastReadAt: older }],
    });
    registry.getChat.mockReturnValue({ provider: 'claude', projectPath: '/proj', lastReadAt: existing });
    registry.updateChat.mockResolvedValue({});

    const request = new Request('http://localhost/api/chats/read', { method: 'POST' });
    const response = await handler(request);
    const body = await response.json();

    expect(body.results[0].lastReadAt).toBe(existing);
  });

  it('does not include isUnread in mark-read response', async () => {
    const readAt = '2026-02-25T12:00:00.000Z';

    parseJsonBody.mockResolvedValue({
      entries: [{ chatId: '100', lastReadAt: readAt }],
    });
    registry.getChat.mockReturnValue({ provider: 'claude', projectPath: '/proj' });
    registry.updateChat.mockResolvedValue({});

    const request = new Request('http://localhost/api/chats/read', { method: 'POST' });
    const response = await handler(request);
    const body = await response.json();

    expect(body.results[0].chatId).toBe('100');
    expect(body.results[0].lastReadAt).toBe(readAt);
    expect(body.results[0].isUnread).toBeUndefined();
  });
});

describe('GET /api/chats includes read state', () => {
  const handler = chatsRoutes['/api/v1/chats'].GET;

  beforeEach(() => {
    allMocks.forEach(m => m.mockClear());
  });

  it('returns lastReadAt and isUnread in session response', async () => {
    registry.listAllChats.mockImplementation(() => ({
      '100': { provider: 'claude', projectPath: '/proj', tags: [], lastReadAt: '2026-02-25T10:00:00.000Z' },
    }));
    const metaMap = new Map();
    metaMap.set('100', {
      firstMessage: 'Hello',
      createdAt: null,
      lastActivity: '2026-02-25T12:00:00.000Z',
      lastMessage: '',
      lastReadAt: '2026-02-25T10:00:00.000Z',
    });
    metadata.listAllChatMetadata.mockImplementation(() => metaMap);
    settings.getChatName.mockImplementation(() => null);
    settings.getNormalChatIds.mockImplementation(() => Promise.resolve(['100']));

    const response = await handler();
    const body = await response.json();

    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0].activity.lastReadAt).toBe('2026-02-25T10:00:00.000Z');
    expect(body.sessions[0].isUnread).toBe(true);
  });

  it('returns isUnread false when fully read', async () => {
    registry.listAllChats.mockImplementation(() => ({
      '100': { provider: 'claude', projectPath: '/proj', tags: [], lastReadAt: '2026-02-25T13:00:00.000Z' },
    }));
    const metaMap = new Map();
    metaMap.set('100', {
      firstMessage: 'Hello',
      createdAt: null,
      lastActivity: '2026-02-25T12:00:00.000Z',
      lastMessage: '',
      lastReadAt: '2026-02-25T13:00:00.000Z',
    });
    metadata.listAllChatMetadata.mockImplementation(() => metaMap);
    settings.getChatName.mockImplementation(() => null);
    settings.getNormalChatIds.mockImplementation(() => Promise.resolve(['100']));

    const response = await handler();
    const body = await response.json();

    expect(body.sessions[0].isUnread).toBe(false);
  });

  it('returns isUnread false when no activity', async () => {
    registry.listAllChats.mockImplementation(() => ({
      '100': { provider: 'claude', projectPath: '/proj', tags: [] },
    }));
    metadata.listAllChatMetadata.mockImplementation(() => new Map());
    settings.getChatName.mockImplementation(() => null);
    settings.getNormalChatIds.mockImplementation(() => Promise.resolve(['100']));

    const response = await handler();
    const body = await response.json();

    expect(body.sessions[0].isUnread).toBe(false);
    expect(body.sessions[0].activity.lastReadAt).toBeNull();
  });

  it('returns permissionMode and thinkingMode in session response', async () => {
    registry.listAllChats.mockImplementation(() => ({
      '100': { provider: 'claude', projectPath: '/proj', tags: [], permissionMode: 'acceptEdits', thinkingMode: 'think-hard' },
    }));
    metadata.listAllChatMetadata.mockImplementation(() => new Map());
    settings.getChatName.mockImplementation(() => null);
    settings.getNormalChatIds.mockImplementation(() => Promise.resolve(['100']));

    const response = await handler();
    const body = await response.json();

    expect(body.sessions[0].permissionMode).toBe('acceptEdits');
    expect(body.sessions[0].thinkingMode).toBe('think-hard');
  });

  it('defaults permissionMode and thinkingMode for legacy sessions', async () => {
    registry.listAllChats.mockImplementation(() => ({
      '100': { provider: 'claude', projectPath: '/proj', tags: [] },
    }));
    metadata.listAllChatMetadata.mockImplementation(() => new Map());
    settings.getChatName.mockImplementation(() => null);
    settings.getNormalChatIds.mockImplementation(() => Promise.resolve(['100']));

    const response = await handler();
    const body = await response.json();

    expect(body.sessions[0].permissionMode).toBe('default');
    expect(body.sessions[0].thinkingMode).toBe('none');
  });
});

describe('GET /api/v1/chats/details', () => {
  const handler = chatsRoutes['/api/v1/chats/details'].GET;

  beforeEach(() => {
    allMocks.forEach(m => m.mockClear());
  });

  it('returns chat metadata and native path as a flat response', async () => {
    registry.getChat.mockReturnValue({
      provider: 'claude',
      projectPath: '/proj',
      nativePath: '/tmp/session.jsonl',
    });
    metadata.getChatMetadata.mockReturnValue({
      firstMessage: 'First line\nSecond line',
      createdAt: '2026-02-20T10:00:00.000Z',
      lastActivity: '2026-02-21T11:00:00.000Z',
    });

    const response = await handler(
      new Request('http://localhost/api/v1/chats/details?chatId=100'),
      new URL('http://localhost/api/v1/chats/details?chatId=100'),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      chatId: '100',
      firstMessage: 'First line\nSecond line',
      createdAt: '2026-02-20T10:00:00.000Z',
      lastActivityAt: '2026-02-21T11:00:00.000Z',
      nativePath: '/tmp/session.jsonl',
    });
  });

  it('returns 400 when chatId is missing', async () => {
    const response = await handler(
      new Request('http://localhost/api/v1/chats/details'),
      new URL('http://localhost/api/v1/chats/details'),
    );
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body.error).toBe('chatId query parameter is required');
  });

  it('returns 404 when chat is missing', async () => {
    registry.getChat.mockReturnValue(null);

    const response = await handler(
      new Request('http://localhost/api/v1/chats/details?chatId=404'),
      new URL('http://localhost/api/v1/chats/details?chatId=404'),
    );
    const body = await response.json();
    expect(response.status).toBe(404);
    expect(body.error).toBe('Session not found');
  });

  it('returns empty details fields when metadata is missing', async () => {
    registry.getChat.mockReturnValue({
      provider: 'claude',
      projectPath: '/proj',
      nativePath: '/tmp/session.jsonl',
    });
    metadata.getChatMetadata.mockReturnValue(null);

    const response = await handler(
      new Request('http://localhost/api/v1/chats/details?chatId=100'),
      new URL('http://localhost/api/v1/chats/details?chatId=100'),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      chatId: '100',
      firstMessage: '',
      createdAt: null,
      lastActivityAt: null,
      nativePath: '/tmp/session.jsonl',
    });
  });
});
