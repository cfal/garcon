import { describe, expect, it, mock } from 'bun:test';
import { AgentIntegrationError } from '@garcon/server-agent-interface';
import { TRANSCRIPT_TEMPORARILY_UNAVAILABLE_MESSAGE } from '../../lib/domain-error.js';

mock.module('../../chats/title-generator.js', () => ({
  maybeGenerateChatTitle: mock(() => Promise.resolve(undefined)),
  generateChatTitleFromMessage: mock(() => Promise.resolve({ chatId: '123', title: 'Generated Title' })),
  TitleGenerationError: class TitleGenerationError extends Error {},
}));

mock.module('../../chats/fork-chat.js', () => ({
  forkChatFileCopy: mock(() => Promise.resolve({})),
}));

import createChatRoutes from '../chats.js';
import { createRouteChatListProjector, createRouteCommandLedger, createRouteCommandService, createRoutePathCache } from './chat-routes-test-utils.js';
import { ChatViewStore } from '../../chats/chat-view-store.js';
import { PendingUserInputService } from '../../chats/pending-user-input-service.js';
import { AssistantMessage, UserMessage } from '../../../common/chat-types.js';
import { CarryOverHistoryUnavailableError } from '../../chats/carryover-transcript-store.ts';
import { TranscriptHistoryUnavailableError } from '../../chats/errors.js';
import {
  historyPage,
  snapshotLoader,
  transcriptSnapshot,
} from '../../chats/__tests__/chat-transcript-test-helpers.js';

