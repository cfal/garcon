import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

import createChatRoutes from '../chats.js';

const testBasePath = path.join(os.homedir(), 'garcon-chats-validate-start-test');

const registry = {
  getChat: mock(() => undefined),
  addChat: mock(() => undefined),
  updateChat: mock(() => undefined),
  removeChat: mock(() => undefined),
  listAllChats: mock(() => ({})),
};
const settings = {
  getChatName: mock(() => null),
  ensureInNormal: mock(() => Promise.resolve(undefined)),
  removeFromAllOrderLists: mock(() => Promise.resolve(undefined)),
  removeSessionName: mock(() => Promise.resolve(undefined)),
  togglePin: mock(() => Promise.resolve({ isPinned: true })),
  toggleArchive: mock(() => Promise.resolve({ isArchived: true })),
  getPinnedChatIds: mock(() => Promise.resolve([])),
  getNormalChatIds: mock(() => Promise.resolve([])),
  getArchivedChatIds: mock(() => Promise.resolve([])),
  reorderWindow: mock(() => Promise.resolve({ success: true })),
  reorderRelative: mock(() => Promise.resolve({ success: true })),
};
const queue = { deleteChatQueueFile: mock(() => Promise.resolve(undefined)) };
const pathCache = { isProjectPathAvailable: mock(() => Promise.resolve(true)) };
const metadata = {
  addNewChatMetadata: mock(() => undefined),
  listAllChatMetadata: mock(() => new Map()),
  getChatMetadata: mock(() => null),
};
const historyCache = {
  ensureLoaded: mock(() => Promise.resolve(undefined)),
  getPaginatedMessages: mock(() => ({ messages: [], total: 0, hasMore: false, offset: 0, limit: 20 })),
  appendMessages: mock(() => Promise.resolve(undefined)),
};
const providers = {
  startSession: mock(() => Promise.resolve(undefined)),
  isProviderSessionRunning: mock(() => false),
};

const routes = createChatRoutes(registry, settings, queue, pathCache, metadata, historyCache, providers);
const handler = routes['/api/v1/chats/validate-start'].GET;

async function ensureCleanBase() {
  await fs.rm(testBasePath, { recursive: true, force: true });
  await fs.mkdir(testBasePath, { recursive: true });
}

async function runGit(cwd, args) {
  const proc = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  const exitCode = await proc.exited;
  const stderr = await proc.stderr.text();
  if (exitCode !== 0) throw new Error(stderr || `git ${args.join(' ')} failed`);
}

describe('GET /api/v1/chats/validate-start', () => {
  beforeEach(async () => {
    await ensureCleanBase();
  });

  afterEach(async () => {
    await fs.rm(testBasePath, { recursive: true, force: true });
  });

  it('returns outside_base_dir before existence checks', async () => {
    const outsideMissingPath = '/tmp/garcon-outside-missing-start';
    const request = new Request(`http://localhost/api/v1/chats/validate-start?path=${encodeURIComponent(outsideMissingPath)}`);
    const response = await handler(request, new URL(request.url));
    const body = await response.json();

    expect(body.valid).toBe(false);
    expect(body.errorCode).toBe('outside_base_dir');
  });

  it('returns path_not_found for missing paths inside base dir', async () => {
    const missingPath = path.join(testBasePath, 'missing');
    const request = new Request(`http://localhost/api/v1/chats/validate-start?path=${encodeURIComponent(missingPath)}`);
    const response = await handler(request, new URL(request.url));
    const body = await response.json();

    expect(body.valid).toBe(false);
    expect(body.errorCode).toBe('path_not_found');
  });

  it('returns not_directory for files inside base dir', async () => {
    const filePath = path.join(testBasePath, 'README.md');
    await fs.writeFile(filePath, 'content', 'utf8');
    const request = new Request(`http://localhost/api/v1/chats/validate-start?path=${encodeURIComponent(filePath)}`);
    const response = await handler(request, new URL(request.url));
    const body = await response.json();

    expect(body.valid).toBe(false);
    expect(body.errorCode).toBe('not_directory');
  });

  it('returns valid true and isGitRepo false for plain directories', async () => {
    const dirPath = path.join(testBasePath, 'plain');
    await fs.mkdir(dirPath, { recursive: true });
    const request = new Request(`http://localhost/api/v1/chats/validate-start?path=${encodeURIComponent(dirPath)}`);
    const response = await handler(request, new URL(request.url));
    const body = await response.json();

    expect(body).toEqual({ valid: true, isGitRepo: false });
  });

  it('returns valid true and isGitRepo true for git repositories', async () => {
    const dirPath = path.join(testBasePath, 'repo');
    await fs.mkdir(dirPath, { recursive: true });
    await runGit(dirPath, ['init']);
    const request = new Request(`http://localhost/api/v1/chats/validate-start?path=${encodeURIComponent(dirPath)}`);
    const response = await handler(request, new URL(request.url));
    const body = await response.json();

    expect(body).toEqual({ valid: true, isGitRepo: true });
  });
});
