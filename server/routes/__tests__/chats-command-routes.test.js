import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';

let testBasePath;
let workspaceDir;

mock.module('../../lib/http-request.js', () => ({
  parseJsonBody: mock(() => Promise.resolve({})),
}));

mock.module('../../config.js', () => ({
  getProjectBasePath: mock(() => testBasePath),
  getWorkspaceDir: mock(() => workspaceDir),
}));

mock.module('../../chats/title-generator.js', () => ({
  maybeGenerateChatTitle: mock(() => Promise.resolve(undefined)),
}));

mock.module('../../chats/fork-chat.js', () => ({
  forkChatFileCopy: mock(() => Promise.resolve({})),
}));

import createChatRoutes from '../chats.js';
import { parseJsonBody } from '../../lib/http-request.js';
import { forkChatFileCopy } from '../../chats/fork-chat.js';

function createSession(overrides = {}) {
  return {
    id: '123',
    provider: 'claude',
    providerSessionId: 'provider-session-123',
    projectPath: '/workspace/project',
    model: 'opus',
    permissionMode: 'default',
    thinkingMode: 'none',
    claudeThinkingMode: 'auto',
    ampAgentMode: 'smart',
    nativePath: '/tmp/session.jsonl',
    ...overrides,
  };
}

function createRouteHarness(sessionOverrides = {}) {
  const sessions = new Map([
    ['123', createSession(sessionOverrides)],
  ]);
  const registry = {
    getChat: mock((chatId) => sessions.get(chatId) ?? null),
    addChat: mock((entry) => {
      if (sessions.has(entry.id)) return false;
      sessions.set(entry.id, entry);
      return true;
    }),
    updateChat: mock((chatId, patch) => {
      const current = sessions.get(chatId);
      if (!current) return null;
      sessions.set(chatId, { ...current, ...patch });
      return sessions.get(chatId);
    }),
    removeChat: mock((chatId) => sessions.delete(chatId)),
    listAllChats: mock(() => Object.fromEntries(sessions.entries())),
  };
  const settings = {
    getChatName: mock(() => null),
    ensureInNormal: mock(() => Promise.resolve(undefined)),
    setLastChatDefaults: mock(() => Promise.resolve(undefined)),
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
  const queue = {
    deleteChatQueueFile: mock(() => Promise.resolve(undefined)),
    submit: mock(() => Promise.resolve(undefined)),
    appendUserMessage: mock(() => Promise.resolve(undefined)),
    runAcceptedTurn: mock(() => Promise.resolve(undefined)),
    abort: mock(() => Promise.resolve(true)),
    triggerDrain: mock(() => Promise.resolve(undefined)),
    readChatQueue: mock(() => Promise.resolve({ entries: [], paused: false, version: 0 })),
    enqueueChat: mock(() => Promise.resolve({
      entry: { id: 'entry-1' },
      queue: {
        entries: [{ id: 'entry-1', content: 'queued', status: 'queued', createdAt: '2026-05-14T00:00:00.000Z' }],
        paused: false,
        version: 1,
        updatedAt: '2026-05-14T00:00:00.000Z',
      },
    })),
    dequeueChat: mock(() => Promise.resolve({ entries: [], paused: false, version: 2 })),
    clearChatQueue: mock(() => Promise.resolve({ entries: [], paused: false, version: 2 })),
    pauseChatQueue: mock(() => Promise.resolve({ entries: [{ id: 'entry-1', content: 'queued', status: 'queued', createdAt: '2026-05-14T00:00:00.000Z' }], paused: true, version: 2 })),
    resumeChatQueue: mock(() => Promise.resolve({ entries: [{ id: 'entry-1', content: 'queued', status: 'queued', createdAt: '2026-05-14T00:00:00.000Z' }], paused: false, version: 3 })),
  };
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
    hasHarness: mock(() => true),
    isHarnessSessionRunning: mock(() => false),
    getRunningSessions: mock(() => ({ claude: [{ id: '123' }] })),
    startSession: mock(() => Promise.resolve(undefined)),
    modelSupportsImages: mock(() => Promise.resolve(true)),
    runSingleQuery: mock(() => Promise.resolve('title')),
    resolvePermission: mock(() => undefined),
    setPermissionMode: mock(() => Promise.resolve(undefined)),
    setThinkingMode: mock(() => Promise.resolve(undefined)),
    setClaudeThinkingMode: mock(() => Promise.resolve(undefined)),
    setAmpAgentMode: mock(() => Promise.resolve(undefined)),
    setModel: mock(() => Promise.resolve(undefined)),
  };
  const routes = createChatRoutes(registry, settings, queue, pathCache, metadata, historyCache, providers);
  return { sessions, registry, settings, queue, pathCache, metadata, historyCache, providers, routes };
}

