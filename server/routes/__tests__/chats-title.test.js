import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

class MalformedJsonError extends Error {
  constructor() { super('Malformed JSON'); this.name = 'MalformedJsonError'; }
}

const parseJsonBody = mock(() => undefined);
const generateChatTitleFromMessage = mock(() => Promise.resolve({
  chatId: CHAT_ID_5,
  title: 'Generated Title',
}));

class TitleGenerationError extends Error {
  constructor(code, message, status = 500, retryable = false) {
    super(message);
    this.name = 'TitleGenerationError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

mock.module('../../lib/http-request.js', () => ({
  parseJsonBody,
  MalformedJsonError,
}));

mock.module('../../agents/claude/history-loader.js', () => ({
  getClaudeSessionMessagesFromNativePath: mock(() => undefined),
}));

mock.module('../../chats/title-generator.js', () => ({
  maybeGenerateChatTitle: mock(() => Promise.resolve(undefined)),
  generateChatTitleFromMessage,
  TitleGenerationError,
}));

import createChatRoutes from '../chats.js';
import { createRouteChatListProjector, createRouteCommandLedger, createRouteCommandService, createRoutePathCache, createRoutePendingInputs } from './chat-routes-test-utils.js';

const CHAT_ID = '1783725900000900';
const CHAT_ID_2 = '1783725900000901';
const CHAT_ID_3 = '1783725900000902';
const CHAT_ID_4 = '1783725900000903';
const CHAT_ID_5 = '1783725900000904';
const CHAT_ID_6 = '1783725900000905';

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
	abortForChatDeletion: mock(() => Promise.resolve(true)),
	deleteChatQueueFile: mock(() => Promise.resolve(undefined)),
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
  isAgentSessionRunning: mock(() => false),
};

const commandLedger = createRouteCommandLedger('chats-title');
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
  registry.listAllChats, metadata.listAllChatMetadata, registry.getChat, registry.removeChat,
	queue.abortForChatDeletion, queue.deleteChatQueueFile,
  settings.getChatName, settings.ensureInNormal, settings.removeSessionName, settings.removeFromAllOrderLists, settings.getNormalChatIds,
  pathCache.resolveProjectPaths,
  parseJsonBody, generateChatTitleFromMessage,
];

