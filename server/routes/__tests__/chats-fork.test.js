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

mock.module('../../chats/fork-chat.js', () => ({
  forkChatFileCopy: mock(() => undefined),
}));

import createChatRoutes from '../chats.js';
import { createRouteChatListProjector, createRouteCommandLedger, createRouteCommandService, createRoutePathCache, createRoutePendingInputs } from './chat-routes-test-utils.js';
import { DomainError } from '../../lib/domain-error.js';

const SOURCE_CHAT_ID = '1783725900000300';
const TARGET_CHAT_ID = '1783725900000301';
import { parseJsonBody } from '../../lib/http-request.js';
import { forkChatFileCopy } from '../../chats/fork-chat.js';

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
const queue = {
  deleteChatQueueFile: mock(() => Promise.resolve(undefined)),
  reserveTranscriptSnapshot: mock((chatId) => ({ chatId, reservationId: 'snapshot-reservation' })),
  releaseTranscriptSnapshot: mock(() => Promise.resolve(undefined)),
  hasChatExecutionOwner: mock(() => false),
};
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
  supportsFork: mock(() => true),
  supportsForkAtMessage: mock(() => true),
  supportsForkAtMessageWhileRunning: mock(() => false),
  isAgentSessionRunning: mock(() => false),
  forkAgentSession: mock(() => Promise.resolve({})),
  discardForkedAgentSession: mock(() => Promise.resolve(undefined)),
};

const commandLedger = createRouteCommandLedger('chats-fork');
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
  registry.getChat, parseJsonBody, forkChatFileCopy,
];

