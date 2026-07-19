import { describe, expect, it, mock } from 'bun:test';

mock.module('../../chats/title-generator.js', () => ({
  maybeGenerateChatTitle: mock(() => Promise.resolve(undefined)),
}));

mock.module('../../chats/fork-chat.js', () => ({
  forkChatFileCopy: mock(() => Promise.resolve({})),
}));

import createChatRoutes from '../chats.js';
import { createRouteCommandLedger, createRouteCommandService } from './chat-routes-test-utils.js';

function createRoutesFixture({ unavailableProjectPaths = [], lastActivityAtByChat = {} } = {}) {
  const sessions = {
    c1: {
      agentId: 'claude',
      agentSessionId: 's1',
      projectPath: '/tmp/project',
      nativePath: null,
      tags: [],
      model: 'sonnet',
    },
    c2: {
      agentId: 'codex',
      agentSessionId: 's2',
      projectPath: '/tmp/other-project',
      nativePath: null,
      tags: [],
      model: 'gpt',
    },
  };
  const registry = {
    getChat: mock((chatId) => sessions[chatId] ?? null),
    addChat: mock(() => true),
    updateChat: mock(() => null),
    removeChat: mock(() => true),
    listAllChats: mock(() => sessions),
  };
  const settings = {
    getPinnedChatIds: mock(() => []),
    getNormalChatIds: mock(() => []),
    getArchivedChatIds: mock(() => []),
    getChatName: mock(() => null),
    recordChatStartup: mock(async () => undefined),
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
    reserveDirectTurn: mock((chatId) => ({
      chatId,
      reservationId: 'reservation-1',
      executionAdmission: {
        signal: new AbortController().signal,
        markStarted() {},
      },
    })),
    releaseDirectTurn: mock(async () => undefined),
    completeDirectTurn: mock(async () => undefined),
    failDirectTurn: mock(async () => undefined),
    runReservedTurn: mock(async () => undefined),
    abortForChatDeletion: mock(async () => true),
    triggerDrain: mock(async () => undefined),
    readChatExecutionControl: mock(async () => ({ entries: [], pause: null, version: 0 })),
    enqueueChat: mock(async () => ({ entry: { id: 'entry-1' }, queue: { entries: [], pause: null, version: 1 } })),
    dequeueChat: mock(async () => ({ entries: [], pause: null, version: 2 })),
    clearChatQueue: mock(async () => ({ entries: [], pause: null, version: 2 })),
    pauseChatQueue: mock(async () => ({ entries: [], pause: null, version: 2 })),
    resumeChatQueue: mock(async () => ({ entries: [], pause: null, version: 3 })),
  };
  const unavailablePaths = new Set(unavailableProjectPaths);
  const pathCache = {
    resolveProjectPaths: mock(async (projectPaths) => new Map(
      projectPaths.map((projectPath) => [projectPath, {
        available: !unavailablePaths.has(projectPath),
        effectiveProjectKey: unavailablePaths.has(projectPath) ? null : projectPath,
      }]),
    )),
  };
  const metadata = {
    listAllChatMetadata: mock(() => new Map()),
    getChatMetadata: mock(() => null),
    addNewChatMetadata: mock(() => undefined),
  };
  const chatViews = {
    getOrCreatePage: mock(async () => ({
      messages: [],
      generationId: 'generation-1',
      lastSeq: 0,
      pageOldestSeq: 0,
      hasMore: false,
    })),
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
    reconcileRetainedHistory: mock(async () => undefined),
    reconcileNativeHistory: mock(async () => undefined),
    listForChat: mock(() => []),
    hasInFlightForChat: mock(() => false),
    clearChat: mock(() => undefined),
  };
  const searchIndex = {
    search: mock((request) => ({
      results: request.allowedChatIds.length > 0 ? [
        {
          chatId: request.allowedChatIds[0],
          score: 1,
          matchedMessageCount: 1,
          snippets: [],
        },
      ] : [],
      index: { indexedChatCount: request.allowedChatIds.length, pendingChatCount: 0 },
    })),
  };
  const chatListProjector = {
    buildMany: mock(async (entries, statuses) => new Map(
      entries.flatMap(([chatId, session]) => {
        const status = statuses.get(session.projectPath);
        return status?.available && status.effectiveProjectKey ? [[chatId, {
          id: chatId,
          activity: {
            createdAt: null,
            lastActivityAt: lastActivityAtByChat[chatId] ?? null,
            lastReadAt: null,
          },
        }]] : [];
      }),
    )),
  };
  const commandLedger = createRouteCommandLedger('chats-search');
  const routes = createChatRoutes({
    registry,
    settings,
    queue,
    pathCache,
    metadata,
    chatViews,
    agents,
    pendingInputs,
    searchIndex,
    chatListProjector,
    commandService: createRouteCommandService({
      registry,
      queue,
      settings,
      metadata,
      agents,
      commandLedger,
      pendingInputs,
    }),
  });

  return { routes, searchIndex };
}