function makeJsonRequest(pathname, method, body) {
  parseJsonBody.mockImplementationOnce(() => body);
  const url = new URL(`http://localhost${pathname}`);
  return {
    request: new Request(url, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    url,
  };
}

describe('GET /api/chats title resolution', () => {
  const handler = chatsRoutes['/api/v1/chats'].GET;

  beforeEach(() => {
    allMocks.forEach(m => m.mockClear());
	pathCache.resolveProjectPaths.mockImplementation((projectPaths) => Promise.resolve(new Map(
		projectPaths.map((projectPath) => [projectPath, {
			available: true,
			effectiveProjectKey: projectPath,
		}]),
	)));
  });

  it('uses override title when session name exists', async () => {
    registry.listAllChats.mockImplementation(() => ({
      [CHAT_ID]: { agentId: 'claude', projectPath: '/proj', tags: [] },
    }));
    const metaMap = new Map();
    metaMap.set(CHAT_ID, { firstMessage: 'fallback message', createdAt: null, lastActivity: null, lastMessage: '' });
    metadata.listAllChatMetadata.mockImplementation(() => metaMap);
    settings.getChatName.mockImplementation(() => 'Custom Title');
    settings.getNormalChatIds.mockImplementation(() => [CHAT_ID]);

    const response = await handler();
    const body = await response.json();

    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0].title).toBe('Custom Title');
    expect(settings.getChatName).toHaveBeenCalledWith(CHAT_ID);
  });

  it('falls back to firstMessage when no override exists', async () => {
    registry.listAllChats.mockImplementation(() => ({
      [CHAT_ID_2]: { agentId: 'claude', projectPath: '/proj', tags: [] },
    }));
    const metaMap = new Map();
    metaMap.set(CHAT_ID_2, { firstMessage: 'Hello world', createdAt: null, lastActivity: null, lastMessage: '' });
    metadata.listAllChatMetadata.mockImplementation(() => metaMap);
    settings.getChatName.mockImplementation(() => null);
    settings.getNormalChatIds.mockImplementation(() => [CHAT_ID_2]);

    const response = await handler();
    const body = await response.json();

    expect(body.sessions[0].title).toBe('Hello world');
    expect(body.sessions[0].preview.lastMessage).toBe('Hello world');
  });

  it('falls back to "New Session" when no override or metadata', async () => {
    registry.listAllChats.mockImplementation(() => ({
      [CHAT_ID_3]: { agentId: 'claude', projectPath: '/proj', tags: [] },
    }));
    metadata.listAllChatMetadata.mockImplementation(() => new Map());
    settings.getChatName.mockImplementation(() => null);
    settings.getNormalChatIds.mockImplementation(() => [CHAT_ID_3]);

    const response = await handler();
    const body = await response.json();

    expect(body.sessions[0].title).toBe('New Session');
    expect(body.sessions[0].preview.lastMessage).toBe('New Session');
  });

  it('returns orphaned chats without repairing order lists during a read', async () => {
    registry.listAllChats.mockImplementation(() => ({
      [CHAT_ID_4]: { agentId: 'claude', projectPath: '/proj', tags: [] },
    }));
    metadata.listAllChatMetadata.mockImplementation(() => new Map());
    settings.getPinnedChatIds.mockImplementation(() => []);
    settings.getNormalChatIds.mockImplementation(() => []);
    settings.getArchivedChatIds.mockImplementation(() => []);

    const response = await handler();
    const body = await response.json();

    expect(body.sessions.map((session) => session.id)).toEqual([CHAT_ID_4]);
    expect(settings.ensureInNormal).not.toHaveBeenCalled();
  });

  it('checks project path availability concurrently', async () => {
    let resolveSlow;
    const slowCheck = new Promise((resolve) => { resolveSlow = resolve; });
    let resolveFirstCall;
    const firstCall = new Promise((resolve) => { resolveFirstCall = resolve; });
    let fastCalled = false;

    registry.listAllChats.mockImplementation(() => ({
      [CHAT_ID_5]: { agentId: 'claude', projectPath: '/slow', tags: [] },
      [CHAT_ID_6]: { agentId: 'claude', projectPath: '/fast', tags: [] },
    }));
    metadata.listAllChatMetadata.mockImplementation(() => new Map());
    settings.getPinnedChatIds.mockImplementation(() => []);
    settings.getNormalChatIds.mockImplementation(() => [CHAT_ID_5, CHAT_ID_6]);
    settings.getArchivedChatIds.mockImplementation(() => []);
	pathCache.resolveProjectPaths.mockImplementation(async (projectPaths) => {
		const entries = await Promise.all(projectPaths.map(async (projectPath) => {
			if (projectPath === '/slow') {
				resolveFirstCall();
				await slowCheck;
			}
			if (projectPath === '/fast') fastCalled = true;
			return [projectPath, { available: true, effectiveProjectKey: projectPath }];
		}));
		return new Map(entries);
	});

    const responsePromise = handler();
    await firstCall;

    expect(fastCalled).toBe(true);
    resolveSlow(true);

    const response = await responsePromise;
    const body = await response.json();
    expect(body.sessions.map((session) => session.id)).toEqual([CHAT_ID_5, CHAT_ID_6]);
  });
});

