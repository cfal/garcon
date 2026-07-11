import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';

let testBasePath;
let workspaceDir;

class MalformedJsonError extends Error {
  constructor() { super('Malformed JSON'); this.name = 'MalformedJsonError'; }
}

mock.module('../../lib/http-request.js', () => ({
  parseJsonBody: mock(() => Promise.resolve({})),
  MalformedJsonError,
}));

mock.module('../../config.js', () => ({
  getProjectBasePath: mock(() => testBasePath),
  getWorkspaceDir: mock(() => workspaceDir),
  isHttpCompressionEnabled: mock(() => true),
}));

mock.module('../../chats/title-generator.js', () => ({
  maybeGenerateChatTitle: mock(() => Promise.resolve(undefined)),
  generateChatTitleFromMessage: mock(() => Promise.resolve({ chatId: CHAT_ID, title: 'Generated Title' })),
  TitleGenerationError: class TitleGenerationError extends Error {},
}));

mock.module('../../chats/fork-chat.js', () => ({
  forkChatFileCopy: mock(() => Promise.resolve({})),
}));

import createChatRoutes from '../chats.js';
import { parseJsonBody } from '../../lib/http-request.js';
import { forkChatFileCopy } from '../../chats/fork-chat.js';
import { ModelSelectionError } from '../../api-providers/endpoint-resolver.js';
import { AgentSwitchError } from '../../agents/agent-switch-service.js';
import { createRouteCommandLedger, createRouteCommandService, createRoutePendingInputs } from './chat-routes-test-utils.js';

const CHAT_ID = '1783725900000700';
const TARGET_CHAT_ID = '1783725900000701';