async function postSearch(routes, body) {
  const request = new Request('http://localhost/api/v1/chats/search', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
  const url = new URL(request.url);
  return routes['/api/v1/chats/search'].POST(request, url);
}

describe('POST /api/v1/chats/search', () => {
  it('searches only requested chats that still exist in the registry', async () => {
    const { routes, searchIndex } = createRoutesFixture();

    const response = await postSearch(routes, {
      query: 'needle',
      textTokens: ['needle'],
      chatIds: ['c2', 'missing'],
      limit: 5,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      query: 'needle',
      total: 1,
      index: { indexedChatCount: 1, pendingChatCount: 0 },
    });
    expect(searchIndex.search).toHaveBeenCalledWith({
      query: 'needle',
      textTokens: ['needle'],
      allowedChatIds: ['c2'],
      limit: 5,
    });
  });

  it('excludes chats whose project paths are unavailable', async () => {
    const { routes, searchIndex } = createRoutesFixture({
      unavailableProjectPaths: ['/tmp/other-project'],
    });

    const response = await postSearch(routes, {
      query: 'needle',
      chatIds: ['c1', 'c2'],
    });

    expect(response.status).toBe(200);
    expect(searchIndex.search).toHaveBeenCalledWith(expect.objectContaining({
      allowedChatIds: ['c1'],
    }));
  });

  it('searches all visible chats when chatIds is omitted', async () => {
    const { routes, searchIndex } = createRoutesFixture();

    const response = await postSearch(routes, { query: 'needle' });

    expect(response.status).toBe(200);
    expect(searchIndex.search).toHaveBeenCalledWith(expect.objectContaining({
      allowedChatIds: ['c1', 'c2'],
    }));
  });

  it('orders default search candidates by recent activity', async () => {
    const { routes, searchIndex } = createRoutesFixture({
      lastActivityAtByChat: {
        c1: '2026-01-01T00:00:00.000Z',
        c2: '2026-07-01T00:00:00.000Z',
      },
    });

    const response = await postSearch(routes, { query: 'needle' });

    expect(response.status).toBe(200);
    expect(searchIndex.search).toHaveBeenCalledWith(expect.objectContaining({
      allowedChatIds: ['c2', 'c1'],
    }));
  });

  it('searches no chats when chatIds is explicitly empty', async () => {
    const { routes, searchIndex } = createRoutesFixture();

    const response = await postSearch(routes, { query: 'needle', chatIds: [] });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ total: 0 });
    expect(searchIndex.search).toHaveBeenCalledWith(expect.objectContaining({
      allowedChatIds: [],
    }));
  });

  it('rejects empty search requests', async () => {
    const { routes } = createRoutesFixture();

    const response = await postSearch(routes, { query: '   ' });

    expect(response.status).toBe(400);
  });

  it('rejects search inputs that exceed bounded parsing limits', async () => {
    const { routes, searchIndex } = createRoutesFixture();
    const requests = [
      { query: 'x'.repeat(4_097) },
      { textTokens: Array(17).fill('token') },
      { query: Array(33).fill('word').join(' ') },
      { textTokens: Array(16).fill('one two three') },
      { query: 'needle', chatIds: Array(10_001).fill('c1') },
    ];

    for (const request of requests) {
      const response = await postSearch(routes, request);
      expect(response.status).toBe(400);
    }
    expect(searchIndex.search).not.toHaveBeenCalled();
  });

  it('returns a non-retryable disabled response', async () => {
    const { routes, searchIndex } = createRoutesFixture();
    const error = Object.assign(new Error('Transcript search is disabled'), {
      code: 'TRANSCRIPT_SEARCH_DISABLED',
      retryable: false,
    });
    searchIndex.search.mockImplementation(() => Promise.reject(error));

    const response = await postSearch(routes, { query: 'needle' });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      errorCode: 'TRANSCRIPT_SEARCH_DISABLED',
      retryable: false,
    });
  });

  it('returns retryable unavailable and busy responses', async () => {
    const { routes, searchIndex } = createRoutesFixture();
    for (const code of ['SEARCH_INDEX_UNAVAILABLE', 'SEARCH_INDEX_BUSY']) {
      searchIndex.search.mockImplementationOnce(() => Promise.reject(Object.assign(
        new Error('Search is not ready'),
        { code, retryable: true },
      )));
      const response = await postSearch(routes, { query: 'needle' });
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({ errorCode: code, retryable: true });
    }
  });
});