describe('DELETE /api/chats session name cleanup', () => {
  const handler = chatsRoutes['/api/v1/chats'].DELETE;

  beforeEach(() => {
    allMocks.forEach(m => m.mockClear());
    queue.abortForChatDeletion.mockImplementation(() => Promise.resolve(true));
    registry.removeChat.mockImplementation(() => undefined);
  });

  it('removes session name when deleting a chat', async () => {
    registry.getChat.mockImplementation(() => Promise.resolve({ agentId: 'claude', projectPath: '/proj' }));
    parseJsonBody.mockImplementationOnce(() => ({ chatId: CHAT_ID_5 }));

    const url = new URL('http://localhost/api/chats');
    const request = new Request(url, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: '{"chatId":"500"}' });

    const response = await handler(request, url);
    const body = await response.json();

    expect(body.success).toBe(true);
    expect(settings.removeSessionName).toHaveBeenCalledWith(CHAT_ID_5);
    expect(queue.abortForChatDeletion).toHaveBeenCalledWith(CHAT_ID_5);
    expect(registry.removeChat).toHaveBeenCalledWith(CHAT_ID_5);
  });

  it('aborts the running session before removing the chat from the registry', async () => {
    const calls = [];
    registry.getChat.mockImplementation(() => ({ agentId: 'claude', projectPath: '/proj' }));
    queue.abortForChatDeletion.mockImplementation(async () => {
      calls.push('abort');
      return true;
    });
    registry.removeChat.mockImplementation(() => {
      calls.push('remove');
      return true;
    });
    parseJsonBody.mockImplementationOnce(() => ({ chatId: CHAT_ID_5 }));

    const url = new URL('http://localhost/api/chats');
    const request = new Request(url, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: '{"chatId":"500"}' });

    const response = await handler(request, url);
    const body = await response.json();

    expect(body.success).toBe(true);
    expect(calls).toEqual(['abort', 'remove']);
  });

  it('does not delete provider native transcript files', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-delete-native-path-'));
    const nativePath = path.join(tmpDir, 'session.jsonl');
    await fs.writeFile(nativePath, '{"type":"message"}\n', 'utf8');

    try {
      registry.getChat.mockImplementation(() => ({
        agentId: 'claude',
        projectPath: '/proj',
        nativePath,
      }));
      parseJsonBody.mockImplementationOnce(() => ({ chatId: CHAT_ID_5 }));

      const url = new URL('http://localhost/api/chats');
      const request = new Request(url, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: '{"chatId":"500"}' });

      const response = await handler(request, url);
      const body = await response.json();

      expect(body.success).toBe(true);
      await expect(fs.readFile(nativePath, 'utf8')).resolves.toBe('{"type":"message"}\n');
      expect(queue.deleteChatQueueFile).toHaveBeenCalledWith(CHAT_ID_5);
      expect(settings.removeFromAllOrderLists).toHaveBeenCalledWith(CHAT_ID_5);
      expect(settings.removeSessionName).toHaveBeenCalledWith(CHAT_ID_5);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('keeps query chatId compatibility when deleting a chat', async () => {
    registry.getChat.mockImplementation(() => Promise.resolve({ agentId: 'claude', projectPath: '/proj' }));

    const url = new URL(`http://localhost/api/chats?chatId=${CHAT_ID_5}`);
    const request = new Request(url, { method: 'DELETE' });

    await handler(request, url);

    expect(settings.removeFromAllOrderLists).toHaveBeenCalledWith(CHAT_ID_5);
  });
});

describe('POST /api/v1/chats/title/generate', () => {
  const handler = chatsRoutes['/api/v1/chats/title/generate'].POST;

  beforeEach(() => {
    allMocks.forEach(m => m.mockClear());
    generateChatTitleFromMessage.mockImplementation(() => Promise.resolve({
      chatId: CHAT_ID_5,
      title: 'Generated Title',
    }));
  });

  it('generates a title from the supplied user message', async () => {
    registry.getChat.mockImplementation(() => ({ agentId: 'claude', projectPath: '/proj' }));
    const { request, url } = makeJsonRequest('/api/v1/chats/title/generate', 'POST', {
      chatId: CHAT_ID_5,
      message: 'Help debug composer movement',
      messageSeq: 9,
    });

    const response = await handler(request, url);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ success: true, chatId: CHAT_ID_5, title: 'Generated Title' });
    expect(generateChatTitleFromMessage).toHaveBeenCalledWith({
      chatId: CHAT_ID_5,
      projectPath: '/proj',
      message: 'Help debug composer movement',
      messageSeq: 9,
      agents,
      settings,
      signal: expect.any(AbortSignal),
    });
  });

  it('rejects a missing chat', async () => {
    registry.getChat.mockImplementation(() => null);
    const { request, url } = makeJsonRequest('/api/v1/chats/title/generate', 'POST', {
      chatId: 'missing',
      message: 'Hello',
    });

    const response = await handler(request, url);
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.errorCode).toBe('SESSION_NOT_FOUND');
    expect(generateChatTitleFromMessage).not.toHaveBeenCalled();
  });

  it('rejects a blank message', async () => {
    const { request, url } = makeJsonRequest('/api/v1/chats/title/generate', 'POST', {
      chatId: CHAT_ID_5,
      message: '   ',
    });

    const response = await handler(request, url);
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.errorCode).toBe('VALIDATION_FAILED');
    expect(generateChatTitleFromMessage).not.toHaveBeenCalled();
  });

  it('returns title generation errors from the generator', async () => {
    registry.getChat.mockImplementation(() => ({ agentId: 'claude', projectPath: '/proj' }));
    generateChatTitleFromMessage.mockImplementation(() => Promise.reject(new TitleGenerationError(
      'TITLE_GENERATION_UNAVAILABLE',
      'Title generation is unavailable because no generation model is configured or ready.',
      409,
      false,
    )));
    const { request, url } = makeJsonRequest('/api/v1/chats/title/generate', 'POST', {
      chatId: CHAT_ID_5,
      message: 'Hello',
    });

    const response = await handler(request, url);
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.errorCode).toBe('TITLE_GENERATION_UNAVAILABLE');
  });
});
