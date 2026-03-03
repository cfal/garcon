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

mock.module('../../chats/fork-chat.js', () => ({
  forkChatFileCopy: mock(() => undefined),
}));

import createChatRoutes from '../chats.js';
import { parseJsonBody } from '../../lib/http-native.js';
import { forkChatFileCopy } from '../../chats/fork-chat.js';

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
  registry.getChat, parseJsonBody, forkChatFileCopy,
];

describe('POST /api/v1/chats/fork', () => {
  const handler = chatsRoutes['/api/v1/chats/fork'].POST;

  beforeEach(() => {
    allMocks.forEach(m => m.mockClear());
  });

  it('returns 400 for missing sourceChatId', async () => {
    parseJsonBody.mockResolvedValue({ chatId: '200' });

    const request = new Request('http://localhost/api/v1/chats/fork', { method: 'POST' });
    const response = await handler(request);
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error).toContain('sourceChatId');
  });

  it('returns 400 for non-numeric sourceChatId', async () => {
    parseJsonBody.mockResolvedValue({ sourceChatId: 'abc', chatId: '200' });

    const request = new Request('http://localhost/api/v1/chats/fork', { method: 'POST' });
    const response = await handler(request);
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.success).toBe(false);
  });

  it('returns 400 for missing chatId', async () => {
    parseJsonBody.mockResolvedValue({ sourceChatId: '100' });

    const request = new Request('http://localhost/api/v1/chats/fork', { method: 'POST' });
    const response = await handler(request);
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error).toContain('chatId');
  });

  it('returns 400 when sourceChatId equals chatId', async () => {
    parseJsonBody.mockResolvedValue({ sourceChatId: '100', chatId: '100' });

    const request = new Request('http://localhost/api/v1/chats/fork', { method: 'POST' });
    const response = await handler(request);
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error).toContain('differ');
  });

  it('returns 404 when source chat not found', async () => {
    parseJsonBody.mockResolvedValue({ sourceChatId: '100', chatId: '200' });
    registry.getChat.mockReturnValue(null);

    const request = new Request('http://localhost/api/v1/chats/fork', { method: 'POST' });
    const response = await handler(request);
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.success).toBe(false);
    expect(body.error).toContain('not found');
  });

  it('returns 422 for unsupported provider', async () => {
    parseJsonBody.mockResolvedValue({ sourceChatId: '100', chatId: '200' });
    registry.getChat.mockImplementation((id) => {
      if (id === '100') return { provider: 'opencode', projectPath: '/proj' };
      return null;
    });

    const request = new Request('http://localhost/api/v1/chats/fork', { method: 'POST' });
    const response = await handler(request);
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body.success).toBe(false);
    expect(body.error).toContain('opencode');
  });

  it('returns 409 when target chat already exists', async () => {
    parseJsonBody.mockResolvedValue({ sourceChatId: '100', chatId: '200' });
    registry.getChat.mockImplementation((id) => {
      if (id === '100') return { provider: 'claude', projectPath: '/proj' };
      if (id === '200') return { provider: 'claude', projectPath: '/proj' };
      return null;
    });

    const request = new Request('http://localhost/api/v1/chats/fork', { method: 'POST' });
    const response = await handler(request);
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.success).toBe(false);
    expect(body.error).toContain('already exists');
  });

  it('returns 200 on successful fork', async () => {
    parseJsonBody.mockResolvedValue({ sourceChatId: '100', chatId: '200' });
    registry.getChat.mockImplementation((id) => {
      if (id === '100') return { provider: 'claude', projectPath: '/proj' };
      return null;
    });
    forkChatFileCopy.mockResolvedValue({
      sourceChatId: '100',
      chatId: '200',
      provider: 'claude',
      providerSessionId: 'new-uuid',
      nativePath: '/tmp/new-uuid.jsonl',
    });

    const request = new Request('http://localhost/api/v1/chats/fork', { method: 'POST' });
    const response = await handler(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.sourceChatId).toBe('100');
    expect(body.chatId).toBe('200');
    expect(body.provider).toBe('claude');
  });

  it('returns 400 for malformed JSON', async () => {
    parseJsonBody.mockRejectedValue(new Error('Malformed JSON'));

    const request = new Request('http://localhost/api/v1/chats/fork', { method: 'POST' });
    const response = await handler(request);
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe('Malformed JSON');
  });

  it('returns 500 for unexpected errors', async () => {
    parseJsonBody.mockResolvedValue({ sourceChatId: '100', chatId: '200' });
    registry.getChat.mockImplementation((id) => {
      if (id === '100') return { provider: 'claude', projectPath: '/proj' };
      return null;
    });
    forkChatFileCopy.mockRejectedValue(new Error('Disk full'));

    const request = new Request('http://localhost/api/v1/chats/fork', { method: 'POST' });
    const response = await handler(request);
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.success).toBe(false);
    expect(body.error).toBe('Disk full');
  });
});

