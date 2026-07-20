import { describe, it, expect, beforeEach, mock } from 'bun:test';

class MalformedJsonError extends Error {
  constructor() { super('Malformed JSON'); this.name = 'MalformedJsonError'; }
}

mock.module('../../lib/http-request.js', () => ({
  parseJsonBody: mock(() => undefined),
  MalformedJsonError,
}));

mock.module('../../chats/title-generator.js', () => ({
  maybeGenerateChatTitle: mock(() => Promise.resolve(undefined)),
  generateChatTitleFromMessage: mock(() => Promise.resolve({ chatId: '123', title: 'Generated Title' })),
  TitleGenerationError: class TitleGenerationError extends Error {},
}));

import createChatRoutes from '../chats.js';
import {
  createRouteChatListProjector,
  createRouteCommandLedger,
  createRouteCommandService,
  createRoutePathCache,
  createRoutePendingInputs,
} from './chat-routes-test-utils.js';

const CHAT_ID = '1783725900000400';
const CHAT_ID_2 = '1783725900000401';
import { parseJsonBody } from '../../lib/http-request.js';

function chatEntry(overrides = {}) {
  const agentId = overrides.agentId ?? 'test-agent';
  return {
    agentId,
    agentSessionId: null,
    nativeSession: null,
    agentOwnershipEpoch: 'epoch-1',
    agentSettingsById: {
      [agentId]: {
        ownerId: agentId,
        schemaVersion: 1,
        values: {},
      },
    },
    projectPath: '/proj',
    tags: [],
    ...overrides,
  };
}

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
  reorderWindow: mock(() => Promise.resolve({ success: true })),
  reorderRelative: mock(() => Promise.resolve({ success: true })),
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
  describeTranscriptSource: mock(async () => null),
};

const commandLedger = createRouteCommandLedger('chats-read');
const pendingInputs = createRoutePendingInputs();
const chatListProjector = createRouteChatListProjector({
  registry,
  settings,
  metadata,
  agents,
  pathCache,
});

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
  registry.getChat, registry.updateChat, metadata.getChatMetadata,
  registry.listAllChats, metadata.listAllChatMetadata, parseJsonBody,
  settings.getChatName, settings.getPinnedChatIds, settings.getNormalChatIds, settings.getArchivedChatIds,
];

