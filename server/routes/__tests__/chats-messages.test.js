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
import { TranscriptHistoryUnavailableError } from '../../chats/errors.js';
import {
  createRouteChatListProjector,
  createRouteCommandLedger,
  createRouteCommandService,
  createRoutePathCache,
} from './chat-routes-test-utils.js';

const CHAT_ID = '1783725900000200';

function completeQueue() {
  return {
    serverInstanceId: 'server-instance-test',
    entries: [],
    recentlyDispatched: [],
    appliedCommands: [],
    pause: null,
    reorderRevision: 0,
    version: 0,
    updatedAt: null,
  };
}

function createRoutesFixture(overrides = {}) {
  const entry = {
    id: CHAT_ID,
    agentId: 'claude',
    agentSessionId: 'provider-session-123',
    nativeSession: null,
    agentOwnershipEpoch: 'epoch-1',
    carryOverSegments: [],
    carryOverMigrationQuarantine: null,
    nativeSeedReceipt: null,
    projectPath: '/tmp/project',
    tags: [],
    model: 'opus',
    permissionMode: 'default',
    thinkingMode: 'none',
    agentSettingsById: {},
  };
  const registry = overrides.registry ?? {
    getChat: mock((chatId) => chatId === CHAT_ID ? entry : null),
    addChat: mock(() => true),
    updateChat: mock(() => null),
    removeChat: mock(() => true),
    listAllChats: mock(() => ({ [CHAT_ID]: entry })),
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
      response: { success: true, chatId: CHAT_ID, orderGroup: 'normal', changed: true },
    })),
  };
  const queue = {
    readChatExecutionControl: mock(async () => completeQueue()),
    ownsExecution: mock(() => false),
    deleteChatQueueFile: mock(async () => undefined),
  };
  const pathCache = createRoutePathCache();
  const metadata = {
    listAllChatMetadata: mock(() => new Map()),
    getChatMetadata: mock(() => null),
    addNewChatMetadata: mock(() => undefined),
  };
  const chatViews = overrides.chatViews ?? {
    page: mock(async (_chatId, limit, beforeOrdinal) => ({
      transcriptViewId: 'view-1',
      messages: [],
      lastOrdinal: 12,
      pageOldestOrdinal: beforeOrdinal ?? 0,
      pageNewestOrdinal: 12,
      hasMore: false,
      limit,
    })),
  };
  const agents = {
    hasAgent: mock(() => true),
    supportsFork: mock(() => true),
    supportsForkAtMessage: mock(() => true),
    supportsForkWhileRunning: mock(() => true),
    supportsImages: mock(() => true),
    isAgentSessionRunning: mock(() => false),
    getRunningSessions: mock(() => ({ claude: [] })),
    startSession: mock(async () => undefined),
    modelSupportsImages: mock(async () => true),
    runSingleQuery: mock(async () => 'title'),
    resolvePermission: mock(() => undefined),
    updateSessionSettings: mock(async () => undefined),
    resendCandidates: mock(() => [{ ordinal: 11, content: 'Try again', attachmentNames: [] }]),
  };
  const commandLedger = createRouteCommandLedger('chats-messages');
  const chatListProjector = createRouteChatListProjector({
    registry,
    settings,
    metadata,
    agents,
    pathCache,
  });
  const routes = createChatRoutes({
    registry,
    settings,
    queue,
    processing: overrides.processing ?? { phase: mock(() => null) },
    pathCache,
    metadata,
    chatViews,
    agents,
    chatListProjector,
    commandService: createRouteCommandService({
      registry,
      queue,
      settings,
      metadata,
      agents,
      commandLedger,
      pathCache,
      chatListProjector,
      ownership: overrides.ownership,
    }),
  });

  return { agents, chatViews, routes };
}

