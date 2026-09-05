import { describe, expect, it, mock } from 'bun:test';

import createChatRoutes from '../chats.js';
import { TranscriptSearchUnavailableError } from '../../chats/search/errors.js';
import { createRouteCommandLedger, createRouteCommandService } from './chat-routes-test-utils.js';

function createRoutesFixture({
  unavailableProjectPaths = [],
  lastActivityAtByChat = {},
  createdAtByChat = {},
  withoutSearchIndex = false,
} = {}) {
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
    hasChat: mock((chatId) => chatId in sessions),
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
  reorderChat: mock(async () => ({
    success: true,
    response: { success: true, chatId: 'chat', orderGroup: 'normal', changed: true },
  })),
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
    readChatExecutionControl: mock(async () => ({
      entries: [],
      controlEntries: [],
      pause: null,
      version: 0,
    })),
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
    page: mock(async () => ({
      transcriptViewId: 'view-1',
      messages: [],
      lastOrdinal: 0,
      pageOldestOrdinal: 0,
      pageNewestOrdinal: 0,
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
  const searchIndex = {
    catalogMayHaveChanged: mock(() => undefined),
    validateResultView: mock(() => true),
    status: mock(() => ({
      version: 1,
      phase: 'rebuilding',
      chats: { total: 3, indexed: 1, pending: 1, failed: 0, unindexed: 1 },
      queuedJobs: 1,
      resync: { completedChats: 1, totalChats: 2 },
      backlogRows: 5,
      activeChat: { position: 3, total: 8 },
      lastErrorCode: null,
      updatedAt: '2026-08-19T00:00:00.000Z',
    })),
    queryStats: mock(() => ({
      served: 7,
      timedOut: 1,
      rejectedBusy: 2,
      p50Ms: 10,
      p95Ms: 30,
      maxMs: 40,
    })),
    search: mock((request) => ({
      results: request.allowedChatIds.length > 0 ? [
        {
          chatId: request.allowedChatIds[0],
          transcriptViewId: 'view-1',
          score: 1,
          matchedMessageCount: 1,
          snippets: [],
        },
      ] : [],
      page: {
        offset: request.offset,
        limit: request.limit ?? 20,
        total: request.allowedChatIds.length > 0 ? 1 : 0,
        hasMore: false,
        nextOffset: null,
      },
      index: {
        indexedChatCount: request.allowedChatIds.length,
        pendingChatCount: 0,
        failedChatCount: 0,
        unindexedChatCount: 0,
        unsupportedChatCount: 0,
        resultsTruncated: false,
      },
    })),
  };
  const chatListProjector = {
    buildMany: mock(async (entries, statuses) => new Map(
      entries.flatMap(([chatId, session]) => {
        const status = statuses.get(session.projectPath);
        return status?.available && status.effectiveProjectKey ? [[chatId, {
          id: chatId,
          activity: {
            createdAt: createdAtByChat[chatId] ?? null,
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
    processing: { phase: mock(() => null) },
    pathCache,
    metadata,
    chatViews,
    agents,
    searchIndex: withoutSearchIndex ? undefined : searchIndex,
    chatListProjector,
    commandService: createRouteCommandService({
      registry,
      queue,
      settings,
      metadata,
      agents,
      commandLedger,
    }),
  });

  return { routes, searchIndex, registry, agents };
}

async function postSearch(routes, body, signal) {
  const request = new Request('http://localhost/api/v1/chats/search', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
    signal,
  });
  const url = new URL(request.url);
  return routes['/api/v1/chats/search'].POST(request, url);
}

async function getStatus(routes) {
  const request = new Request('http://localhost/api/v1/chats/search/status');
  const url = new URL(request.url);
  return routes['/api/v1/chats/search/status'].GET(request, url);
}

describe('POST /api/v1/chats/search', () => {
  it('[TLV5-SEARCH.11-ROUTE-01] forwards request cancellation to transcript search', async () => {
    const { routes, searchIndex } = createRoutesFixture();
    const abort = new AbortController();

    await postSearch(routes, { query: 'needle' }, abort.signal);
    const forwarded = searchIndex.search.mock.calls[0][0].signal;
    expect(forwarded).toBeInstanceOf(AbortSignal);
    expect(forwarded.aborted).toBe(false);

    abort.abort();
    expect(forwarded.aborted).toBe(true);
  });

  it('returns a quiet client-closed response for caller cancellation', async () => {
    const { routes, searchIndex } = createRoutesFixture();
    const abort = new AbortController();
    abort.abort();
    searchIndex.search.mockImplementationOnce(({ signal }) => signal.throwIfAborted());

    const response = await postSearch(routes, { query: 'needle' }, abort.signal);

    expect(response.status).toBe(499);
    expect(await response.text()).toBe('');
  });

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
      page: { offset: 0, limit: 5, total: 1, hasMore: false, nextOffset: null },
      index: { indexedChatCount: 1, pendingChatCount: 0 },
    });
    expect(searchIndex.search).toHaveBeenCalledWith({
      query: 'needle',
      textTokens: ['needle'],
      allowedChatIds: ['c2'],
      sort: 'relevance',
      offset: 0,
      limit: 5,
      signal: expect.any(AbortSignal),
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
      sort: 'relevance',
      offset: 0,
    }));
  });

  it('orders activity search candidates by recent activity', async () => {
    const { routes, searchIndex } = createRoutesFixture({
      lastActivityAtByChat: {
        c1: '2026-01-01T00:00:00.000Z',
        c2: '2026-07-01T00:00:00.000Z',
      },
    });

    const response = await postSearch(routes, { query: 'needle', sort: 'activity' });

    expect(response.status).toBe(200);
    expect(searchIndex.search).toHaveBeenCalledWith(expect.objectContaining({
      allowedChatIds: ['c2', 'c1'],
    }));
  });

  it('searches no chats when chatIds is explicitly empty', async () => {
    const { routes, searchIndex } = createRoutesFixture();

    const response = await postSearch(routes, { query: 'needle', chatIds: [] });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ page: { total: 0 } });
    expect(searchIndex.search).toHaveBeenCalledWith(expect.objectContaining({
      allowedChatIds: [],
    }));
  });

  it('orders explicit candidates by creation time and preserves page metadata', async () => {
    const { routes, searchIndex } = createRoutesFixture({
      createdAtByChat: {
        c1: '2026-01-01T00:00:00.000Z',
        c2: '2026-07-01T00:00:00.000Z',
      },
    });
    searchIndex.search.mockResolvedValueOnce({
      results: [],
      page: { offset: 50, limit: 50, total: 80, hasMore: true, nextOffset: 75 },
      index: {
        indexedChatCount: 2,
        pendingChatCount: 0,
        failedChatCount: 0,
        unindexedChatCount: 0,
        unsupportedChatCount: 0,
        resultsTruncated: false,
      },
    });
    const response = await postSearch(routes, {
      query: 'needle', chatIds: ['c1', 'missing', 'c2'], sort: 'created', offset: 50, limit: 50,
    });
    expect(response.status).toBe(200);
    expect(searchIndex.search).toHaveBeenCalledWith(expect.objectContaining({
      allowedChatIds: ['c2', 'c1'], sort: 'created', offset: 50, limit: 50,
    }));
    await expect(response.json()).resolves.toMatchObject({
      page: { offset: 50, limit: 50, total: 80, hasMore: true, nextOffset: 75 },
    });
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
      { query: 'needle', sort: 'oldest' },
      { query: 'needle', sort: [] },
      { query: 'needle', offset: -1 },
      { query: 'needle', offset: 1.5 },
      { query: 'needle', offset: '0' },
      { query: 'needle', offset: 10_000 },
      { query: 'needle', limit: -1 },
      { query: 'needle', limit: 0 },
      { query: 'needle', limit: 1.5 },
      { query: 'needle', limit: '50' },
      { query: 'needle', limit: 101 },
    ];

    for (const request of requests) {
      const response = await postSearch(routes, request);
      expect(response.status).toBe(400);
    }
    expect(searchIndex.search).not.toHaveBeenCalled();
  });

  it('returns a non-retryable disabled response', async () => {
    const { routes, searchIndex } = createRoutesFixture();
    const error = new TranscriptSearchUnavailableError(
      'TRANSCRIPT_SEARCH_DISABLED',
      'Transcript search is disabled',
      false,
    );
    searchIndex.search.mockImplementation(() => Promise.reject(error));

    const response = await postSearch(routes, { query: 'needle' });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      errorCode: 'TRANSCRIPT_SEARCH_DISABLED',
      retryable: false,
    });
  });

  it('[TLV5-SEARCH.09-ROUTE-02] returns distinct retryable search failures', async () => {
    const { routes, searchIndex } = createRoutesFixture();
    for (const code of ['SEARCH_TIMEOUT', 'SEARCH_INDEX_UNAVAILABLE', 'SEARCH_INDEX_BUSY']) {
      searchIndex.search.mockImplementationOnce(() => Promise.reject(
        new TranscriptSearchUnavailableError(code, 'Search is not ready', true),
      ));
      const response = await postSearch(routes, { query: 'needle' });
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({ errorCode: code, retryable: true });
    }
  });

  it('[TLV5-SEARCH.09-ROUTE-03] preserves committed-prefix results during indexing', async () => {
    const { routes, searchIndex } = createRoutesFixture();
    const result = {
      results: [{
        chatId: 'c1', transcriptViewId: 'view-1', score: 3,
        matchedMessageCount: 1, snippets: [],
      }],
      index: {
        indexedChatCount: 1,
        pendingChatCount: 1,
        failedChatCount: 0,
        unindexedChatCount: 0,
        unsupportedChatCount: 0,
        resultsTruncated: false,
      },
    };
    searchIndex.search.mockResolvedValueOnce(result);

    const response = await postSearch(routes, { query: 'needle', chatIds: ['c1', 'c2'] });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      results: result.results,
      index: result.index,
    });
  });
});

