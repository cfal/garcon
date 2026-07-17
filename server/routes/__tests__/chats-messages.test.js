import { describe, expect, it, mock } from 'bun:test';

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
import { ChatNativeReloader } from '../../chats/chat-native-reload.js';
import { ChatProcessErrorRecovery } from '../../chats/chat-process-error-recovery.js';
import { AssistantMessage, UserMessage } from '../../../common/chat-types.js';
import { transcriptRevision } from '../../lib/transcript-revision.js';

function createRoutesFixture(overrides = {}) {
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
    discardPendingUserInput: mock(() => true),
    reserveDirectTurn: mock((chatId) => ({ chatId, reservationId: 'reservation-1' })),
    releaseDirectTurn: mock(async () => undefined),
    runReservedTurn: mock(async () => undefined),
    abortForChatDeletion: mock(async () => true),
    triggerDrain: mock(async () => undefined),
	    readChatQueue: mock(async () => ({ entries: [], recentlyDispatched: [], pause: null, version: 0, updatedAt: null })),
	    createChatQueueEntry: mock(async () => ({ entry: { id: 'entry-1' }, queue: { entries: [], recentlyDispatched: [], pause: null, version: 1, updatedAt: null } })),
	    replaceChatQueueEntry: mock(async () => ({ entry: { id: 'entry-1' }, queue: { entries: [], recentlyDispatched: [], pause: null, version: 1, updatedAt: null } })),
	    deleteChatQueueEntry: mock(async () => ({ entryId: 'entry-1', queue: { entries: [], recentlyDispatched: [], pause: null, version: 2, updatedAt: null } })),
	    deliverActiveInput: mock(async () => false),
	    clearChatQueue: mock(async () => ({ entries: [], recentlyDispatched: [], pause: null, version: 2, updatedAt: null })),
	    pauseChatQueue: mock(async () => ({ entries: [], recentlyDispatched: [], pause: null, version: 2, updatedAt: null })),
	    resumeChatQueue: mock(async () => ({ entries: [], recentlyDispatched: [], pause: null, version: 3, updatedAt: null })),
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
    clearChat: mock(() => undefined),
  };
  const commandLedger = createRouteCommandLedger('chats-messages');
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

  return { chatViews, pendingInputs, routes };
}

describe('GET /api/v1/chats/messages', () => {
  it('clamps pagination parameters before reading history', async () => {
    const { chatViews, pendingInputs, routes } = createRoutesFixture();
    const url = new URL('http://localhost/api/v1/chats/messages?chatId=123&limit=999999&beforeSeq=10');

    const response = await routes['/api/v1/chats/messages'].GET(new Request(url), url);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
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

  it('bounds native full loads across repeated reads with an unresolved conflicting echo', async () => {
    const history = [
      new AssistantMessage('2026-06-01T00:00:00.000Z', 'history-1'),
      new AssistantMessage('2026-06-01T00:00:01.000Z', 'history-2'),
    ];
    const nativeMessages = [
      ...history,
      new UserMessage(
        '2026-06-01T00:00:02.000Z',
        'pending',
        undefined,
        { clientRequestId: 'req-native', turnId: 'turn-native' },
      ),
    ];
    const loadAll = mock(async () => nativeMessages);
    const loadPage = mock(async (limit, offset) => {
      const end = nativeMessages.length - offset;
      const start = Math.max(0, end - limit);
      return {
        messages: nativeMessages.slice(start, end),
        total: nativeMessages.length,
        hasMore: start > 0,
        offset,
        limit,
        revision: transcriptRevision(nativeMessages),
      };
    });
    const views = new ChatViewStore(() => false, { messageLimit: 2 });
    const pendingInputs = new PendingUserInputService({
      loadNativeMessages: loadAll,
      getRetainedHistoryMessages: (chatId) => views.getRetainedHistoryMessages(chatId),
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
    await views.appendAfterEnsuringGeneration(
      '123',
      async () => history,
      [new UserMessage(
        '2026-06-01T00:00:02.000Z',
        'pending',
        undefined,
        { clientRequestId: 'req-live', turnId: 'turn-live', deliveryStatus: 'accepted' },
      )],
    );
    await pendingInputs.reconcileNativeHistory('123');
    const chatViews = {
      getOrCreatePage: (chatId, limit, beforeSeq) => views.getOrCreatePage(
        chatId,
        { loadAll, loadPage },
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

    expect(loadAll).toHaveBeenCalledTimes(1);
    expect(loadPage).not.toHaveBeenCalled();
  });

  it('serves unmatched failed inputs after process-error native replacement', async () => {
    const nativeMessages = [new UserMessage(
      '2026-06-01T00:00:00.100Z',
      'persisted before failure',
      undefined,
      { clientRequestId: 'req-persisted' },
    )];
    const loadAll = mock(async () => nativeMessages);
    const views = new ChatViewStore(() => false);
    const pendingInputs = new PendingUserInputService({
      loadNativeMessages: loadAll,
      getRetainedHistoryMessages: (chatId) => views.getRetainedHistoryMessages(chatId),
    });
    await pendingInputs.register('123', 'persisted before failure', {
      clientRequestId: 'req-persisted',
      createdAt: '2026-06-01T00:00:00.000Z',
    });
    await pendingInputs.register('123', 'not persisted before failure', {
      clientRequestId: 'req-failed',
      createdAt: '2026-06-01T00:00:01.000Z',
      images: [{
        name: 'failure.png',
        mimeType: 'image/png',
        data: `data:image/png;base64,${'b'.repeat(20_000)}`,
      }],
    });
    await views.appendAfterEnsuringGeneration('123', async () => [], [
      new UserMessage(
        '2026-06-01T00:00:00.000Z',
        'persisted before failure',
        undefined,
        { clientRequestId: 'req-persisted', deliveryStatus: 'accepted' },
      ),
      new UserMessage(
        '2026-06-01T00:00:01.000Z',
        'not persisted before failure',
        undefined,
        { clientRequestId: 'req-failed', deliveryStatus: 'accepted' },
      ),
    ]);
    const recovery = new ChatProcessErrorRecovery(
      views,
      new ChatNativeReloader(views, { loadNativeMessages: loadAll }, () => false),
      pendingInputs,
    );

    await expect(recovery.recover('123', 'provider crashed')).resolves.toMatchObject({
      kind: 'generation-reset',
    });

    const chatViews = {
      getOrCreatePage: (chatId, limit, beforeSeq) => views.getOrCreatePage(
        chatId,
        { loadAll },
        limit,
        beforeSeq,
      ),
    };
    const { routes } = createRoutesFixture({ chatViews, pendingInputs });
    const url = new URL('http://localhost/api/v1/chats/messages?chatId=123&limit=20');
    const response = await routes['/api/v1/chats/messages'].GET(new Request(url), url);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.messages.map((entry) => entry.message.content)).toEqual([
      'persisted before failure',
      'provider crashed',
    ]);
    expect(payload.pendingUserInputs).toEqual([expect.objectContaining({
      clientRequestId: 'req-failed',
      content: 'not persisted before failure',
      deliveryStatus: 'failed',
    })]);
    expect(payload.pendingUserInputs[0]).not.toHaveProperty('images');
    expect(loadAll).toHaveBeenCalledTimes(1);
  });
});