describe('POST /api/v1/chats/fork', () => {
  const handler = chatsRoutes['/api/v1/chats/fork'].POST;

  beforeEach(() => {
    allMocks.forEach(m => m.mockClear());
    agents.supportsFork.mockImplementation(() => true);
  });

  it('returns 400 for missing sourceChatId', async () => {
    parseJsonBody.mockResolvedValue({ chatId: TARGET_CHAT_ID });

    const request = new Request('http://localhost/api/v1/chats/fork', { method: 'POST' });
    const response = await handler(request);
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error).toContain('sourceChatId');
  });

  it('returns 400 for non-numeric sourceChatId', async () => {
    parseJsonBody.mockResolvedValue({ sourceChatId: 'abc', chatId: TARGET_CHAT_ID });

    const request = new Request('http://localhost/api/v1/chats/fork', { method: 'POST' });
    const response = await handler(request);
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.success).toBe(false);
  });

  it('returns 400 for missing chatId', async () => {
    parseJsonBody.mockResolvedValue({ sourceChatId: SOURCE_CHAT_ID });

    const request = new Request('http://localhost/api/v1/chats/fork', { method: 'POST' });
    const response = await handler(request);
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error).toContain('chatId');
  });

  it('returns 400 when sourceChatId equals chatId', async () => {
    parseJsonBody.mockResolvedValue({ sourceChatId: SOURCE_CHAT_ID, chatId: SOURCE_CHAT_ID });

    const request = new Request('http://localhost/api/v1/chats/fork', { method: 'POST' });
    const response = await handler(request);
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error).toContain('differ');
  });

  it('returns 404 when source chat not found', async () => {
    parseJsonBody.mockResolvedValue({ sourceChatId: SOURCE_CHAT_ID, chatId: TARGET_CHAT_ID });
    registry.getChat.mockReturnValue(null);

    const request = new Request('http://localhost/api/v1/chats/fork', { method: 'POST' });
    const response = await handler(request);
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.success).toBe(false);
    expect(body.error).toContain('not found');
  });

  it('returns 422 for unsupported agent', async () => {
    parseJsonBody.mockResolvedValue({ sourceChatId: SOURCE_CHAT_ID, chatId: TARGET_CHAT_ID });
    agents.supportsFork.mockImplementation(() => false);
    registry.getChat.mockImplementation((id) => {
      if (id === SOURCE_CHAT_ID) return { agentId: 'unsupported-agent', projectPath: '/proj' };
      return null;
    });

    const request = new Request('http://localhost/api/v1/chats/fork', { method: 'POST' });
    const response = await handler(request);
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body.success).toBe(false);
    expect(body.error).toContain('unsupported-agent');
  });

  it('returns 409 when target chat already exists', async () => {
    parseJsonBody.mockResolvedValue({ sourceChatId: SOURCE_CHAT_ID, chatId: TARGET_CHAT_ID });
    registry.getChat.mockImplementation((id) => {
      if (id === SOURCE_CHAT_ID) return { agentId: 'test-agent', projectPath: '/proj' };
      if (id === TARGET_CHAT_ID) return { agentId: 'test-agent', projectPath: '/proj' };
      return null;
    });

    const request = new Request('http://localhost/api/v1/chats/fork', { method: 'POST' });
    const response = await handler(request);
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.success).toBe(false);
    expect(body.error).toContain('already exists');
  });

  it('returns 200 on successful fork', async () => {
    let forkedChat = null;
    parseJsonBody.mockResolvedValue({ sourceChatId: SOURCE_CHAT_ID, chatId: TARGET_CHAT_ID });
    registry.getChat.mockImplementation((id) => {
      if (id === SOURCE_CHAT_ID) return {
        agentId: 'test-agent',
        agentSessionId: 'source-session',
        nativeSession: {
          ownerId: 'test-agent',
          schemaVersion: 1,
          value: { id: 'source-session' },
        },
        agentOwnershipEpoch: 'source-epoch',
        agentSettingsById: {
          'test-agent': { ownerId: 'test-agent', schemaVersion: 1, values: {} },
        },
        projectPath: '/proj',
      };
      if (id === TARGET_CHAT_ID) return forkedChat;
      return null;
    });
    registry.addChat.mockImplementation((chat) => {
      forkedChat = chat;
    });
    forkChatFileCopy.mockImplementation(async ({ registry: forkRegistry }) => {
      forkRegistry.addChat({
        id: TARGET_CHAT_ID,
        agentId: 'test-agent',
        agentSessionId: 'new-session',
        nativeSession: {
          ownerId: 'test-agent',
          schemaVersion: 1,
          value: { id: 'new-session' },
        },
        agentOwnershipEpoch: 'target-epoch',
        agentSettingsById: {
          'test-agent': { ownerId: 'test-agent', schemaVersion: 1, values: {} },
        },
        projectPath: '/proj',
        model: '',
        tags: [],
      });
      return {
        sourceChatId: SOURCE_CHAT_ID,
        chatId: TARGET_CHAT_ID,
        agentId: 'test-agent',
        agentSessionId: 'new-uuid',
      };
    });

    const request = new Request('http://localhost/api/v1/chats/fork', { method: 'POST' });
    const response = await handler(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.chat).toMatchObject({
      id: TARGET_CHAT_ID,
      agentId: 'test-agent',
      projectPath: '/proj',
      effectiveProjectKey: '/proj',
      orderGroup: 'orphan',
    });
  });

  it('returns 400 for malformed JSON', async () => {
    parseJsonBody.mockRejectedValue(new MalformedJsonError());

    const request = new Request('http://localhost/api/v1/chats/fork', { method: 'POST' });
    const response = await handler(request);
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe('Malformed JSON');
  });

  it('returns a structured 422 when the selected transcript is unavailable', async () => {
    parseJsonBody.mockResolvedValue({
      sourceChatId: SOURCE_CHAT_ID,
      chatId: TARGET_CHAT_ID,
      upToSeq: 2,
    });
    registry.getChat.mockImplementation((id) => {
      if (id === SOURCE_CHAT_ID) return { agentId: 'test-agent', projectPath: '/proj' };
      return null;
    });
    forkChatFileCopy.mockRejectedValue(new DomainError(
      'TRANSCRIPT_UNAVAILABLE',
      'Fork message is outside the source transcript',
      422,
    ));

    const request = new Request('http://localhost/api/v1/chats/fork', { method: 'POST' });
    const response = await handler(request);
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body).toMatchObject({
      success: false,
      errorCode: 'TRANSCRIPT_UNAVAILABLE',
      retryable: false,
    });
  });

  it('returns 500 for unexpected errors', async () => {
    parseJsonBody.mockResolvedValue({ sourceChatId: SOURCE_CHAT_ID, chatId: TARGET_CHAT_ID });
    registry.getChat.mockImplementation((id) => {
      if (id === SOURCE_CHAT_ID) return { agentId: 'test-agent', projectPath: '/proj' };
      return null;
    });
    forkChatFileCopy.mockRejectedValue(new Error('Disk full'));

    const request = new Request('http://localhost/api/v1/chats/fork', { method: 'POST' });
    const response = await handler(request);
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.success).toBe(false);
    expect(body.error).toBe('Internal server error');
  });
});
