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
} from './chat-routes-test-utils.js';
import { parseJsonBody } from '../../lib/http-request.js';

const registry = {
  getChat: mock(() => null),
  hasChat: mock((chatId) => registry.getChat(chatId) != null),
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
  reorderChat: mock(() => Promise.resolve({
    success: true,
    response: { success: true, chatId: 'chat-a', orderGroup: 'normal', changed: true },
  })),
  sortChatOrder: mock(() => Promise.resolve({ changed: true })),
};
const queue = { deleteChatQueueFile: mock(() => Promise.resolve(undefined)) };
const metadata = {
  addNewChatMetadata: mock(() => undefined),
  listAllChatMetadata: mock(() => new Map()),
  getChatMetadata: mock(() => null),
};
const chatViews = {
  page: mock(() => Promise.resolve({
    transcriptViewId: 'view-1',
    messages: [],
    lastOrdinal: 0,
    pageOldestOrdinal: 0,
    pageNewestOrdinal: 0,
    hasMore: false,
  })),
};
const agents = {
  startSession: mock(() => undefined),
  isAgentSessionRunning: mock(() => false),
};

const commandLedger = createRouteCommandLedger('chats-reorder');
const chatListProjector = createRouteChatListProjector({
  registry,
  settings,
  metadata,
  agents,
});
const chatsRoutes = createChatRoutes({
  registry,
  settings,
  queue,
  processing: { phase: mock(() => null) },
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
    chatListProjector,
  }),
});

const handler = chatsRoutes['/api/v1/chats/reorder'].POST;
const sortHandler = chatsRoutes['/api/v1/chats/sort'].POST;

async function callReorder(body) {
  parseJsonBody.mockResolvedValue(body);
  const request = new Request('http://localhost/api/v1/chats/reorder', { method: 'POST' });
  return handler(request);
}

async function callSort(body) {
  parseJsonBody.mockResolvedValue(body);
  const request = new Request('http://localhost/api/v1/chats/sort', { method: 'POST' });
  return sortHandler(request);
}

describe('POST /api/v1/chats/reorder', () => {
  beforeEach(() => {
    parseJsonBody.mockClear();
    registry.getChat.mockClear();
    settings.reorderChat.mockClear();
    registry.getChat.mockImplementation(() => ({ agentId: 'claude' }));
    settings.reorderChat.mockResolvedValue({
      success: true,
      response: { success: true, chatId: 'chat-a', orderGroup: 'normal', changed: true },
    });
  });

  const invalidBodies = [
    null,
    {},
    { chatId: 'chat-a' },
    { chatId: 'chat-a', placement: { kind: 'boundary' } },
    { chatId: 'chat-a', placement: { kind: 'boundary', boundary: 'middle' } },
    { chatId: 'chat-a', placement: { kind: 'relative', referenceChatId: 'chat-a', position: 'before' } },
    { chatId: 'chat-a', chatIdAbove: 'chat-b' },
    { list: 'normal', oldOrder: ['chat-a'], newOrder: ['chat-a'] },
  ];

  for (const [index, body] of invalidBodies.entries()) {
    it(`rejects invalid request shape ${index + 1}`, async () => {
      const response = await callReorder(body);

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        success: false,
        error: 'Invalid chat reorder request',
        errorCode: 'VALIDATION_FAILED',
        retryable: false,
      });
      expect(settings.reorderChat).not.toHaveBeenCalled();
    });
  }

  it('handles malformed JSON', async () => {
    parseJsonBody.mockRejectedValue(new MalformedJsonError());
    const request = new Request('http://localhost/api/v1/chats/reorder', { method: 'POST' });

    const response = await handler(request);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      success: false,
      error: 'Malformed JSON',
      errorCode: 'VALIDATION_FAILED',
      retryable: false,
    });
  });

  it('rejects a missing source chat before entering the settings mutation', async () => {
    registry.getChat.mockReturnValue(null);

    const response = await callReorder({
      chatId: 'chat-a',
      placement: { kind: 'boundary', boundary: 'top' },
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: 'Chat not found',
      errorCode: 'SESSION_NOT_FOUND',
      retryable: false,
    });
    expect(settings.reorderChat).not.toHaveBeenCalled();
  });

  it('rejects a missing relative reference before entering the settings mutation', async () => {
    registry.getChat.mockImplementation((chatId) => chatId === 'chat-a' ? { agentId: 'claude' } : null);

    const response = await callReorder({
      chatId: 'chat-a',
      placement: { kind: 'relative', referenceChatId: 'chat-b', position: 'after' },
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: 'Reference chat not found',
      errorCode: 'SESSION_NOT_FOUND',
    });
    expect(settings.reorderChat).not.toHaveBeenCalled();
  });

  it('delegates a boundary placement and returns the typed response', async () => {
    const request = {
      chatId: 'chat-a',
      placement: { kind: 'boundary', boundary: 'bottom' },
    };
    settings.reorderChat.mockResolvedValue({
      success: true,
      response: { success: true, chatId: 'chat-a', orderGroup: 'pinned', changed: false },
    });

    const response = await callReorder(request);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      chatId: 'chat-a',
      orderGroup: 'pinned',
      changed: false,
    });
    expect(settings.reorderChat).toHaveBeenCalledTimes(1);
    expect(settings.reorderChat.mock.calls[0][0]).toEqual(request);
    expect(settings.reorderChat.mock.calls[0][1]('chat-a')).toBe(true);
  });

  it('delegates a relative placement', async () => {
    const request = {
      chatId: 'chat-a',
      placement: { kind: 'relative', referenceChatId: 'chat-b', position: 'before' },
    };

    const response = await callReorder(request);

    expect(response.status).toBe(200);
    expect(settings.reorderChat.mock.calls[0][0]).toEqual(request);
    expect(settings.reorderChat.mock.calls[0][1]('chat-b')).toBe(true);
  });

  it('lets the locked registry callback observe a deletion after route validation', async () => {
    let registryChecks = 0;
    registry.getChat.mockImplementation(() => {
      registryChecks += 1;
      return registryChecks === 1 ? { agentId: 'claude' } : null;
    });
    settings.reorderChat.mockImplementation(async (_request, isKnownChat) => {
      expect(isKnownChat('chat-a')).toBe(false);
      return {
        success: false,
        error: 'Chat not found',
        errorCode: 'SESSION_NOT_FOUND',
        status: 404,
      };
    });

    const response = await callReorder({
      chatId: 'chat-a',
      placement: { kind: 'boundary', boundary: 'top' },
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ errorCode: 'SESSION_NOT_FOUND' });
  });

  it('preserves a store cross-group failure', async () => {
    settings.reorderChat.mockResolvedValue({
      success: false,
      error: 'Cross-group reorder is not allowed',
      errorCode: 'ORDER_CROSS_GROUP',
      status: 400,
    });

    const response = await callReorder({
      chatId: 'chat-a',
      placement: { kind: 'relative', referenceChatId: 'chat-b', position: 'after' },
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      success: false,
      error: 'Cross-group reorder is not allowed',
      errorCode: 'ORDER_CROSS_GROUP',
      retryable: false,
    });
  });

  it('does not expose the retired quick route', () => {
    expect(chatsRoutes['/api/v1/chats/reorder-quick']).toBeUndefined();
  });
});