describe('POST /api/chats/read', () => {
  const handler = chatsRoutes['/api/v1/chats/read'].POST;

  beforeEach(() => {
    allMocks.forEach(m => m.mockClear());
    agents.describeTranscriptSource.mockResolvedValue(null);
  });

  it('processes multiple entries', async () => {
    parseJsonBody.mockResolvedValue({
      entries: [
        { chatId: CHAT_ID, lastReadAt: '2026-02-25T12:00:00.000Z' },
        { chatId: CHAT_ID_2, lastReadAt: '2026-02-25T13:00:00.000Z' },
      ],
    });

    registry.getChat.mockImplementation((id) => {
      if (id === CHAT_ID) return { agentId: 'claude', projectPath: '/proj' };
      if (id === CHAT_ID_2) return { agentId: 'codex', projectPath: '/proj2' };
      return null;
    });
    registry.updateChat.mockResolvedValue({});

    const request = new Request('http://localhost/api/chats/read', { method: 'POST' });
    const response = await handler(request);
    const body = await response.json();

    expect(body.success).toBe(true);
    expect(body.results).toHaveLength(2);
    expect(body.results[0].chatId).toBe(CHAT_ID);
    expect(body.results[1].chatId).toBe(CHAT_ID_2);
  });

  it('skips unknown chats', async () => {
    parseJsonBody.mockResolvedValue({
      entries: [
        { chatId: CHAT_ID, lastReadAt: '2026-02-25T12:00:00.000Z' },
        { chatId: 'unknown', lastReadAt: '2026-02-25T13:00:00.000Z' },
      ],
    });

    registry.getChat.mockImplementation((id) => {
      if (id === CHAT_ID) return { agentId: 'claude', projectPath: '/proj' };
      return null;
    });
    registry.updateChat.mockResolvedValue({});

    const request = new Request('http://localhost/api/chats/read', { method: 'POST' });
    const response = await handler(request);
    const body = await response.json();

    expect(body.results).toHaveLength(1);
    expect(body.results[0].chatId).toBe(CHAT_ID);
  });

  it('returns empty results for empty entries', async () => {
    parseJsonBody.mockResolvedValue({ entries: [] });

    const request = new Request('http://localhost/api/chats/read', { method: 'POST' });
    const response = await handler(request);
    const body = await response.json();

    expect(body.success).toBe(true);
    expect(body.results).toHaveLength(0);
  });

  it('defaults lastReadAt to a shared timestamp when absent', async () => {
    const before = new Date().toISOString();
    parseJsonBody.mockResolvedValue({
      entries: [
        { chatId: CHAT_ID },
        { chatId: CHAT_ID_2 },
      ],
    });
    registry.getChat.mockImplementation((id) => {
      if (id === CHAT_ID || id === CHAT_ID_2) return { agentId: 'claude', projectPath: '/proj' };
      return null;
    });
    registry.updateChat.mockResolvedValue({});

    const request = new Request('http://localhost/api/chats/read', { method: 'POST' });
    const response = await handler(request);
    const body = await response.json();
    const after = new Date().toISOString();

    expect(body.results).toHaveLength(2);
    // Both entries share the same fallback timestamp.
    expect(body.results[0].lastReadAt).toBe(body.results[1].lastReadAt);
    expect(body.results[0].lastReadAt >= before).toBe(true);
    expect(body.results[0].lastReadAt <= after).toBe(true);
  });

  it('uses the server timestamp instead of trusting a client timestamp', async () => {
    const before = new Date().toISOString();
    const clientFuture = '2999-02-25T00:00:00.000Z';

    parseJsonBody.mockResolvedValue({
      entries: [{ chatId: CHAT_ID, lastReadAt: clientFuture }],
    });
    registry.getChat.mockReturnValue({ agentId: 'claude', projectPath: '/proj' });
    registry.updateChat.mockResolvedValue({});

    const request = new Request('http://localhost/api/chats/read', { method: 'POST' });
    const response = await handler(request);
    const body = await response.json();
    const after = new Date().toISOString();

    expect(body.results[0].lastReadAt >= before).toBe(true);
    expect(body.results[0].lastReadAt <= after).toBe(true);
    expect(body.results[0].lastReadAt).not.toBe(clientFuture);
    expect(registry.updateChat).toHaveBeenCalledWith(CHAT_ID, { lastReadAt: body.results[0].lastReadAt });
  });

  it('keeps an existing future timestamp for monotonicity', async () => {
    const existing = '2999-02-25T00:00:00.000Z';
    const clientOlder = '2026-02-20T00:00:00.000Z';

    parseJsonBody.mockResolvedValue({
      entries: [{ chatId: CHAT_ID, lastReadAt: clientOlder }],
    });
    registry.getChat.mockReturnValue({ agentId: 'claude', projectPath: '/proj', lastReadAt: existing });
    registry.updateChat.mockResolvedValue({});

    const request = new Request('http://localhost/api/chats/read', { method: 'POST' });
    const response = await handler(request);
    const body = await response.json();

    expect(body.results[0].lastReadAt).toBe(existing);
    expect(registry.updateChat).not.toHaveBeenCalled();
  });

  it('does not include isUnread in mark-read response', async () => {
    const readAt = '2026-02-25T12:00:00.000Z';

    parseJsonBody.mockResolvedValue({
      entries: [{ chatId: CHAT_ID, lastReadAt: readAt }],
    });
    registry.getChat.mockReturnValue({ agentId: 'claude', projectPath: '/proj' });
    registry.updateChat.mockResolvedValue({});

    const request = new Request('http://localhost/api/chats/read', { method: 'POST' });
    const response = await handler(request);
    const body = await response.json();

    expect(body.results[0].chatId).toBe(CHAT_ID);
    expect(body.results[0].lastReadAt).not.toBe(readAt);
    expect(body.results[0].isUnread).toBeUndefined();
  });
});