function createSession(overrides = {}) {
  return {
    id: CHAT_ID,
    agentId: 'claude',
    agentSessionId: 'provider-session-123',
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

function createRouteAgent(sessionOverrides = {}) {
  const sessions = new Map([
    [CHAT_ID, createSession(sessionOverrides)],
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
    recordChatStartup: mock(() => Promise.resolve(undefined)),
    removeFromAllOrderLists: mock(() => Promise.resolve(undefined)),
    removeSessionName: mock(() => Promise.resolve(undefined)),
    togglePin: mock(() => Promise.resolve({ isPinned: true })),
    toggleArchive: mock(() => Promise.resolve({ isArchived: true })),
    getPinnedChatIds: mock(() => []),
    getNormalChatIds: mock(() => []),
    getArchivedChatIds: mock(() => []),
    reorderWindow: mock(() => Promise.resolve({ success: true })),
    reorderRelative: mock(() => Promise.resolve({ success: true })),
  };
  const queue = {
    deleteChatQueueFile: mock(() => Promise.resolve(undefined)),
    submit: mock(() => Promise.resolve(undefined)),
    registerPendingUserInput: mock(() => Promise.resolve(undefined)),
    discardPendingUserInput: mock(() => true),
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
  const chatViews = {
    getOrCreatePage: mock(() => Promise.resolve({ messages: [], generationId: 'generation-1', lastSeq: 0, pageOldestSeq: 0, hasMore: false })),
  };
  const agents = {
    hasAgent: mock(() => true),
    supportsFork: mock(() => true),
    supportsForkAtMessage: mock(() => true),
    supportsForkWhileRunning: mock(() => false),
    supportsUpdateProjectPath: mock(() => true),
    supportsImages: mock(() => true),
    isAgentSessionRunning: mock(() => false),
    getRunningSessions: mock(() => ({ claude: [{ id: CHAT_ID }] })),
    startSession: mock(() => Promise.resolve(undefined)),
    modelSupportsImages: mock(() => Promise.resolve(true)),
    runSingleQuery: mock(() => Promise.resolve('title')),
    resolvePermission: mock(() => undefined),
    resolveNativePath: mock((chat) => Promise.resolve(chat.nativePath ?? null)),
    prepareProjectPathUpdate: mock(() => Promise.resolve(undefined)),
    updateSessionSettings: mock((chatId, patch) => Promise.resolve(registry.updateChat(chatId, patch))),
  };
  const agentSwitch = {
    switchAgentModel: mock((req) => Promise.resolve(registry.updateChat(req.chatId, {
      agentId: req.agentId,
      model: req.model,
      apiProviderId: req.apiProviderId ?? null,
      modelEndpointId: req.modelEndpointId ?? null,
      modelProtocol: req.modelProtocol ?? null,
      permissionMode: 'default',
      thinkingMode: 'none',
      claudeThinkingMode: 'auto',
      ampAgentMode: 'smart',
    }))),
  };
  const commandLedger = createRouteCommandLedger('chats-command-routes');
  const pendingInputs = createRoutePendingInputs();
  const routes = createChatRoutes({
    registry,
    settings,
    queue,
    pathCache,
    metadata,
    chatViews,
    agents,
    pendingInputs,
    agentSwitch,
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
  return { sessions, registry, settings, queue, pathCache, metadata, chatViews, agents, agentSwitch, routes };
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
    chatId: CHAT_ID,
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

  it('POST /run returns before agent completion and persists before running', async () => {
    const agent = createRouteAgent();
    const order = [];
    let resolveRun;
    const runPromise = new Promise((resolve) => { resolveRun = resolve; });
    agent.queue.registerPendingUserInput.mockImplementation(() => {
      order.push('pending');
      return Promise.resolve();
    });
    agent.queue.runAcceptedTurn.mockImplementation(() => {
      order.push('run');
      return runPromise;
    });

    const { response, body } = await callJson(agent.routes['/api/v1/chats/run'].POST, agentRunBody());

    expect(response.status).toBe(202);
    expect(body).toMatchObject({
      success: true,
      commandType: 'agent-run',
      clientRequestId: 'req-run-1',
      chatId: CHAT_ID,
      status: 'accepted',
    });
    expect(typeof body.turnId).toBe('string');
    expect(order).toEqual(['pending', 'run']);
    expect(agent.queue.registerPendingUserInput).toHaveBeenCalledWith(CHAT_ID, 'hello', expect.objectContaining({
      clientRequestId: 'req-run-1',
      clientMessageId: 'msg-run-1',
      turnId: body.turnId,
      model: 'opus',
    }));

    resolveRun();
  });

  it('POST /run deduplicates same payload retries without re-running side effects', async () => {
    const agent = createRouteAgent();
    const handler = agent.routes['/api/v1/chats/run'].POST;

    await callJson(handler, agentRunBody());
    const retry = await callJson(handler, agentRunBody());

    expect(retry.response.status).toBe(202);
    expect(retry.body.status).toBe('duplicate');
    expect(agent.queue.registerPendingUserInput).toHaveBeenCalledTimes(1);
    expect(agent.queue.runAcceptedTurn).toHaveBeenCalledTimes(1);
  });

  it('POST /run rejects conflicting idempotency retries', async () => {
    const agent = createRouteAgent();
    const handler = agent.routes['/api/v1/chats/run'].POST;

    await callJson(handler, agentRunBody());
    const conflict = await callJson(handler, agentRunBody({ command: 'different command' }));

    expect(conflict.response.status).toBe(409);
    expect(conflict.body.errorCode).toBe('IDEMPOTENCY_CONFLICT');
    expect(agent.queue.registerPendingUserInput).toHaveBeenCalledTimes(1);
  });

  it('POST /run validates content and session existence', async () => {
    const emptyAgent = createRouteAgent();
    const empty = await callJson(emptyAgent.routes['/api/v1/chats/run'].POST, agentRunBody({ command: '   ' }));
    expect(empty.response.status).toBe(400);
    expect(empty.body.error).toContain('command or images');

    const missingAgent = createRouteAgent();
    missingAgent.registry.getChat.mockReturnValue(null);
    const missing = await callJson(missingAgent.routes['/api/v1/chats/run'].POST, agentRunBody());
    expect(missing.response.status).toBe(404);
    expect(missing.body.errorCode).toBe('SESSION_NOT_FOUND');
  });

  it('POST /fork-run forks once and schedules the target turn', async () => {
    const agent = createRouteAgent();
    const { response, body } = await callJson(agent.routes['/api/v1/chats/fork-run'].POST, {
      ...agentRunBody({
        clientRequestId: 'req-fork-run-1',
        clientMessageId: 'msg-fork-run-1',
        sourceChatId: CHAT_ID,
        chatId: TARGET_CHAT_ID,
        command: 'continue here',
      }),
    });

    expect(response.status).toBe(202);
    expect(body.commandType).toBe('fork-run');
    expect(body.sourceChatId).toBe(CHAT_ID);
    expect(body.chatId).toBe(TARGET_CHAT_ID);
    expect(forkChatFileCopy).toHaveBeenCalledTimes(1);
    expect(agent.queue.registerPendingUserInput).toHaveBeenCalledWith(TARGET_CHAT_ID, 'continue here', expect.objectContaining({
      clientRequestId: 'req-fork-run-1',
      clientMessageId: 'msg-fork-run-1',
    }));
  });

  it('POST /fork-run rejects busy source sessions before copying', async () => {
    const agent = createRouteAgent();
    agent.agents.isAgentSessionRunning.mockReturnValue(true);

    const { response, body } = await callJson(agent.routes['/api/v1/chats/fork-run'].POST, {
      ...agentRunBody({
        clientRequestId: 'req-fork-run-2',
        clientMessageId: 'msg-fork-run-2',
        sourceChatId: CHAT_ID,
        chatId: TARGET_CHAT_ID,
        command: 'continue',
      }),
    });

    expect(response.status).toBe(409);
    expect(body.errorCode).toBe('SESSION_BUSY');
    expect(forkChatFileCopy).not.toHaveBeenCalled();
    expect(agent.queue.registerPendingUserInput).not.toHaveBeenCalled();
  });

  it('POST /queue/enqueue accepts, deduplicates, and preserves queue state', async () => {
    const agent = createRouteAgent();
    const handler = agent.routes['/api/v1/chats/queue/enqueue'].POST;
    const payload = { clientRequestId: 'req-queue-1', chatId: CHAT_ID, content: 'queued' };

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
    expect(agent.queue.enqueueChat).toHaveBeenCalledTimes(1);
  });

  it('POST /queue/enqueue rejects conflicting retries', async () => {
    const agent = createRouteAgent();
    const handler = agent.routes['/api/v1/chats/queue/enqueue'].POST;

    await callJson(handler, { clientRequestId: 'req-queue-1', chatId: CHAT_ID, content: 'first' });
    const conflict = await callJson(handler, { clientRequestId: 'req-queue-1', chatId: CHAT_ID, content: 'second' });

    expect(conflict.response.status).toBe(409);
    expect(conflict.body.errorCode).toBe('IDEMPOTENCY_CONFLICT');
    expect(agent.queue.enqueueChat).toHaveBeenCalledTimes(1);
  });

  it('queue mutations return normalized authoritative state', async () => {
    const agent = createRouteAgent();

    const paused = await callJson(agent.routes['/api/v1/chats/queue/pause'].POST, { chatId: CHAT_ID });
    const resumed = await callJson(agent.routes['/api/v1/chats/queue/resume'].POST, { chatId: CHAT_ID });

    expect(paused.body.queue.paused).toBe(true);
    expect(paused.body.queue.version).toBe(2);
    expect(resumed.body.queue.paused).toBe(false);
    expect(resumed.body.queue.version).toBe(3);
    expect(agent.queue.triggerDrain).toHaveBeenCalledTimes(1);
  });

  it('POST /permissions/decision deduplicates identical decisions and rejects conflicts', async () => {
    const agent = createRouteAgent();
    const handler = agent.routes['/api/v1/chats/permissions/decision'].POST;
    const decision = {
      clientRequestId: 'req-permission-1',
      chatId: CHAT_ID,
      permissionRequestId: 'perm-1',
      allow: true,
      alwaysAllow: false,
      response: { outcome: { outcome: 'accepted' } },
    };

    const first = await callJson(handler, decision);
    const retry = await callJson(handler, decision);
    const conflict = await callJson(handler, { ...decision, allow: false });

    expect(first.response.status).toBe(200);
    expect(retry.body.status).toBe('duplicate');
    expect(conflict.response.status).toBe(409);
    expect(conflict.body.errorCode).toBe('IDEMPOTENCY_CONFLICT');
    expect(agent.agents.resolvePermission).toHaveBeenCalledTimes(1);
    expect(agent.agents.resolvePermission).toHaveBeenCalledWith(CHAT_ID, 'perm-1', {
      allow: true,
      alwaysAllow: false,
      response: { outcome: { outcome: 'accepted' } },
    });
  });

  it('POST /stop deduplicates abort requests', async () => {
    const agent = createRouteAgent();
    const handler = agent.routes['/api/v1/chats/stop'].POST;
    const payload = { clientRequestId: 'req-stop-1', chatId: CHAT_ID, agentId: 'claude' };

    const first = await callJson(handler, payload);
    const retry = await callJson(handler, payload);

    expect(first.body.stopped).toBe(true);
    expect(retry.body.status).toBe('duplicate');
    expect(retry.body.stopped).toBe(true);
    expect(agent.queue.abort).toHaveBeenCalledTimes(1);
  });

  it('PATCH /execution-settings normalizes modes and patches agent and registry', async () => {
    const agent = createRouteAgent();

    const { response, body } = await callJson(
      agent.routes['/api/v1/chats/execution-settings'].PATCH,
      {
        chatId: CHAT_ID,
        permissionMode: 'bogus',
        thinkingMode: 'medium',
        claudeThinkingMode: 'sometimes',
        ampAgentMode: 'unknown',
      },
      'PATCH',
    );

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      chatId: CHAT_ID,
      permissionMode: 'default',
      thinkingMode: 'medium',
      claudeThinkingMode: 'auto',
      ampAgentMode: 'smart',
    });
    expect(agent.agents.updateSessionSettings).toHaveBeenCalledWith(CHAT_ID, expect.objectContaining({
      permissionMode: 'default',
      thinkingMode: 'medium',
      claudeThinkingMode: 'auto',
      ampAgentMode: 'smart',
    }));
  });

  it('PATCH /execution-settings preserves manual bypass mode', async () => {
    const agent = createRouteAgent();

    const { response, body } = await callJson(
      agent.routes['/api/v1/chats/execution-settings'].PATCH,
      {
        chatId: CHAT_ID,
        permissionMode: 'manualBypass',
      },
      'PATCH',
    );

    expect(response.status).toBe(200);
    expect(body.permissionMode).toBe('manualBypass');
    expect(agent.agents.updateSessionSettings).toHaveBeenCalledWith(CHAT_ID, {
      permissionMode: 'manualBypass',
    });
  });

  it('PATCH /execution-settings returns 400 when chatId is missing', async () => {
    const agent = createRouteAgent();

    const { response, body } = await callJson(
      agent.routes['/api/v1/chats/execution-settings'].PATCH,
      { permissionMode: 'default' },
      'PATCH',
    );

    expect(response.status).toBe(400);
    expect(body.errorCode).toBe('VALIDATION_FAILED');
    expect(body.error).toBe('chatId is required');
  });

  it('PATCH /model patches model selection metadata', async () => {
    const agent = createRouteAgent();

    const { response, body } = await callJson(
      agent.routes['/api/v1/chats/model'].PATCH,
      {
        chatId: CHAT_ID,
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
      chatId: CHAT_ID,
      model: 'endpoint:model-a',
      apiProviderId: 'provider-1',
      modelEndpointId: 'endpoint',
      modelProtocol: 'openai-compatible',
    });
    expect(agent.agents.updateSessionSettings).toHaveBeenCalledWith(CHAT_ID, expect.objectContaining({
      model: 'endpoint:model-a',
      apiProviderId: 'provider-1',
      modelEndpointId: 'endpoint',
    }));
    expect(agent.registry.updateChat).toHaveBeenCalledWith(CHAT_ID, expect.objectContaining({
      model: 'endpoint:model-a',
      apiProviderId: 'provider-1',
      modelEndpointId: 'endpoint',
      modelProtocol: 'openai-compatible',
    }));
  });

  it('PATCH /model returns 400 when model is missing', async () => {
    const agent = createRouteAgent();

    const { response, body } = await callJson(
      agent.routes['/api/v1/chats/model'].PATCH,
      { chatId: CHAT_ID },
      'PATCH',
    );

    expect(response.status).toBe(400);
    expect(body.errorCode).toBe('VALIDATION_FAILED');
    expect(body.error).toBe('model is required');
  });

  it('PATCH /model maps model selection failures to 422', async () => {
    const agent = createRouteAgent();
    agent.agents.updateSessionSettings.mockRejectedValueOnce(
      new ModelSelectionError('Endpoint not found', 'ENDPOINT_NOT_FOUND'),
    );

    const { response, body } = await callJson(
      agent.routes['/api/v1/chats/model'].PATCH,
      { chatId: CHAT_ID, model: 'missing:model' },
      'PATCH',
    );

    expect(response.status).toBe(422);
    expect(body.errorCode).toBe('MODEL_SELECTION_ERROR');
    expect(body.error).toBe('Endpoint not found');
  });

  it('PATCH /agent-model maps active-turn switch conflicts to 409', async () => {
    const agent = createRouteAgent();
    agent.agentSwitch.switchAgentModel.mockRejectedValueOnce(
      new AgentSwitchError('Stop the current turn before switching agents.', 409, 'SESSION_BUSY'),
    );

    const { response, body } = await callJson(
      agent.routes['/api/v1/chats/agent-model'].PATCH,
      { chatId: CHAT_ID, agentId: 'codex', model: 'gpt-5' },
      'PATCH',
    );

    expect(response.status).toBe(409);
    expect(body.errorCode).toBe('SESSION_BUSY');
    expect(body.error).toBe('Stop the current turn before switching agents.');
    expect(body.retryable).toBe(false);
  });

  it('PATCH /project-path validates, prepares the agent, and patches the registry', async () => {
    const agent = createRouteAgent();
    const nextPath = path.join(testBasePath, 'repo-worktree');
    await fs.mkdir(nextPath, { recursive: true });
    const realNextPath = await fs.realpath(nextPath);

    const { response, body } = await callJson(
      agent.routes['/api/v1/chats/project-path'].PATCH,
      { chatId: CHAT_ID, projectPath: nextPath },
      'PATCH',
    );

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      chatId: CHAT_ID,
      projectPath: realNextPath,
      previousProjectPath: '/workspace/project',
      nativePath: '/tmp/session.jsonl',
    });
    expect(agent.agents.prepareProjectPathUpdate).toHaveBeenCalledWith('claude', expect.objectContaining({
      chatId: CHAT_ID,
      agentSessionId: 'provider-session-123',
      previousProjectPath: '/workspace/project',
      nextProjectPath: realNextPath,
      nativePath: '/tmp/session.jsonl',
    }));
    expect(agent.registry.updateChat).toHaveBeenCalledWith(
      CHAT_ID,
      expect.objectContaining({ projectPath: realNextPath }),
      { flush: true },
    );
    expect(agent.sessions.get(CHAT_ID).projectPath).toBe(realNextPath);
  });

  it('PATCH /project-path rejects unsupported agents', async () => {
    const agent = createRouteAgent({ agentId: 'opencode' });
    const nextPath = path.join(testBasePath, 'repo-worktree');
    await fs.mkdir(nextPath, { recursive: true });
    agent.agents.supportsUpdateProjectPath.mockReturnValue(false);

    const { response, body } = await callJson(
      agent.routes['/api/v1/chats/project-path'].PATCH,
      { chatId: CHAT_ID, projectPath: nextPath },
      'PATCH',
    );

    expect(response.status).toBe(422);
    expect(body.errorCode).toBe('PROJECT_PATH_UPDATE_UNSUPPORTED');
    expect(agent.agents.prepareProjectPathUpdate).not.toHaveBeenCalled();
  });

  it('PATCH /project-path rejects chats with queued messages', async () => {
    const agent = createRouteAgent();
    const nextPath = path.join(testBasePath, 'repo-worktree');
    await fs.mkdir(nextPath, { recursive: true });
    agent.queue.readChatQueue.mockResolvedValueOnce({
      entries: [{ id: 'entry-1', content: 'queued', status: 'queued', createdAt: '2026-05-14T00:00:00.000Z' }],
      paused: false,
      version: 1,
    });

    const { response, body } = await callJson(
      agent.routes['/api/v1/chats/project-path'].PATCH,
      { chatId: CHAT_ID, projectPath: nextPath },
      'PATCH',
    );

    expect(response.status).toBe(409);
    expect(body.errorCode).toBe('CHAT_NOT_IDLE');
    expect(agent.agents.prepareProjectPathUpdate).not.toHaveBeenCalled();
  });
});