describe('POST /api/v1/chats/sort', () => {
  beforeEach(() => {
    parseJsonBody.mockClear();
    registry.getChat.mockClear();
    settings.sortChatOrder.mockClear();
    settings.sortChatOrder.mockResolvedValue({ changed: true });
    metadata.listAllChatMetadata.mockClear();
    metadata.listAllChatMetadata.mockReturnValue(new Map([
      ['older-active', {
        chatId: 'older-active',
        createdAt: '2025-01-01T00:00:00.000Z',
        lastActivity: '2025-01-04T00:00:00.000Z',
        lastMessage: '',
        firstMessage: '',
        source: 'live',
      }],
      ['newer-idle', {
        chatId: 'newer-idle',
        createdAt: '2025-01-03T00:00:00.000Z',
        lastActivity: '2025-01-03T00:00:00.000Z',
        lastMessage: '',
        firstMessage: '',
        source: 'live',
      }],
    ]));
  });

  it.each(['created', 'activity'])('sorts by %s and returns the typed response', async (sortKey) => {
    settings.sortChatOrder.mockResolvedValue({ changed: sortKey === 'created' });

    const response = await callSort({ sortKey });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      sortKey,
      changed: sortKey === 'created',
    });
    expect(settings.sortChatOrder).toHaveBeenCalledTimes(1);
    expect(metadata.listAllChatMetadata).toHaveBeenCalledTimes(1);
    expect(registry.getChat).not.toHaveBeenCalled();
  });

  it('builds the creation comparator from metadata', async () => {
    await callSort({ sortKey: 'created' });
    const compare = settings.sortChatOrder.mock.calls[0][0];

    expect(['older-active', 'newer-idle'].sort(compare))
      .toEqual(['newer-idle', 'older-active']);
  });

  it('builds the activity comparator from metadata', async () => {
    await callSort({ sortKey: 'activity' });
    const compare = settings.sortChatOrder.mock.calls[0][0];

    expect(['older-active', 'newer-idle'].sort(compare))
      .toEqual(['older-active', 'newer-idle']);
  });

  const invalidBodies = [
    null,
    {},
    [],
    { sortKey: 'oldest' },
    { sortKey: 'created', direction: 'desc' },
  ];

  for (const [index, body] of invalidBodies.entries()) {
    it(`rejects invalid sort request shape ${index + 1}`, async () => {
      const response = await callSort(body);

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        success: false,
        error: 'Invalid chat order sort request',
        errorCode: 'VALIDATION_FAILED',
        retryable: false,
      });
      expect(settings.sortChatOrder).not.toHaveBeenCalled();
    });
  }

  it('maps settings failures to an opaque internal error', async () => {
    settings.sortChatOrder.mockRejectedValue(new Error('save failed'));

    const response = await callSort({ sortKey: 'activity' });

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      success: false,
      errorCode: 'INTERNAL_ERROR',
      retryable: true,
    });
  });

  it('does not expose alternate quick or bulk sort routes', () => {
    expect(chatsRoutes['/api/v1/chats/sort-quick']).toBeUndefined();
    expect(chatsRoutes['/api/v1/chats/sort-bulk']).toBeUndefined();
  });
});