describe('GET /api/chats includes read state', () => {
  const handler = chatsRoutes['/api/v1/chats'].GET;

  beforeEach(() => {
    allMocks.forEach(m => m.mockClear());
  });

  it('returns lastReadAt and isUnread in session response', async () => {
    registry.listAllChats.mockImplementation(() => ({
      [CHAT_ID]: chatEntry({ lastReadAt: '2026-02-25T10:00:00.000Z' }),
    }));
    const metaMap = new Map();
    metaMap.set(CHAT_ID, {
      firstMessage: 'Hello',
      createdAt: null,
      lastActivity: '2026-02-25T12:00:00.000Z',
      lastMessage: '',
      lastReadAt: '2026-02-25T10:00:00.000Z',
    });
    metadata.listAllChatMetadata.mockImplementation(() => metaMap);
    settings.getChatName.mockImplementation(() => null);
    settings.getNormalChatIds.mockImplementation(() => [CHAT_ID]);

    const response = await handler();
    const body = await response.json();

    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0].activity.createdAt).toBe(
      new Date(Number(BigInt(CHAT_ID) / 1_000n)).toISOString(),
    );
    expect(body.sessions[0].activity.lastReadAt).toBe('2026-02-25T10:00:00.000Z');
    expect(body.sessions[0].isUnread).toBe(true);
  });

  it('returns isUnread false when fully read', async () => {
    registry.listAllChats.mockImplementation(() => ({
      [CHAT_ID]: chatEntry({ lastReadAt: '2026-02-25T13:00:00.000Z' }),
    }));
    const metaMap = new Map();
    metaMap.set(CHAT_ID, {
      firstMessage: 'Hello',
      createdAt: null,
      lastActivity: '2026-02-25T12:00:00.000Z',
      lastMessage: '',
      lastReadAt: '2026-02-25T13:00:00.000Z',
    });
    metadata.listAllChatMetadata.mockImplementation(() => metaMap);
    settings.getChatName.mockImplementation(() => null);
    settings.getNormalChatIds.mockImplementation(() => [CHAT_ID]);

    const response = await handler();
    const body = await response.json();

    expect(body.sessions[0].isUnread).toBe(false);
  });

  it('returns isUnread false when no activity', async () => {
    registry.listAllChats.mockImplementation(() => ({
      [CHAT_ID]: chatEntry(),
    }));
    metadata.listAllChatMetadata.mockImplementation(() => new Map());
    settings.getChatName.mockImplementation(() => null);
    settings.getNormalChatIds.mockImplementation(() => [CHAT_ID]);

    const response = await handler();
    const body = await response.json();

    expect(body.sessions[0].isUnread).toBe(false);
    expect(body.sessions[0].activity.lastReadAt).toBeNull();
  });

  it('returns canonical modes and the active integration settings envelope', async () => {
    registry.listAllChats.mockImplementation(() => ({
      [CHAT_ID]: chatEntry({
        permissionMode: 'acceptEdits',
        thinkingMode: 'medium',
        agentSettingsById: {
          'test-agent': {
            ownerId: 'test-agent',
            schemaVersion: 2,
            values: { providerMode: 'focused' },
          },
        },
      }),
    }));
    metadata.listAllChatMetadata.mockImplementation(() => new Map());
    settings.getChatName.mockImplementation(() => null);
    settings.getNormalChatIds.mockImplementation(() => [CHAT_ID]);

    const response = await handler();
    const body = await response.json();

    expect(body.sessions[0].permissionMode).toBe('acceptEdits');
    expect(body.sessions[0].thinkingMode).toBe('medium');
    expect(body.sessions[0].agentSettings).toEqual({
      ownerId: 'test-agent',
      schemaVersion: 2,
      values: { providerMode: 'focused' },
    });
  });

  it('defaults canonical modes and settings for partial persisted sessions', async () => {
    registry.listAllChats.mockImplementation(() => ({
      [CHAT_ID]: chatEntry({ agentSettingsById: {} }),
    }));
    metadata.listAllChatMetadata.mockImplementation(() => new Map());
    settings.getChatName.mockImplementation(() => null);
    settings.getNormalChatIds.mockImplementation(() => [CHAT_ID]);

    const response = await handler();
    const body = await response.json();

    expect(body.sessions[0].permissionMode).toBe('default');
    expect(body.sessions[0].thinkingMode).toBe('none');
    expect(body.sessions[0].agentSettings).toEqual({
      ownerId: 'test-agent',
      schemaVersion: 1,
      values: {},
    });
  });

  it('normalizes invalid canonical mode values', async () => {
    registry.listAllChats.mockImplementation(() => ({
      [CHAT_ID]: chatEntry({
        permissionMode: 'bogus',
        thinkingMode: 'very-hard',
      }),
    }));
    metadata.listAllChatMetadata.mockImplementation(() => new Map());
    settings.getChatName.mockImplementation(() => null);
    settings.getNormalChatIds.mockImplementation(() => [CHAT_ID]);

    const response = await handler();
    const body = await response.json();

    expect(body.sessions[0].permissionMode).toBe('default');
    expect(body.sessions[0].thinkingMode).toBe('none');
  });

  it('fails listing when an invalid persisted ID reaches the route', async () => {
    registry.listAllChats.mockImplementation(() => ({
      '178372590000007231252': chatEntry(),
    }));
    metadata.listAllChatMetadata.mockImplementation(() => new Map());

    const response = await handler();
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).toBe('Internal server error');
  });
});