function createRoutesFixture(overrides = {}) {
  const registry = overrides.registry ?? {
    getChat: mock(() => ({
      id: '123',
      agentId: 'claude',
      agentSessionId: 'provider-session-123',
      agentOwnershipEpoch: 'epoch-1',
      carryOverSegments: [],
      carryOverMigrationQuarantine: null,
      nativeSeedReceipt: null,
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
	    readChatExecutionControl: mock(async () => ({ entries: [], recentlyDispatched: [], pause: null, reorderRevision: 0, version: 0, updatedAt: null })),
	    createChatQueueEntry: mock(async () => ({ entry: { id: 'entry-1' }, queue: { entries: [], recentlyDispatched: [], pause: null, reorderRevision: 0, version: 1, updatedAt: null } })),
	    replaceChatQueueEntry: mock(async () => ({ entry: { id: 'entry-1' }, queue: { entries: [], recentlyDispatched: [], pause: null, reorderRevision: 0, version: 1, updatedAt: null } })),
	    deleteChatQueueEntry: mock(async () => ({ entryId: 'entry-1', queue: { entries: [], recentlyDispatched: [], pause: null, reorderRevision: 0, version: 2, updatedAt: null } })),
	    deliverGoalControlInput: mock(async () => false),
	    clearChatQueue: mock(async () => ({ entries: [], recentlyDispatched: [], pause: null, reorderRevision: 0, version: 2, updatedAt: null })),
	    pauseChatQueue: mock(async () => ({ entries: [], recentlyDispatched: [], pause: null, reorderRevision: 0, version: 2, updatedAt: null })),
	    resumeChatQueue: mock(async () => ({ entries: [], recentlyDispatched: [], pause: null, reorderRevision: 0, version: 3, updatedAt: null })),
  };
  const pathCache = createRoutePathCache();
  const metadata = {
    listAllChatMetadata: mock(() => new Map()),
    getChatMetadata: mock(() => null),
    addNewChatMetadata: mock(() => undefined),
  };
  const chatViews = overrides.chatViews ?? {
    getOrCreatePage: mock(async (_chatId, limit, beforeSeq) => ({
      messages: [],
      generationId: 'generation-1',
      lastSeq: 0,
      pageOldestSeq: beforeSeq ?? 0,
      hasMore: false,
      limit,
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
  const pendingInputs = overrides.pendingInputs ?? {
    register: mock(async () => undefined),
    reconcileRetainedHistory: mock(async () => undefined),
    reconcileNativeHistory: mock(async () => undefined),
    listForChat: mock(() => []),
    listForTransport: mock(() => []),
    hasInFlightForChat: mock(() => false),
    clearChat: mock(() => undefined),
  };
  const commandLedger = createRouteCommandLedger('chats-messages');
  const chatListProjector = createRouteChatListProjector({ registry, settings, metadata, agents, pathCache });
  const searchIndex = overrides.searchIndex;
  const notifyHistoryChanged = overrides.notifyHistoryChanged ?? mock(() => undefined);
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
      ownership: overrides.ownership,
    }),
    ...(searchIndex === undefined ? {} : { searchIndex }),
    notifyHistoryChanged,
  });

  return {
    chatViews,
    pendingInputs,
    registry,
    routes,
    searchIndex,
    notifyHistoryChanged,
  };
}

describe('GET /api/v1/chats/messages', () => {
  it('clamps pagination parameters before reading history', async () => {
    const { chatViews, pendingInputs, routes } = createRoutesFixture();
    const url = new URL('http://localhost/api/v1/chats/messages?chatId=123&limit=999999&beforeSeq=10');

    const response = await routes['/api/v1/chats/messages'].GET(new Request(url), url);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      historyState: { kind: 'complete' },
      chatId: '123',
      generationId: 'generation-1',
      messages: [],
      lastSeq: 0,
      pageOldestSeq: 10,
      hasMore: false,
      limit: 200,
      pendingUserInputs: [],
    });
    expect(pendingInputs.reconcileRetainedHistory).toHaveBeenCalledWith('123');
    expect(chatViews.getOrCreatePage).toHaveBeenCalledWith('123', 200, 10);
  });

  it('returns degraded carryover history without claiming sequence metadata', async () => {
    const { pendingInputs, routes } = createRoutesFixture({
      chatViews: {
        getOrCreatePage: mock(async () => {
          throw new CarryOverHistoryUnavailableError({
            cause: new Error('private storage detail'),
          });
        }),
      },
    });
    const url = new URL('http://localhost/api/v1/chats/messages?chatId=123');

    const response = await routes['/api/v1/chats/messages'].GET(new Request(url), url);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      historyState: {
        kind: 'degraded',
        errorCode: 'CARRYOVER_HISTORY_UNAVAILABLE',
        retryable: false,
      },
      chatId: '123',
      messages: [],
    });
    expect(pendingInputs.reconcileRetainedHistory).not.toHaveBeenCalled();
  });

  it('rejects invalid beforeSeq values', async () => {
    const { chatViews, routes } = createRoutesFixture();
    const url = new URL('http://localhost/api/v1/chats/messages?chatId=123&beforeSeq=abc');

    const response = await routes['/api/v1/chats/messages'].GET(new Request(url), url);
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.errorCode).toBe('VALIDATION_FAILED');
    expect(body.error).toBe('beforeSeq must be a positive integer');
    expect(chatViews.getOrCreatePage).not.toHaveBeenCalled();
  });

  it('returns a typed deferred history state instead of an empty page', async () => {
    const { pendingInputs, routes } = createRoutesFixture({
      chatViews: {
        getOrCreatePage: mock(async () => {
          throw new TranscriptHistoryUnavailableError({
            kind: 'deferred',
            retry: 'execution-settled',
          });
        }),
      },
    });
    const url = new URL('http://localhost/api/v1/chats/messages?chatId=123');

    const response = await routes['/api/v1/chats/messages'].GET(new Request(url), url);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      historyState: { kind: 'deferred', retry: 'execution-settled' },
      chatId: '123',
      messages: [],
    });
    expect(pendingInputs.reconcileRetainedHistory).not.toHaveBeenCalled();
  });

  it('returns the projection store failure code as degraded history state', async () => {
    const { routes } = createRoutesFixture({
      chatViews: {
        getOrCreatePage: mock(async () => {
          throw new TranscriptHistoryUnavailableError({
            kind: 'degraded',
            errorCode: 'PROJECTION_REPAIR_REQUIRED',
            retryable: true,
          });
        }),
      },
    });
    const url = new URL('http://localhost/api/v1/chats/messages?chatId=123');

    const response = await routes['/api/v1/chats/messages'].GET(new Request(url), url);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      historyState: {
        kind: 'degraded',
        errorCode: 'PROJECTION_REPAIR_REQUIRED',
        retryable: true,
      },
      chatId: '123',
      messages: [],
    });
  });

  it('returns a retryable transcript error instead of an empty successful page', async () => {
    const failure = new AgentIntegrationError(
      'TRANSCRIPT_UNAVAILABLE',
      'Cannot open /home/private/.codex/sessions/rollout-secret.jsonl',
      true,
    );
    const { pendingInputs, routes } = createRoutesFixture({
      chatViews: {
        getOrCreatePage: mock(async () => {
          throw failure;
        }),
      },
    });
    const url = new URL('http://localhost/api/v1/chats/messages?chatId=123');

    const response = await routes['/api/v1/chats/messages'].GET(new Request(url), url);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: TRANSCRIPT_TEMPORARILY_UNAVAILABLE_MESSAGE,
      errorCode: 'TRANSCRIPT_UNAVAILABLE',
      retryable: true,
    });
    expect(pendingInputs.reconcileRetainedHistory).not.toHaveBeenCalled();
  });

  it('serves an unproven pending input across repeated reads without images', async () => {
    const history = [
      new AssistantMessage('2026-06-01T00:00:00.000Z', 'history-1'),
      new AssistantMessage('2026-06-01T00:00:01.000Z', 'history-2'),
    ];
    const views = new ChatViewStore(() => false, { messageLimit: 2 });
    // A foreign identity in the settled set never clears the live record.
    const settledInputRequests = mock(async () => new Set(['req-native']));
    const pendingInputs = new PendingUserInputService({
      settledInputRequests,
      nativelyBoundInputRequests: settledInputRequests,
    });
    await pendingInputs.register('123', 'pending', {
      clientRequestId: 'req-live',
      turnId: 'turn-live',
      createdAt: '2026-06-01T00:00:02.000Z',
      images: [{
        name: 'large.png',
        mimeType: 'image/png',
        data: `data:image/png;base64,${'a'.repeat(20_000)}`,
      }],
    });
    await views.getOrCreatePage('123', {
      loadAll: async () => transcriptSnapshot(history),
    }, 10);
    await pendingInputs.reconcileNativeHistory('123');
    const chatViews = {
      getOrCreatePage: (chatId, limit, beforeSeq) => views.getOrCreatePage(
        chatId,
        { loadAll: async () => transcriptSnapshot(history) },
        limit,
        beforeSeq,
      ),
    };
    const { routes } = createRoutesFixture({ chatViews, pendingInputs });
    const url = new URL('http://localhost/api/v1/chats/messages?chatId=123&limit=2');

    for (let request = 0; request < 3; request += 1) {
      const response = await routes['/api/v1/chats/messages'].GET(new Request(url), url);
      expect(response.status).toBe(200);
      const payload = await response.json();
      expect(payload).toMatchObject({
        pendingUserInputs: [{ clientRequestId: 'req-live' }],
      });
      expect(payload.pendingUserInputs[0]).not.toHaveProperty('images');
    }
  });
});

