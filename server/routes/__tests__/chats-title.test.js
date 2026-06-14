import { describe, it, expect, beforeEach, mock } from 'bun:test';

class MalformedJsonError extends Error {
  constructor() { super('Malformed JSON'); this.name = 'MalformedJsonError'; }
}

const parseJsonBody = mock(() => undefined);

mock.module('../../lib/http-request.js', () => ({
  parseJsonBody,
  MalformedJsonError,
}));

mock.module('../../agents/claude/history-loader.js', () => ({
  getClaudeSessionMessagesFromNativePath: mock(() => undefined),
}));

mock.module('../../chats/title-generator.js', () => ({
  maybeGenerateChatTitle: mock(() => Promise.resolve(undefined)),
}));

import createChatRoutes from '../chats.js';
import { createRouteCommandLedger, createRouteCommandService, createRoutePendingInputs } from './chat-routes-test-utils.js';

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
  abort: mock(() => Promise.resolve(false)),
  deleteChatQueueFile: mock(() => Promise.resolve(undefined)),
};
const pathCache = { isProjectPathAvailable: mock(() => Promise.resolve(true)) };
const metadata = {
  addNewChatMetadata: mock(() => undefined),
  listAllChatMetadata: mock(() => new Map()),
  getChatMetadata: mock(() => null),
};
const chatEvents = {
  readPage: mock(() => Promise.resolve({ events: [], logId: 'log-1', lastAppendSeq: 0, pageOldestSeq: 0, hasMore: false })),
};
const agents = {
  startSession: mock(() => undefined),
  isAgentSessionRunning: mock(() => false),
};

const commandLedger = createRouteCommandLedger('chats-title');
const pendingInputs = createRoutePendingInputs();

const chatsRoutes = createChatRoutes({
  registry,
  settings,
  queue,
  pathCache,
  metadata,
  chatEvents,
  agents,
  pendingInputs,
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

const allMocks = [
  registry.listAllChats, metadata.listAllChatMetadata, registry.getChat, registry.removeChat,
  queue.abort, queue.deleteChatQueueFile,
  settings.getChatName, settings.ensureInNormal, settings.removeSessionName, settings.removeFromAllOrderLists, settings.getNormalChatIds,
  pathCache.isProjectPathAvailable,
];

describe('GET /api/chats title resolution', () => {
  const handler = chatsRoutes['/api/v1/chats'].GET;

  beforeEach(() => {
    allMocks.forEach(m => m.mockClear());
    pathCache.isProjectPathAvailable.mockImplementation(() => Promise.resolve(true));
  });

  it('uses override title when session name exists', async () => {
    registry.listAllChats.mockImplementation(() => ({
      '100': { agentId: 'claude', projectPath: '/proj', tags: [] },
    }));
    const metaMap = new Map();
    metaMap.set('100', { firstMessage: 'fallback message', createdAt: null, lastActivity: null, lastMessage: '' });
    metadata.listAllChatMetadata.mockImplementation(() => metaMap);
    settings.getChatName.mockImplementation(() => 'Custom Title');
    settings.getNormalChatIds.mockImplementation(() => ['100']);

    const response = await handler();
    const body = await response.json();

    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0].title).toBe('Custom Title');
    expect(settings.getChatName).toHaveBeenCalledWith('100');
  });

  it('falls back to firstMessage when no override exists', async () => {
    registry.listAllChats.mockImplementation(() => ({
      '200': { agentId: 'claude', projectPath: '/proj', tags: [] },
    }));
    const metaMap = new Map();
    metaMap.set('200', { firstMessage: 'Hello world', createdAt: null, lastActivity: null, lastMessage: '' });
    metadata.listAllChatMetadata.mockImplementation(() => metaMap);
    settings.getChatName.mockImplementation(() => null);
    settings.getNormalChatIds.mockImplementation(() => ['200']);

    const response = await handler();
    const body = await response.json();

    expect(body.sessions[0].title).toBe('Hello world');
    expect(body.sessions[0].preview.lastMessage).toBe('Hello world');
  });

  it('falls back to "New Session" when no override or metadata', async () => {
    registry.listAllChats.mockImplementation(() => ({
      '300': { agentId: 'claude', projectPath: '/proj', tags: [] },
    }));
    metadata.listAllChatMetadata.mockImplementation(() => new Map());
    settings.getChatName.mockImplementation(() => null);
    settings.getNormalChatIds.mockImplementation(() => ['300']);

    const response = await handler();
    const body = await response.json();

    expect(body.sessions[0].title).toBe('New Session');
    expect(body.sessions[0].preview.lastMessage).toBe('New Session');
  });

  it('returns orphaned chats without repairing order lists during a read', async () => {
    registry.listAllChats.mockImplementation(() => ({
      '400': { agentId: 'claude', projectPath: '/proj', tags: [] },
    }));
    metadata.listAllChatMetadata.mockImplementation(() => new Map());
    settings.getPinnedChatIds.mockImplementation(() => []);
    settings.getNormalChatIds.mockImplementation(() => []);
    settings.getArchivedChatIds.mockImplementation(() => []);

    const response = await handler();
    const body = await response.json();

    expect(body.sessions.map((session) => session.id)).toEqual(['400']);
    expect(settings.ensureInNormal).not.toHaveBeenCalled();
  });

  it('checks project path availability concurrently', async () => {
    let resolveSlow;
    const slowCheck = new Promise((resolve) => { resolveSlow = resolve; });
    let resolveFirstCall;
    const firstCall = new Promise((resolve) => { resolveFirstCall = resolve; });
    let fastCalled = false;

    registry.listAllChats.mockImplementation(() => ({
      '500': { agentId: 'claude', projectPath: '/slow', tags: [] },
      '600': { agentId: 'claude', projectPath: '/fast', tags: [] },
    }));
    metadata.listAllChatMetadata.mockImplementation(() => new Map());
    settings.getPinnedChatIds.mockImplementation(() => []);
    settings.getNormalChatIds.mockImplementation(() => ['500', '600']);
    settings.getArchivedChatIds.mockImplementation(() => []);
    pathCache.isProjectPathAvailable.mockImplementation((projectPath) => {
      if (projectPath === '/slow') {
        resolveFirstCall();
        return slowCheck;
      }
      if (projectPath === '/fast') {
        fastCalled = true;
      }
      return Promise.resolve(true);
    });

    const responsePromise = handler();
    await firstCall;

    expect(fastCalled).toBe(true);
    resolveSlow(true);

    const response = await responsePromise;
    const body = await response.json();
    expect(body.sessions.map((session) => session.id)).toEqual(['500', '600']);
  });
});