describe('GET /api/v1/chats/details', () => {
  const handler = chatsRoutes['/api/v1/chats/details'].GET;

  beforeEach(() => {
    allMocks.forEach(m => m.mockClear());
    agents.describeTranscriptSource.mockResolvedValue(null);
  });

  it('returns provider-neutral chat metadata as a flat response', async () => {
    agents.describeTranscriptSource.mockResolvedValue({
      kind: 'filesystem-path',
      value: '/tmp/transcript.jsonl',
    });
    registry.getChat.mockReturnValue({
      agentId: 'test-agent',
      projectPath: '/proj',
      agentSessionId: 'agent-session-100',
      transcriptSource: { kind: 'filesystem-path', value: '/tmp/transcript.jsonl' },
    });
    metadata.getChatMetadata.mockReturnValue({
      firstMessage: 'First line\nSecond line',
      createdAt: '2026-02-20T10:00:00.000Z',
      lastActivity: '2026-02-21T11:00:00.000Z',
    });

    const response = await handler(
      new Request('http://localhost/api/v1/chats/details?chatId=100'),
      new URL(`http://localhost/api/v1/chats/details?chatId=${CHAT_ID}`),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      chatId: CHAT_ID,
      firstMessage: 'First line\nSecond line',
      createdAt: '2026-02-20T10:00:00.000Z',
      lastActivityAt: '2026-02-21T11:00:00.000Z',
      agentSessionId: 'agent-session-100',
      transcriptSource: { kind: 'filesystem-path', value: '/tmp/transcript.jsonl' },
    });
  });

  it('returns 400 when chatId is missing', async () => {
    const response = await handler(
      new Request('http://localhost/api/v1/chats/details'),
      new URL('http://localhost/api/v1/chats/details'),
    );
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body.error).toBe('chatId query parameter is required');
  });

  it('returns 404 when chat is missing', async () => {
    registry.getChat.mockReturnValue(null);

    const response = await handler(
      new Request('http://localhost/api/v1/chats/details?chatId=404'),
      new URL('http://localhost/api/v1/chats/details?chatId=404'),
    );
    const body = await response.json();
    expect(response.status).toBe(404);
    expect(body.error).toBe('Session not found');
  });

  it('returns empty details fields when metadata is missing', async () => {
    registry.getChat.mockReturnValue({
      agentId: 'test-agent',
      projectPath: '/proj',
      agentSessionId: null,
    });
    metadata.getChatMetadata.mockReturnValue(null);

    const response = await handler(
      new Request('http://localhost/api/v1/chats/details?chatId=100'),
      new URL(`http://localhost/api/v1/chats/details?chatId=${CHAT_ID}`),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      chatId: CHAT_ID,
      firstMessage: '',
      createdAt: null,
      lastActivityAt: null,
      agentSessionId: null,
      transcriptSource: null,
    });
  });
});