describe('GET /api/v1/chats/search/status', () => {
  it('[TLV5-SEARCH.09-ROUTE-01] returns exact status and query statistics', async () => {
    const { routes, searchIndex } = createRoutesFixture();

    const response = await getStatus(routes);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ...searchIndex.status(),
      queryStats: searchIndex.queryStats(),
    });
  });

  it('returns the stable disabled snapshot when search is not configured', async () => {
    const { routes } = createRoutesFixture({ withoutSearchIndex: true });

    const response = await getStatus(routes);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      version: 1,
      phase: 'disabled',
      chats: { total: 0, indexed: 0, pending: 0, failed: 0, unindexed: 0 },
      queryStats: { served: 0, timedOut: 0, rejectedBusy: 0 },
    });
  });
});

describe('POST /api/v1/chats/search/navigate', () => {
  const request = (overrides = {}) => ({
    chatId: 'c1',
    transcriptViewId: 'view-1',
    ordinal: 3,
    ...overrides,
  });

  async function navigate(fixture, body) {
    return fixture.routes['/api/v1/chats/search/navigate'].POST(
      new Request('http://localhost/api/v1/chats/search/navigate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
  }

  it('resolves a view-qualified ledger row', async () => {
    const fixture = createRoutesFixture();
    fixture.registry.getChat.mockImplementation(() => ({
      agentId: 'claude',
      agentSessionId: 's1',
      agentOwnershipEpoch: 'owner-1',
      carryOverSegments: [],
      projectPath: '/tmp/project',
      tags: [],
      model: 'sonnet',
    }));

    const response = await navigate(fixture, request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ chatId: 'c1', ordinal: 3 });
    expect(fixture.searchIndex.validateResultView)
      .toHaveBeenCalledWith('c1', 'view-1');
  });

  it('rejects a result whose transcript view was replaced', async () => {
    const fixture = createRoutesFixture();
    fixture.searchIndex.validateResultView.mockImplementation(() => false);

    const response = await navigate(fixture, request());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      errorCode: 'SEARCH_RESULT_STALE',
    });
  });

  it('validates the navigation payload', async () => {
    const fixture = createRoutesFixture();

    const response = await navigate(fixture, request({ ordinal: 0 }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      errorCode: 'VALIDATION_FAILED',
    });
  });
});