describe('GET /api/v1/chats/messages', () => {
  it('clamps view-qualified pagination before reading the ledger', async () => {
    const { agents, chatViews, routes } = createRoutesFixture();
    const url = new URL(
      `http://localhost/api/v1/chats/messages?chatId=${CHAT_ID}&limit=999999&beforeOrdinal=10`,
    );

    const response = await routes['/api/v1/chats/messages'].GET(new Request(url), url);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      historyState: { kind: 'complete' },
      chatId: CHAT_ID,
      transcriptViewId: 'view-1',
      messages: [],
      lastOrdinal: 12,
      pageOldestOrdinal: 10,
      pageNewestOrdinal: 12,
      hasMore: false,
      resendCandidates: [{ ordinal: 11, content: 'Try again', attachmentNames: [] }],
      limit: 200,
    });
    expect(chatViews.page).toHaveBeenCalledWith(CHAT_ID, 200, 10);
    expect(agents.resendCandidates).toHaveBeenCalledWith(CHAT_ID);
  });

  it('suppresses resend candidates while the chat is processing', async () => {
    const { agents, routes } = createRoutesFixture({
      processing: { phase: mock(() => 'running') },
    });
    const url = new URL(`http://localhost/api/v1/chats/messages?chatId=${CHAT_ID}`);

    const response = await routes['/api/v1/chats/messages'].GET(new Request(url), url);

    expect(response.status).toBe(200);
    expect((await response.json()).resendCandidates).toEqual([]);
    expect(agents.resendCandidates).not.toHaveBeenCalled();
  });

  it('rejects invalid beforeOrdinal values', async () => {
    const { chatViews, routes } = createRoutesFixture();
    const url = new URL(
      `http://localhost/api/v1/chats/messages?chatId=${CHAT_ID}&beforeOrdinal=abc`,
    );

    const response = await routes['/api/v1/chats/messages'].GET(new Request(url), url);
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.errorCode).toBe('VALIDATION_FAILED');
    expect(body.error).toBe('beforeOrdinal must be a positive integer');
    expect(chatViews.page).not.toHaveBeenCalled();
  });

  it('rejects invalid limit values instead of silently defaulting them', async () => {
    const { chatViews, routes } = createRoutesFixture();
    const url = new URL(
      `http://localhost/api/v1/chats/messages?chatId=${CHAT_ID}&limit=not-a-number`,
    );

    const response = await routes['/api/v1/chats/messages'].GET(new Request(url), url);

    expect(response.status).toBe(400);
    expect((await response.json()).errorCode).toBe('VALIDATION_FAILED');
    expect(chatViews.page).not.toHaveBeenCalled();
  });

  it('rejects a page from a transcript view other than the requested view', async () => {
    const { routes } = createRoutesFixture();
    const url = new URL(
      `http://localhost/api/v1/chats/messages?chatId=${CHAT_ID}`
      + '&limit=20&beforeOrdinal=10&transcriptViewId=requested-view',
    );

    const response = await routes['/api/v1/chats/messages'].GET(new Request(url), url);
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.errorCode).toBe('STALE_TRANSCRIPT_VIEW');
  });

  it('returns a typed fenced-ledger state instead of an empty complete page', async () => {
    const { routes } = createRoutesFixture({
      chatViews: {
        page: mock(async () => {
          throw new TranscriptHistoryUnavailableError({
            kind: 'degraded',
            errorCode: 'LEDGER_FENCED',
            retryable: true,
          });
        }),
      },
    });
    const url = new URL(`http://localhost/api/v1/chats/messages?chatId=${CHAT_ID}`);

    const response = await routes['/api/v1/chats/messages'].GET(new Request(url), url);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      historyState: {
        kind: 'degraded',
        errorCode: 'LEDGER_FENCED',
        retryable: true,
      },
      chatId: CHAT_ID,
      messages: [],
    });
  });

  it('sanitizes a retryable adoption failure', async () => {
    const { routes } = createRoutesFixture({
      chatViews: {
        page: mock(async () => {
          throw new AgentIntegrationError(
            'TRANSCRIPT_UNAVAILABLE',
            'Cannot open /home/private/.codex/sessions/rollout-secret.jsonl',
            true,
          );
        }),
      },
    });
    const url = new URL(`http://localhost/api/v1/chats/messages?chatId=${CHAT_ID}`);

    const response = await routes['/api/v1/chats/messages'].GET(new Request(url), url);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: TRANSCRIPT_TEMPORARILY_UNAVAILABLE_MESSAGE,
      errorCode: 'TRANSCRIPT_UNAVAILABLE',
      retryable: true,
    });
  });
});