describe('DELETE /api/chats session name cleanup', () => {
  const handler = chatsRoutes['/api/v1/chats'].DELETE;

  beforeEach(() => {
    allMocks.forEach(m => m.mockClear());
    queue.abort.mockImplementation(() => Promise.resolve(false));
    registry.removeChat.mockImplementation(() => undefined);
  });

  it('removes session name when deleting a chat', async () => {
    registry.getChat.mockImplementation(() => Promise.resolve({ agentId: 'claude', projectPath: '/proj' }));
    parseJsonBody.mockImplementationOnce(() => ({ chatId: '500' }));

    const url = new URL('http://localhost/api/chats');
    const request = new Request(url, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: '{"chatId":"500"}' });

    const response = await handler(request, url);
    const body = await response.json();

    expect(body.success).toBe(true);
    expect(settings.removeSessionName).toHaveBeenCalledWith('500');
    expect(queue.abort).toHaveBeenCalledWith('500');
    expect(registry.removeChat).toHaveBeenCalledWith('500');
  });

  it('aborts the running session before removing the chat from the registry', async () => {
    const calls = [];
    registry.getChat.mockImplementation(() => ({ agentId: 'claude', projectPath: '/proj' }));
    queue.abort.mockImplementation(async () => {
      calls.push('abort');
      return true;
    });
    registry.removeChat.mockImplementation(() => {
      calls.push('remove');
      return true;
    });
    parseJsonBody.mockImplementationOnce(() => ({ chatId: '500' }));

    const url = new URL('http://localhost/api/chats');
    const request = new Request(url, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: '{"chatId":"500"}' });

    const response = await handler(request, url);
    const body = await response.json();

    expect(body.success).toBe(true);
    expect(calls).toEqual(['abort', 'remove']);
  });

  it('keeps query chatId compatibility when deleting a chat', async () => {
    registry.getChat.mockImplementation(() => Promise.resolve({ agentId: 'claude', projectPath: '/proj' }));

    const url = new URL('http://localhost/api/chats?chatId=500');
    const request = new Request(url, { method: 'DELETE' });

    await handler(request, url);

    expect(settings.removeFromAllOrderLists).toHaveBeenCalledWith('500');
  });
});