async function callJson(handler, body, method = 'POST') {
  parseJsonBody.mockResolvedValueOnce(body);
  const response = await handler(new Request('http://localhost/test', { method }));
  return { response, body: await response.json() };
}

function agentRunBody(overrides = {}) {
  return {
    clientRequestId: 'req-run-1',
    clientMessageId: 'msg-run-1',
    chatId: '123',
    command: 'hello',
    permissionMode: 'default',
    thinkingMode: 'none',
    claudeThinkingMode: 'auto',
    ampAgentMode: 'smart',
    model: 'opus',
    ...overrides,
  };
}

describe('REST chat command routes', () => {
  beforeEach(async () => {
    testBasePath = path.join(os.tmpdir(), `garcon-command-routes-project-${randomUUID()}`);
    workspaceDir = path.join(os.tmpdir(), `garcon-command-routes-workspace-${randomUUID()}`);
    await fs.mkdir(testBasePath, { recursive: true });
    await fs.mkdir(workspaceDir, { recursive: true });
    parseJsonBody.mockClear();
    forkChatFileCopy.mockClear();
  });

  afterEach(async () => {
    await fs.rm(testBasePath, { recursive: true, force: true });
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it('POST /run returns before provider completion and persists before running', async () => {
    const harness = createRouteHarness();
    const order = [];
    let resolveRun;
    const runPromise = new Promise((resolve) => { resolveRun = resolve; });
    harness.queue.appendUserMessage.mockImplementation(() => {
      order.push('append');
      return Promise.resolve();
    });
    harness.queue.runAcceptedTurn.mockImplementation(() => {
      order.push('run');
      return runPromise;
    });

    const { response, body } = await callJson(harness.routes['/api/v1/chats/run'].POST, agentRunBody());

    expect(response.status).toBe(202);
    expect(body).toMatchObject({
      success: true,
      commandType: 'agent-run',
      clientRequestId: 'req-run-1',
      chatId: '123',
      status: 'accepted',
    });
    expect(typeof body.turnId).toBe('string');
    expect(order).toEqual(['append', 'run']);
    expect(harness.queue.appendUserMessage).toHaveBeenCalledWith('123', 'hello', expect.objectContaining({
      clientRequestId: 'req-run-1',
      clientMessageId: 'msg-run-1',
      turnId: body.turnId,
      model: 'opus',
    }));

    resolveRun();
  });

  it('POST /run deduplicates same payload retries without re-running side effects', async () => {
    const harness = createRouteHarness();
    const handler = harness.routes['/api/v1/chats/run'].POST;

    await callJson(handler, agentRunBody());
    const retry = await callJson(handler, agentRunBody());

    expect(retry.response.status).toBe(202);
    expect(retry.body.status).toBe('duplicate');
    expect(harness.queue.appendUserMessage).toHaveBeenCalledTimes(1);
    expect(harness.queue.runAcceptedTurn).toHaveBeenCalledTimes(1);
  });

  it('POST /run rejects conflicting idempotency retries', async () => {
    const harness = createRouteHarness();
    const handler = harness.routes['/api/v1/chats/run'].POST;

    await callJson(handler, agentRunBody());
    const conflict = await callJson(handler, agentRunBody({ command: 'different command' }));

    expect(conflict.response.status).toBe(409);
    expect(conflict.body.errorCode).toBe('IDEMPOTENCY_CONFLICT');
    expect(harness.queue.appendUserMessage).toHaveBeenCalledTimes(1);
  });

  it('POST /run validates content and session existence', async () => {
    const emptyHarness = createRouteHarness();
    const empty = await callJson(emptyHarness.routes['/api/v1/chats/run'].POST, agentRunBody({ command: '   ' }));
    expect(empty.response.status).toBe(400);
    expect(empty.body.error).toContain('command or images');

    const missingHarness = createRouteHarness();
    missingHarness.registry.getChat.mockReturnValue(null);
    const missing = await callJson(missingHarness.routes['/api/v1/chats/run'].POST, agentRunBody());
    expect(missing.response.status).toBe(404);
    expect(missing.body.errorCode).toBe('SESSION_NOT_FOUND');
  });

  it('POST /fork-run forks once and schedules the target turn', async () => {
    const harness = createRouteHarness();
    const { response, body } = await callJson(harness.routes['/api/v1/chats/fork-run'].POST, {
      ...agentRunBody({
        clientRequestId: 'req-fork-run-1',
        clientMessageId: 'msg-fork-run-1',
        sourceChatId: '123',
        chatId: '456',
        command: 'continue here',
      }),
    });

    expect(response.status).toBe(202);
    expect(body.commandType).toBe('fork-run');
    expect(body.sourceChatId).toBe('123');
    expect(body.chatId).toBe('456');
    expect(forkChatFileCopy).toHaveBeenCalledTimes(1);
    expect(harness.queue.appendUserMessage).toHaveBeenCalledWith('456', 'continue here', expect.objectContaining({
      clientRequestId: 'req-fork-run-1',
      clientMessageId: 'msg-fork-run-1',
    }));
  });

  it('POST /fork-run rejects busy source sessions before copying', async () => {
    const harness = createRouteHarness();
    harness.providers.isHarnessSessionRunning.mockReturnValue(true);

    const { response, body } = await callJson(harness.routes['/api/v1/chats/fork-run'].POST, {
      ...agentRunBody({
        clientRequestId: 'req-fork-run-2',
        clientMessageId: 'msg-fork-run-2',
        sourceChatId: '123',
        chatId: '456',
        command: 'continue',
      }),
    });

    expect(response.status).toBe(409);
    expect(body.errorCode).toBe('SESSION_BUSY');
    expect(forkChatFileCopy).not.toHaveBeenCalled();
    expect(harness.queue.appendUserMessage).not.toHaveBeenCalled();
  });

  it('POST /queue/enqueue accepts, deduplicates, and preserves queue state', async () => {
    const harness = createRouteHarness();
    const handler = harness.routes['/api/v1/chats/queue/enqueue'].POST;
    const payload = { clientRequestId: 'req-queue-1', chatId: '123', content: 'queued' };

    const first = await callJson(handler, payload);
    const retry = await callJson(handler, payload);

    expect(first.response.status).toBe(202);
    expect(first.body).toMatchObject({
      commandType: 'queue-enqueue',
      clientRequestId: 'req-queue-1',
      entryId: 'entry-1',
      merged: false,
    });
    expect(first.body.queue.version).toBe(1);
    expect(retry.response.status).toBe(202);
    expect(retry.body.status).toBe('duplicate');
    expect(harness.queue.enqueueChat).toHaveBeenCalledTimes(1);
  });

  it('POST /queue/enqueue rejects conflicting retries', async () => {
    const harness = createRouteHarness();
    const handler = harness.routes['/api/v1/chats/queue/enqueue'].POST;

    await callJson(handler, { clientRequestId: 'req-queue-1', chatId: '123', content: 'first' });
    const conflict = await callJson(handler, { clientRequestId: 'req-queue-1', chatId: '123', content: 'second' });

    expect(conflict.response.status).toBe(409);
    expect(conflict.body.errorCode).toBe('IDEMPOTENCY_CONFLICT');
    expect(harness.queue.enqueueChat).toHaveBeenCalledTimes(1);
  });

  it('queue mutations return normalized authoritative state', async () => {
    const harness = createRouteHarness();

    const paused = await callJson(harness.routes['/api/v1/chats/queue/pause'].POST, { chatId: '123' });
    const resumed = await callJson(harness.routes['/api/v1/chats/queue/resume'].POST, { chatId: '123' });

    expect(paused.body.queue.paused).toBe(true);
    expect(paused.body.queue.version).toBe(2);
    expect(resumed.body.queue.paused).toBe(false);
    expect(resumed.body.queue.version).toBe(3);
    expect(harness.queue.triggerDrain).toHaveBeenCalledTimes(1);
  });

  it('POST /permissions/decision deduplicates identical decisions and rejects conflicts', async () => {
    const harness = createRouteHarness();
    const handler = harness.routes['/api/v1/chats/permissions/decision'].POST;
    const decision = {
      clientRequestId: 'req-permission-1',
      chatId: '123',
      permissionRequestId: 'perm-1',
      allow: true,
      alwaysAllow: false,
    };

    const first = await callJson(handler, decision);
    const retry = await callJson(handler, decision);
    const conflict = await callJson(handler, { ...decision, allow: false });

    expect(first.response.status).toBe(200);
    expect(retry.body.status).toBe('duplicate');
    expect(conflict.response.status).toBe(409);
    expect(conflict.body.errorCode).toBe('IDEMPOTENCY_CONFLICT');
    expect(harness.providers.resolvePermission).toHaveBeenCalledTimes(1);
  });

  it('POST /stop deduplicates abort requests', async () => {
    const harness = createRouteHarness();
    const handler = harness.routes['/api/v1/chats/stop'].POST;
    const payload = { clientRequestId: 'req-stop-1', chatId: '123', provider: 'claude' };

    const first = await callJson(handler, payload);
    const retry = await callJson(handler, payload);

    expect(first.body.stopped).toBe(true);
    expect(retry.body.status).toBe('duplicate');
    expect(retry.body.stopped).toBe(true);
    expect(harness.queue.abort).toHaveBeenCalledTimes(1);
  });

  it('PATCH /execution-settings normalizes modes and patches provider and registry', async () => {
    const harness = createRouteHarness();

    const { response, body } = await callJson(
      harness.routes['/api/v1/chats/execution-settings'].PATCH,
      {
        chatId: '123',
        permissionMode: 'bogus',
        thinkingMode: 'think-hard',
        claudeThinkingMode: 'sometimes',
        ampAgentMode: 'unknown',
      },
      'PATCH',
    );

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      chatId: '123',
      permissionMode: 'default',
      thinkingMode: 'think-hard',
      claudeThinkingMode: 'auto',
      ampAgentMode: 'smart',
    });
    expect(harness.providers.setPermissionMode).toHaveBeenCalledWith('123', 'default');
    expect(harness.providers.setThinkingMode).toHaveBeenCalledWith('123', 'think-hard');
    expect(harness.providers.setClaudeThinkingMode).toHaveBeenCalledWith('123', 'auto');
    expect(harness.providers.setAmpAgentMode).toHaveBeenCalledWith('123', 'smart');
    expect(harness.registry.updateChat).toHaveBeenCalledWith('123', expect.objectContaining({
      permissionMode: 'default',
      thinkingMode: 'think-hard',
      claudeThinkingMode: 'auto',
      ampAgentMode: 'smart',
    }));
  });

  it('PATCH /model patches model selection metadata', async () => {
    const harness = createRouteHarness();

    const { response, body } = await callJson(
      harness.routes['/api/v1/chats/model'].PATCH,
      {
        chatId: '123',
        model: 'endpoint:model-a',
        apiProviderId: 'provider-1',
        modelEndpointId: 'endpoint',
        modelProtocol: 'openai-compatible',
      },
      'PATCH',
    );

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      chatId: '123',
      model: 'endpoint:model-a',
      apiProviderId: 'provider-1',
      modelEndpointId: 'endpoint',
      modelProtocol: 'openai-compatible',
    });
    expect(harness.providers.setModel).toHaveBeenCalledWith('123', 'endpoint:model-a', {
      apiProviderId: 'provider-1',
      modelEndpointId: 'endpoint',
    });
    expect(harness.registry.updateChat).toHaveBeenCalledWith('123', expect.objectContaining({
      model: 'endpoint:model-a',
      apiProviderId: 'provider-1',
      modelEndpointId: 'endpoint',
      modelProtocol: 'openai-compatible',
    }));
  });
});
