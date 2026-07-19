import { describe, it, expect, beforeEach, mock } from 'bun:test';
import createChatRoutes from '../chats.js';
import { InMemoryLastSelectedChatState } from '../../chats/last-selected-chat-state.ts';
import { createRouteChatListProjector } from './chat-routes-test-utils.js';

const CHAT_ID = '1783725900000800';

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
    abortForChatDeletion: mock(() => Promise.resolve(false)),
    deleteChatQueueFile: mock(() => Promise.resolve(undefined)),
  };
  const pathCache = {
    resolveProjectPath: mock((projectPath) => Promise.resolve({
      available: true,
      effectiveProjectKey: projectPath,
    })),
    resolveProjectPaths: mock((projectPaths) => Promise.resolve(new Map(
      projectPaths.map((projectPath) => [projectPath, {
        available: true,
        effectiveProjectKey: projectPath,
      }]),
    ))),
  };
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
    reconcileRetainedHistory: mock(() => Promise.resolve(undefined)),
    reconcileNativeHistory: mock(() => Promise.resolve(undefined)),
    listForChat: mock(() => []),
    hasInFlightForChat: mock(() => false),
    clearChat: mock(() => undefined),
  };
  const lastSelectedChat = new InMemoryLastSelectedChatState();
  const chatListProjector = createRouteChatListProjector({ registry, settings, metadata, agents, pathCache });
  const routes = createChatRoutes({
    registry,
    settings,
    queue,
    pathCache,
    metadata,
    chatViews,
    agents,
    pendingInputs,
    chatListProjector,
    commandService: {},
    lastSelectedChat,
  });

  return { agents, lastSelectedChat, metadata, pathCache, registry, routes, settings };
}

function chatEntry(projectPath = '/proj') {
  return {
    agentId: 'test-agent',
    agentSessionId: 'test-session',
    nativeSession: {
      ownerId: 'test-agent',
      schemaVersion: 1,
      value: { id: 'test-session' },
    },
    agentOwnershipEpoch: 'epoch-1',
    agentSettingsById: {
      'test-agent': {
        ownerId: 'test-agent',
        schemaVersion: 1,
        values: {},
      },
    },
    projectPath,
    tags: [],
    model: 'sonnet',
    permissionMode: 'default',
    thinkingMode: 'none',
  };
}

describe('last selected chat routes', () => {
  let fixture;

  beforeEach(() => {
    fixture = createFixture();
  });

  it('returns remembered chat id when it is visible', async () => {
    fixture.lastSelectedChat.setLastSelectedChatId(CHAT_ID);
    fixture.registry.listAllChats.mockImplementation(() => ({ [CHAT_ID]: chatEntry() }));
    fixture.settings.getNormalChatIds.mockImplementation(() => [CHAT_ID]);

    const response = await fixture.routes['/api/v1/chats'].GET();
    const body = await response.json();

    expect(body.lastSelectedChatId).toBe(CHAT_ID);
    expect(body.sessions).toHaveLength(1);
  });

  it('returns null when remembered chat is path-filtered but keeps memory', async () => {
    fixture.lastSelectedChat.setLastSelectedChatId(CHAT_ID);
    fixture.registry.listAllChats.mockImplementation(() => ({ [CHAT_ID]: chatEntry('/missing') }));
	fixture.pathCache.resolveProjectPaths.mockImplementation((projectPaths) => Promise.resolve(new Map(
		projectPaths.map((projectPath) => [projectPath, {
			available: false,
			effectiveProjectKey: null,
		}]),
	)));

    const response = await fixture.routes['/api/v1/chats'].GET();
    const body = await response.json();

    expect(body.lastSelectedChatId).toBeNull();
    expect(fixture.lastSelectedChat.getLastSelectedChatId()).toBe(CHAT_ID);
  });

  it('clears remembered chat when it no longer exists', async () => {
    fixture.lastSelectedChat.setLastSelectedChatId(CHAT_ID);
    fixture.registry.listAllChats.mockImplementation(() => ({}));

    const response = await fixture.routes['/api/v1/chats'].GET();
    const body = await response.json();

    expect(body.lastSelectedChatId).toBeNull();
    expect(fixture.lastSelectedChat.getLastSelectedChatId()).toBeNull();
  });

  it('updates remembered chat through PUT', async () => {
    fixture.registry.getChat.mockImplementation((id) => (id === CHAT_ID ? chatEntry() : null));

    const response = await fixture.routes['/api/v1/chats/last-selected'].PUT(
      new Request('http://localhost/api/v1/chats/last-selected', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId: CHAT_ID }),
      }),
    );
    const body = await response.json();

    expect(body).toEqual({ success: true, lastSelectedChatId: CHAT_ID });
    expect(fixture.lastSelectedChat.getLastSelectedChatId()).toBe(CHAT_ID);
  });

  it('clears remembered chat through PUT null', async () => {
    fixture.lastSelectedChat.setLastSelectedChatId(CHAT_ID);

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
});