describe('POST /api/v1/chats/repair-history', () => {
  const chatId = '1783725900000200';
  const carryOverRevision = 'carry-v1:0';

  function request(body) {
    const url = new URL('http://localhost/api/v1/chats/repair-history');
    return {
      url,
      request: new Request(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    };
  }

  it('clears only the fenced receipt and invalidates search', async () => {
    const entry = {
      id: chatId,
      agentId: 'claude',
      agentSessionId: 'provider-session-123',
      agentOwnershipEpoch: 'epoch-1',
      carryOverSegments: [],
      carryOverMigrationQuarantine: null,
      nativeSeedReceipt: {
        agentSessionId: 'provider-session-123',
        placement: 'user-prefix',
        format: 'v2-xml',
        sha256: 'a'.repeat(64),
        codeUnitLength: 10,
      },
      projectPath: '/tmp/project',
    };
    const registry = {
      getChat: mock(() => entry),
      addChat: mock(() => true),
      updateChat: mock(async () => ({ ...entry, nativeSeedReceipt: null })),
      removeChat: mock(() => true),
      listAllChats: mock(() => ({})),
    };
    const searchIndex = { catalogMayHaveChanged: mock(() => undefined) };
    const { notifyHistoryChanged, routes } = createRoutesFixture({ registry, searchIndex });
    const input = request({
      action: 'accept-native',
      chatId,
      expectedCarryOverRevision: carryOverRevision,
      expectedAgentOwnershipEpoch: 'epoch-1',
    });

    const response = await routes['/api/v1/chats/repair-history'].POST(input.request, input.url);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      action: 'accept-native',
      chatId,
      receiptCleared: true,
    });
    expect(registry.updateChat).toHaveBeenCalledWith(
      chatId,
      { nativeSeedReceipt: null },
      { flush: true },
    );
    expect(searchIndex.catalogMayHaveChanged).toHaveBeenCalledWith(chatId);
    expect(notifyHistoryChanged).toHaveBeenCalledWith(chatId);
  });

  it('rejects a stale carryover revision or ownership epoch without mutation', async () => {
    const updateChat = mock(async () => null);
    const registry = {
      getChat: mock(() => ({
        id: chatId,
        agentId: 'claude',
        agentOwnershipEpoch: 'epoch-2',
        carryOverSegments: [],
        carryOverMigrationQuarantine: null,
        nativeSeedReceipt: null,
      })),
      addChat: mock(() => true),
      updateChat,
      removeChat: mock(() => true),
      listAllChats: mock(() => ({})),
    };
    const { routes } = createRoutesFixture({ registry });
    const input = request({
      action: 'accept-native',
      chatId,
      expectedCarryOverRevision: 'carry-v5:stale',
      expectedAgentOwnershipEpoch: 'epoch-1',
    });

    const response = await routes['/api/v1/chats/repair-history'].POST(input.request, input.url);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      errorCode: 'STALE_CHAT_OWNERSHIP',
      retryable: true,
    });
    expect(updateChat).not.toHaveBeenCalled();
  });

  it('retries abandoned transfer releases and reports content-free records', async () => {
    const retriedRecord = {
      operationId: 'op-1',
      chatId: 'chat-a',
      source: { agentId: 'claude' },
      lastErrorCode: null,
    };
    const unresolvedRecord = {
      operationId: 'op-2',
      chatId: 'chat-b',
      source: { agentId: 'codex' },
      lastErrorCode: 'SOURCE_UNAVAILABLE',
    };
    const ownership = {
      delete: mock(async () => true),
      abandonedTransferCleanups: mock(() => [unresolvedRecord]),
      retryRetainedTransferCleanups: mock(async () => ({
        retried: [retriedRecord, unresolvedRecord],
        unresolved: [unresolvedRecord],
      })),
    };
    const { routes } = createRoutesFixture({ ownership });
    const input = request({ action: 'retry-abandoned-release' });

    const response = await routes['/api/v1/chats/repair-history'].POST(input.request, input.url);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      action: 'retry-abandoned-release',
      retried: [
        { chatId: 'chat-a', agentId: 'claude', lastErrorCode: null },
        { chatId: 'chat-b', agentId: 'codex', lastErrorCode: 'SOURCE_UNAVAILABLE' },
      ],
      unresolved: [{ chatId: 'chat-b', agentId: 'codex', lastErrorCode: 'SOURCE_UNAVAILABLE' }],
    });
    expect(ownership.retryRetainedTransferCleanups).toHaveBeenCalledTimes(1);
  });

  it('rejects an unknown repair-history action', async () => {
    const { routes } = createRoutesFixture();
    const input = request({ action: 'rewrite-history', chatId });

    const response = await routes['/api/v1/chats/repair-history'].POST(input.request, input.url);

    expect(response.status).toBe(400);
  });
});
