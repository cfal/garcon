import { describe, it, expect, beforeEach, mock } from 'bun:test';
import createChatRoutes from '../chats.js';
import { InMemoryLastSelectedChatState } from '../../chats/last-selected-chat-state.ts';
import { AUTHENTICATED_USERNAME_HEADER } from '../../lib/http-request.ts';

function createFixture() {
  const registry = {
    getChat: mock(() => undefined),
    addChat: mock(() => undefined),
    updateChat: mock(() => undefined),
    removeChat: mock(() => true),
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
    ensureInNormal: mock(() => Promise.resolve(undefined)),
    togglePin: mock(() => Promise.resolve({ isPinned: true })),
    toggleArchive: mock(() => Promise.resolve({ isArchived: true })),
    reorderWindow: mock(() => Promise.resolve({ success: true })),
    reorderRelative: mock(() => Promise.resolve({ success: true })),
  };
  const queue = {
    abort: mock(() => Promise.resolve(false)),
    deleteChatQueueFile: mock(() => Promise.resolve(undefined)),
  };
  const pathCache = { isProjectPathAvailable: mock(() => Promise.resolve(true)) };
  const metadata = {
    addNewChatMetadata: mock(() => undefined),
    listAllChatMetadata: mock(() => new Map()),
    getChatMetadata: mock(() => null),
  };
  const chatViews = {
    getOrCreatePage: mock(() => Promise.resolve({
      messages: [],
      generationId: 'generation-1',
      lastSeq: 0,
      pageOldestSeq: 0,
      hasMore: false,
    })),
  };
  const agents = {
    startSession: mock(() => undefined),
    isAgentSessionRunning: mock(() => false),
  };
  const pendingInputs = {
    register: mock(() => Promise.resolve(undefined)),
    reconcile: mock(() => Promise.resolve(undefined)),
    listForChat: mock(() => []),
    clearChat: mock(() => undefined),
  };
  const lastSelectedChat = new InMemoryLastSelectedChatState();
  const routes = createChatRoutes({
    registry,
    settings,
    queue,
    pathCache,
    metadata,
    chatViews,
    agents,
    pendingInputs,
    commandService: {},
    lastSelectedChat,
  });

  return { agents, lastSelectedChat, metadata, pathCache, registry, routes, settings };
}

function ownedRequest(url, username, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set(AUTHENTICATED_USERNAME_HEADER, username);
  return new Request(url, { ...init, headers });
}

function chatEntry(projectPath = '/proj', ownerUsername = null) {
  return {
    agentId: 'claude',
    projectPath,
    ownerUsername,
    tags: [],
    model: 'sonnet',
    permissionMode: 'default',
    thinkingMode: 'none',
    claudeThinkingMode: 'auto',
    ampAgentMode: 'smart',
  };
}

describe('last selected chat routes', () => {
  let fixture;

  beforeEach(() => {
    fixture = createFixture();
  });

  it('returns remembered chat id when it is visible', async () => {
    fixture.lastSelectedChat.setLastSelectedChatId('100');
    fixture.registry.listAllChats.mockImplementation(() => ({ '100': chatEntry() }));
    fixture.settings.getNormalChatIds.mockImplementation(() => ['100']);

    const response = await fixture.routes['/api/v1/chats'].GET();
    const body = await response.json();

    expect(body.lastSelectedChatId).toBe('100');
    expect(body.sessions).toHaveLength(1);
  });

  it('returns null when remembered chat is path-filtered but keeps memory', async () => {
    fixture.lastSelectedChat.setLastSelectedChatId('100');
    fixture.registry.listAllChats.mockImplementation(() => ({ '100': chatEntry('/missing') }));
    fixture.pathCache.isProjectPathAvailable.mockImplementation(() => Promise.resolve(false));

    const response = await fixture.routes['/api/v1/chats'].GET();
    const body = await response.json();

    expect(body.lastSelectedChatId).toBeNull();
    expect(fixture.lastSelectedChat.getLastSelectedChatId()).toBe('100');
  });

  it('clears remembered chat when it no longer exists', async () => {
    fixture.lastSelectedChat.setLastSelectedChatId('100');
    fixture.registry.listAllChats.mockImplementation(() => ({}));

    const response = await fixture.routes['/api/v1/chats'].GET();
    const body = await response.json();

    expect(body.lastSelectedChatId).toBeNull();
    expect(fixture.lastSelectedChat.getLastSelectedChatId()).toBeNull();
  });

  it('updates remembered chat through PUT', async () => {
    fixture.registry.getChat.mockImplementation((id) => (id === '100' ? chatEntry() : null));

    const response = await fixture.routes['/api/v1/chats/last-selected'].PUT(
      new Request('http://localhost/api/v1/chats/last-selected', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId: '100' }),
      }),
    );
    const body = await response.json();

    expect(body).toEqual({ success: true, lastSelectedChatId: '100' });
    expect(fixture.lastSelectedChat.getLastSelectedChatId()).toBe('100');
  });

  it('clears remembered chat through PUT null', async () => {
    fixture.lastSelectedChat.setLastSelectedChatId('100');

    const response = await fixture.routes['/api/v1/chats/last-selected'].PUT(
      new Request('http://localhost/api/v1/chats/last-selected', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId: null }),
      }),
    );
    const body = await response.json();

    expect(body).toEqual({ success: true, lastSelectedChatId: null });
    expect(fixture.lastSelectedChat.getLastSelectedChatId()).toBeNull();
  });

  it('rejects unknown and missing chat ids', async () => {
    fixture.registry.getChat.mockImplementation(() => null);

    const unknown = await fixture.routes['/api/v1/chats/last-selected'].PUT(
      new Request('http://localhost/api/v1/chats/last-selected', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId: '404' }),
      }),
    );
    const missing = await fixture.routes['/api/v1/chats/last-selected'].PUT(
      new Request('http://localhost/api/v1/chats/last-selected', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }),
    );

    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({ success: false, errorCode: 'SESSION_NOT_FOUND' });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({ success: false, errorCode: 'VALIDATION_FAILED' });
  });

  it('filters chat list and last selected state by authenticated owner', async () => {
    fixture.lastSelectedChat.setLastSelectedChatId('alice-chat', 'alice');
    fixture.lastSelectedChat.setLastSelectedChatId('bob-chat', 'bob');
    fixture.registry.listAllChats.mockImplementation(() => ({
      'alice-chat': chatEntry('/alice', 'alice'),
      'bob-chat': chatEntry('/bob', 'bob'),
    }));
    fixture.settings.getNormalChatIds.mockImplementation(() => ['alice-chat', 'bob-chat']);

    const response = await fixture.routes['/api/v1/chats'].GET(
      ownedRequest('http://localhost/api/v1/chats', 'alice'),
    );
    const body = await response.json();

    expect(body.lastSelectedChatId).toBe('alice-chat');
    expect(body.sessions.map((session) => session.id)).toEqual(['alice-chat']);
  });

  it('rejects last-selected writes for another owner', async () => {
    fixture.registry.getChat.mockImplementation((id) => (
      id === 'bob-chat' ? chatEntry('/bob', 'bob') : null
    ));

    const response = await fixture.routes['/api/v1/chats/last-selected'].PUT(
      ownedRequest('http://localhost/api/v1/chats/last-selected', 'alice', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId: 'bob-chat' }),
      }),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ success: false, errorCode: 'SESSION_NOT_FOUND' });
    expect(fixture.lastSelectedChat.getLastSelectedChatId('alice')).toBeNull();
  });
});
