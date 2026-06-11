import { describe, expect, it, mock } from 'bun:test';

mock.module('../../chats/title-generator.js', () => ({
  maybeGenerateChatTitle: mock(() => Promise.resolve(undefined)),
}));

mock.module('../../chats/fork-chat.js', () => ({
  forkChatFileCopy: mock(() => Promise.resolve({})),
}));

import createChatRoutes from '../chats.js';
import { createRouteCommandLedger } from './chat-routes-test-utils.js';

function createRoutesFixture() {
  const registry = {
    getChat: mock(() => ({
      id: '123',
      agentId: 'claude',
      agentSessionId: 'provider-session-123',
      projectPath: '/tmp/project',
      nativePath: '/tmp/session.jsonl',
    })),
    addChat: mock(() => true),
    updateChat: mock(() => null),
    removeChat: mock(() => true),
    listAllChats: mock(() => ({})),
  };
  const settings = {
    getPinnedChatIds: mock(async () => []),
    getNormalChatIds: mock(async () => []),
    getArchivedChatIds: mock(async () => []),
    getChatName: mock(() => null),
    setLastChatDefaults: mock(async () => undefined),
    ensureInNormal: mock(async () => undefined),
    removeFromAllOrderLists: mock(async () => undefined),
    removeSessionName: mock(async () => undefined),
    togglePin: mock(async () => ({ isPinned: true })),
    toggleArchive: mock(async () => ({ isArchived: true })),
    reorderWindow: mock(async () => ({ success: true })),
    reorderRelative: mock(async () => ({ success: true })),
  };
  const queue = {
    deleteChatQueueFile: mock(async () => undefined),
    submit: mock(async () => undefined),
    registerPendingUserInput: mock(async () => undefined),
    runAcceptedTurn: mock(async () => undefined),
    abort: mock(async () => true),
    triggerDrain: mock(async () => undefined),
    readChatQueue: mock(async () => ({ entries: [], paused: false, version: 0 })),
    enqueueChat: mock(async () => ({ entry: { id: 'entry-1' }, queue: { entries: [], paused: false, version: 1 } })),
    dequeueChat: mock(async () => ({ entries: [], paused: false, version: 2 })),
    clearChatQueue: mock(async () => ({ entries: [], paused: false, version: 2 })),
    pauseChatQueue: mock(async () => ({ entries: [], paused: true, version: 2 })),
    resumeChatQueue: mock(async () => ({ entries: [], paused: false, version: 3 })),
  };
  const pathCache = { isProjectPathAvailable: mock(async () => true) };
  const metadata = {
    listAllChatMetadata: mock(() => new Map()),
    getChatMetadata: mock(() => null),
    addNewChatMetadata: mock(() => undefined),
  };
  const historyCache = {
    ensureLoaded: mock(async () => undefined),
    getPaginatedMessages: mock((chatId, limit, offset) => ({ messages: [], total: 0, hasMore: false, offset, limit })),
    appendMessages: mock(async () => undefined),
  };
  const agents = {
    hasAgent: mock(() => true),
    supportsFork: mock(() => true),
    supportsImages: mock(() => true),
    isAgentSessionRunning: mock(() => false),
    getRunningSessions: mock(() => ({ claude: [] })),
    startSession: mock(async () => undefined),
    modelSupportsImages: mock(async () => true),
    runSingleQuery: mock(async () => 'title'),
    resolvePermission: mock(() => undefined),
    updateSessionSettings: mock(async () => undefined),
  };
  const pendingInputs = {
    register: mock(async () => undefined),
    reconcile: mock(async () => undefined),
    listForChat: mock(() => []),
    clearChat: mock(() => undefined),
  };
  const routes = createChatRoutes({
    registry,
    settings,
    queue,
    pathCache,
    metadata,
    historyCache,
    agents,
    commandLedger: createRouteCommandLedger('chats-messages'),
    pendingInputs,
  });

  return { historyCache, pendingInputs, routes };
}

describe('GET /api/v1/chats/messages', () => {
  it('clamps pagination parameters before reading history', async () => {
    const { historyCache, pendingInputs, routes } = createRoutesFixture();
    const url = new URL('http://localhost/api/v1/chats/messages?chatId=123&limit=999999&offset=-10');

    const response = await routes['/api/v1/chats/messages'].GET(new Request(url), url);

    expect(response.status).toBe(200);
    expect(pendingInputs.reconcile).toHaveBeenCalledWith('123');
    expect(historyCache.getPaginatedMessages).toHaveBeenCalledWith('123', 200, 0);
  });
});
