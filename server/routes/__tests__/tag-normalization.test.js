import { describe, it, expect, beforeEach, mock } from 'bun:test';

mock.module('../../lib/http-request.js', () => ({
  parseJsonBody: mock(() => undefined),
}));

mock.module('../../agents/claude/history-loader.js', () => ({
  getClaudeSessionMessagesFromNativePath: mock(() => undefined),
}));

mock.module('../../chats/title-generator.js', () => ({
  maybeGenerateChatTitle: mock(() => Promise.resolve(undefined)),
}));

import createChatRoutes from '../chats.js';
import { createRouteCommandLedger } from './chat-routes-test-utils.js';
import { parseJsonBody } from '../../lib/http-request.js';

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
  getPinnedChatIds: mock(() => Promise.resolve([])),
  getNormalChatIds: mock(() => Promise.resolve([])),
  getArchivedChatIds: mock(() => Promise.resolve([])),
  removeFromAllOrderLists: mock(() => Promise.resolve(undefined)),
  insertNormalChatIdTop: mock(() => Promise.resolve(undefined)),
  ensureInNormal: mock(() => Promise.resolve(undefined)),
  togglePin: mock(() => Promise.resolve({ isPinned: true })),
  toggleArchive: mock(() => Promise.resolve({ isArchived: true })),
  reorderWindow: mock(() => Promise.resolve({ success: true })),
  reorderRelative: mock(() => Promise.resolve({ success: true })),
  setLastChatDefaults: mock(() => Promise.resolve(undefined)),
};
const queue = { deleteChatQueueFile: mock(() => Promise.resolve(undefined)) };
const pathCache = { isProjectPathAvailable: mock(() => Promise.resolve(true)) };
const metadata = {
  addNewChatMetadata: mock(() => undefined),
  listAllChatMetadata: mock(() => new Map()),
  getChatMetadata: mock(() => null),
};
const historyCache = {
  ensureLoaded: mock(() => undefined),
  getPaginatedMessages: mock(() => undefined),
  appendMessages: mock(() => Promise.resolve(undefined)),
};
const agents = {
  startSession: mock(() => undefined),
  isAgentSessionRunning: mock(() => false),
  runSingleQuery: mock(() => Promise.resolve('')),
};

const chatsRoutes = createChatRoutes(registry, settings, queue, pathCache, metadata, historyCache, agents, createRouteCommandLedger('tag-normalization'));
const handler = chatsRoutes['/api/v1/chats/tags'].PATCH;

describe('PATCH /api/v1/chats/tags – tag normalization', () => {
  beforeEach(() => {
    registry.getChat.mockClear();
    registry.updateChat.mockClear();
    parseJsonBody.mockClear();
  });

  it('converts spaces to hyphens', async () => {
    registry.getChat.mockReturnValue({ agentId: 'claude', projectPath: '/proj', tags: [] });
    parseJsonBody.mockResolvedValue({ chatId: '100', tags: ['hello world'] });

    const res = await handler(new Request('http://localhost/api/v1/chats/tags', { method: 'PATCH' }));
    const body = await res.json();

    expect(body.tags).toEqual(['hello-world']);
  });

  it('removes special characters', async () => {
    registry.getChat.mockReturnValue({ agentId: 'claude', projectPath: '/proj', tags: [] });
    parseJsonBody.mockResolvedValue({ chatId: '100', tags: ['ops!@#$'] });

    const res = await handler(new Request('http://localhost/api/v1/chats/tags', { method: 'PATCH' }));
    const body = await res.json();

    expect(body.tags).toEqual(['ops']);
  });

  it('collapses multiple hyphens', async () => {
    registry.getChat.mockReturnValue({ agentId: 'claude', projectPath: '/proj', tags: [] });
    parseJsonBody.mockResolvedValue({ chatId: '100', tags: ['a---b'] });

    const res = await handler(new Request('http://localhost/api/v1/chats/tags', { method: 'PATCH' }));
    const body = await res.json();

    expect(body.tags).toEqual(['a-b']);
  });

  it('removes leading/trailing hyphens', async () => {
    registry.getChat.mockReturnValue({ agentId: 'claude', projectPath: '/proj', tags: [] });
    parseJsonBody.mockResolvedValue({ chatId: '100', tags: ['-leading-trailing-'] });

    const res = await handler(new Request('http://localhost/api/v1/chats/tags', { method: 'PATCH' }));
    const body = await res.json();

    expect(body.tags).toEqual(['leading-trailing']);
  });

  it('excludes tags that become empty after normalization', async () => {
    registry.getChat.mockReturnValue({ agentId: 'claude', projectPath: '/proj', tags: [] });
    parseJsonBody.mockResolvedValue({ chatId: '100', tags: ['!!!', 'valid'] });

    const res = await handler(new Request('http://localhost/api/v1/chats/tags', { method: 'PATCH' }));
    const body = await res.json();

    expect(body.tags).toEqual(['valid']);
  });

  it('deduplicates tags case-insensitively', async () => {
    registry.getChat.mockReturnValue({ agentId: 'claude', projectPath: '/proj', tags: [] });
    parseJsonBody.mockResolvedValue({ chatId: '100', tags: ['Ops', 'ops', 'OPS'] });

    const res = await handler(new Request('http://localhost/api/v1/chats/tags', { method: 'PATCH' }));
    const body = await res.json();

    expect(body.tags).toEqual(['ops']);
  });

  it('sorts the result', async () => {
    registry.getChat.mockReturnValue({ agentId: 'claude', projectPath: '/proj', tags: [] });
    parseJsonBody.mockResolvedValue({ chatId: '100', tags: ['zebra', 'alpha', 'mid'] });

    const res = await handler(new Request('http://localhost/api/v1/chats/tags', { method: 'PATCH' }));
    const body = await res.json();

    expect(body.tags).toEqual(['alpha', 'mid', 'zebra']);
  });
});
