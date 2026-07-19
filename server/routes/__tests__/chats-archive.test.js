import { describe, it, expect, beforeEach, mock } from 'bun:test';

class MalformedJsonError extends Error {
  constructor() { super('Malformed JSON'); this.name = 'MalformedJsonError'; }
}

const parseJsonBody = mock(() => undefined);

mock.module('../../lib/http-request.js', () => ({
  parseJsonBody,
  MalformedJsonError,
}));

mock.module('../../chats/title-generator.js', () => ({
  maybeGenerateChatTitle: mock(() => Promise.resolve(undefined)),
  generateChatTitleFromMessage: mock(() => Promise.resolve({ chatId: '123', title: 'Generated Title' })),
  TitleGenerationError: class TitleGenerationError extends Error {},
}));

import createChatRoutes from '../chats.js';
import { createRouteChatListProjector, createRouteCommandLedger, createRouteCommandService, createRoutePathCache, createRoutePendingInputs } from './chat-routes-test-utils.js';

const CHAT_ID = '1783725900000600';
const CHAT_ID_2 = '1783725900000601';
const CHAT_ID_3 = '1783725900000602';
const chat = () => ({
  agentId: 'claude',
  agentSessionId: null,
  nativeSession: null,
  agentOwnershipEpoch: 'epoch-1',
  agentSettingsById: { claude: { ownerId: 'claude', schemaVersion: 1, values: {} } },
  projectPath: '/proj',
  tags: [],
  model: 'opus',
  permissionMode: 'default',
  thinkingMode: 'none',
});

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
  getPinnedChatIds: mock(() => []),
  getNormalChatIds: mock(() => []),
  getArchivedChatIds: mock(() => []),
  removeFromAllOrderLists: mock(() => Promise.resolve(undefined)),
  insertNormalChatIdTop: mock(() => Promise.resolve(undefined)),
  ensureInNormal: mock(() => Promise.resolve(undefined)),
  togglePin: mock(() => Promise.resolve({ isPinned: true })),
  toggleArchive: mock(() => Promise.resolve({ isArchived: true })),
};
const queue = { deleteChatQueueFile: mock(() => Promise.resolve(undefined)) };
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
  startSession: mock(() => undefined),
  isAgentSessionRunning: mock(() => false),
};

const commandLedger = createRouteCommandLedger('chats-archive');
const pendingInputs = createRoutePendingInputs();
const chatListProjector = createRouteChatListProjector({ registry, settings, metadata, agents, pathCache });

const chatsRoutes = createChatRoutes({
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
    expect(body.error).toBe('chatId is required');
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
    registry.getChat.mockImplementation(() => ({ agentId: 'claude', projectPath: '/proj' }));
    settings.toggleArchive.mockImplementation(() => Promise.resolve({ isArchived: true }));
    parseJsonBody.mockImplementationOnce(() => ({ chatId: '500' }));

    const url = new URL('http://localhost/api/chats/archive');
    const request = new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"chatId":"500"}' });

    const response = await handler(request, url);
    const body = await response.json();

    expect(body.success).toBe(true);
    expect(body.isArchived).toBe(true);
    expect(settings.toggleArchive).toHaveBeenCalledWith('500');
  });

  it('keeps query chatId compatibility when unarchiving', async () => {
    registry.getChat.mockImplementation(() => ({ agentId: 'claude', projectPath: '/proj' }));
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
    registry.getChat.mockImplementation(() => ({ agentId: 'claude', projectPath: '/proj' }));
    settings.togglePin.mockImplementation(() => Promise.resolve({ isPinned: true }));
    parseJsonBody.mockImplementationOnce(() => ({ chatId: '500' }));

    const url = new URL('http://localhost/api/chats/pin');
    const request = new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"chatId":"500"}' });

    const response = await handler(request, url);
    const body = await response.json();

    expect(body.success).toBe(true);
    expect(body.isPinned).toBe(true);
    expect(settings.togglePin).toHaveBeenCalledWith('500');
  });

  it('keeps query chatId compatibility when unpinning', async () => {
    registry.getChat.mockImplementation(() => ({ agentId: 'claude', projectPath: '/proj' }));
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
      [CHAT_ID]: chat(),
    }));
    metadata.listAllChatMetadata.mockImplementation(() => new Map());
    settings.getChatName.mockImplementation(() => null);
    settings.getPinnedChatIds.mockImplementation(() => []);
    settings.getNormalChatIds.mockImplementation(() => []);
    settings.getArchivedChatIds.mockImplementation(() => [CHAT_ID]);

    const response = await handler();
    const body = await response.json();

    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0].isArchived).toBe(true);
  });

  it('returns sessions in pinned, normal, archived order', async () => {
    registry.listAllChats.mockImplementation(() => ({
      [CHAT_ID]: chat(),
      [CHAT_ID_2]: chat(),
      [CHAT_ID_3]: chat(),
    }));
    metadata.listAllChatMetadata.mockImplementation(() => new Map());
    settings.getChatName.mockImplementation(() => null);
    settings.getPinnedChatIds.mockImplementation(() => [CHAT_ID_3]);
    settings.getNormalChatIds.mockImplementation(() => [CHAT_ID_2]);
    settings.getArchivedChatIds.mockImplementation(() => [CHAT_ID]);

    const response = await handler();
    const body = await response.json();

    expect(body.sessions).toHaveLength(3);
    expect(body.sessions[0].id).toBe(CHAT_ID_3);
    expect(body.sessions[0].isPinned).toBe(true);
    expect(body.sessions[1].id).toBe(CHAT_ID_2);
    expect(body.sessions[1].isPinned).toBe(false);
    expect(body.sessions[1].isArchived).toBe(false);
    expect(body.sessions[2].id).toBe(CHAT_ID);
    expect(body.sessions[2].isArchived).toBe(true);
  });
});
