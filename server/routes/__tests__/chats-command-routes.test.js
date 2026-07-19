import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';

let testBasePath;
let workspaceDir;

class MalformedJsonError extends Error {
  constructor() {
    super('Malformed JSON');
    this.name = 'MalformedJsonError';
  }
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
import { DomainError } from '../../lib/domain-error.js';
import {
  QueueEntryMutationError,
  QueuePauseChangedError,
  RecoveredInputContinuationChangedError,
  RecoveredInputContinuationRequiresQueueError,
} from '../../queue.js';
import {
  createRouteChatListProjector,
  createRouteCommandLedger,
  createRouteCommandService,
  createRoutePathCache,
  createRoutePendingInputs,
} from './chat-routes-test-utils.js';

const CHAT_ID = '1783725900000700';
const TARGET_CHAT_ID = '1783725900000701';

function queueEntry(id, content = 'queued', status = 'queued', revision = 1) {
  return {
    id,
    content,
    status,
    revision,
    createdAt: '2026-05-14T00:00:00.000Z',
    updatedAt: '2026-05-14T00:00:00.000Z',
  };
}

function storedQueue(entries = [], overrides = {}) {
  return {
    entries,
    recentlyDispatched: [],
    appliedCommands: [],
    pause: null,
    recoveredInputContinuation: null,
    version: 0,
    updatedAt: null,
    ...overrides,
  };
}

function manualPause(id = 'pause-1') {
  return { id, kind: 'manual', pausedAt: '2026-07-16T00:00:00.000Z' };
}

function createSession(overrides = {}) {
  return {
    id: CHAT_ID,
    agentId: 'claude',
    agentSessionId: 'provider-session-123',
    nativeSession: {
      ownerId: 'claude',
      schemaVersion: 1,
      value: { path: '/tmp/session.jsonl', agentSessionId: 'provider-session-123' },
    },
    agentOwnershipEpoch: 'epoch-1',
    agentSettingsById: {
      claude: { ownerId: 'claude', schemaVersion: 1, values: {} },
    },
    projectPath: '/workspace/project',
    model: 'opus',
    permissionMode: 'default',
    thinkingMode: 'none',
    ...overrides,
  };
}

function createRouteAgent(sessionOverrides = {}) {
  const normalIds = [];
  const sessions = new Map([[CHAT_ID, createSession(sessionOverrides)]]);
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
    updateProjectPath: mock((chatId, update) => {
      const current = sessions.get(chatId);
      if (!current) return Promise.resolve(null);
      const next = {
        ...current,
        projectPath: update.projectPath,
        ...('nativeSession' in update ? { nativeSession: update.nativeSession } : {}),
      };
      sessions.set(chatId, next);
      return Promise.resolve(next);
    }),
    removeChat: mock((chatId) => sessions.delete(chatId)),
    listAllChats: mock(() => Object.fromEntries(sessions.entries())),
  };
  const settings = {
    getChatName: mock(() => null),
    ensureInNormal: mock((chatId) => {
      normalIds.splice(normalIds.indexOf(chatId), normalIds.includes(chatId) ? 1 : 0);
      normalIds.unshift(chatId);
      return Promise.resolve(undefined);
    }),
    recordChatStartup: mock(() => Promise.resolve(undefined)),
    removeFromAllOrderLists: mock(() => Promise.resolve(undefined)),
    removeSessionName: mock(() => Promise.resolve(undefined)),
    togglePin: mock(() => Promise.resolve({ isPinned: true })),
    toggleArchive: mock(() => Promise.resolve({ isArchived: true })),
    getPinnedChatIds: mock(() => []),
    getNormalChatIds: mock(() => [...normalIds]),
    getArchivedChatIds: mock(() => []),
    reorderWindow: mock(() => Promise.resolve({ success: true })),
    reorderRelative: mock(() => Promise.resolve({ success: true })),
  };
  const queue = {
    deleteChatQueueFile: mock(() => Promise.resolve(undefined)),
    submit: mock(() => Promise.resolve(undefined)),
    registerPendingUserInput: mock(() => Promise.resolve(undefined)),
    reserveDirectTurn: mock((chatId) => ({
      chatId,
      reservationId: 'reservation-1',
      executionAdmission: {
        signal: new AbortController().signal,
        markStarted() {},
      },
    })),
    releaseDirectTurn: mock(() => Promise.resolve(undefined)),
    assertDirectTurnReservationActive: mock(() => undefined),
    consumeRecoveredInputContinuationForDirectTurn: mock(() => Promise.resolve(storedQueue())),
    completeDirectTurn: mock(() => Promise.resolve(undefined)),
    failDirectTurn: mock(() => Promise.resolve(undefined)),
    runReservedTurn: mock(() => Promise.resolve(undefined)),
    stopActiveTurn: mock(() => Promise.resolve({
      stopped: true,
      control: storedQueue([], { version: 1 }),
    })),
    interruptActiveTurn: mock(() => Promise.resolve(true)),
    abortForChatDeletion: mock(() => Promise.resolve(true)),
    triggerDrain: mock(() => Promise.resolve(undefined)),
    isChatExecutionReserved: mock(() => false),
    hasChatExecutionOwner: mock(() => false),
    readChatExecutionControl: mock(() => Promise.resolve(storedQueue())),
    createChatQueueEntry: mock(() =>
      Promise.resolve({
        entry: queueEntry('entry-1'),
        entryId: 'entry-1',
        control: storedQueue([queueEntry('entry-1')], {
          version: 1,
          updatedAt: '2026-05-14T00:00:00.000Z',
        }),
        duplicate: false,
      }),
    ),
    replaceChatQueueEntry: mock((_chatId, entryId, content, revision) =>
      Promise.resolve({
        entry: queueEntry(entryId, content, 'queued', revision + 1),
        entryId,
        control: storedQueue([queueEntry(entryId, content, 'queued', revision + 1)], { version: 2 }),
        duplicate: false,
      }),
    ),
    deleteChatQueueEntry: mock((_chatId, entryId) =>
      Promise.resolve({
        entryId,
        control: storedQueue([], { version: 2 }),
        duplicate: false,
      }),
    ),
    deliverActiveInput: mock(async (_chatId, _content, _options, beforeDelivery) => {
      await beforeDelivery();
      return true;
    }),
    clearChatQueue: mock(() => Promise.resolve(storedQueue([], { version: 2 }))),
    pauseChatQueue: mock(() => Promise.resolve(storedQueue(
      [queueEntry('entry-1')],
      { pause: manualPause(), version: 2 },
    ))),
    resumeChatQueue: mock(() => Promise.resolve(storedQueue([queueEntry('entry-1')], { version: 3 }))),
    continuePastRecoveredInput: mock(() => Promise.resolve(storedQueue([queueEntry('entry-1')], { version: 3 }))),
  };
  const pathCache = createRoutePathCache();
  const metadata = {
    addNewChatMetadata: mock(() => undefined),
    listAllChatMetadata: mock(() => new Map()),
    getChatMetadata: mock(() => null),
  };
  const chatViews = {
    getOrCreatePage: mock(() =>
      Promise.resolve({
        messages: [],
        generationId: 'generation-1',
        lastSeq: 0,
        pageOldestSeq: 0,
        hasMore: false,
      }),
    ),
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
    forkAgentSession: mock(() => Promise.resolve({})),
    resolvePermission: mock(() => undefined),
    resolveNativeSession: mock((chat) => Promise.resolve(chat.nativeSession ?? null)),
    prepareProjectPathUpdate: mock(() => Promise.resolve(undefined)),
    updateSessionSettings: mock((chatId, patch) => Promise.resolve(registry.updateChat(chatId, patch))),
  };
  const agentSwitch = {
    switchAgentModel: mock((req) =>
      Promise.resolve(
        registry.updateChat(req.chatId, {
          agentId: req.agentId,
          model: req.model,
          apiProviderId: req.apiProviderId ?? null,
          modelEndpointId: req.modelEndpointId ?? null,
          modelProtocol: req.modelProtocol ?? null,
          permissionMode: 'default',
          thinkingMode: 'none',
        }),
      ),
    ),
  };
  const commandLedger = createRouteCommandLedger('chats-command-routes');
  const pendingInputs = createRoutePendingInputs();
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
    pathCache,
    metadata,
    chatViews,
    agents,
    pendingInputs,
    agentSwitch,
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
      forkChatFileCopy: async (args) => {
        await forkChatFileCopy(args);
        const { sourceSession, targetChatId } = args;
        registry.addChat({
          ...sourceSession,
          id: targetChatId,
          agentSessionId: 'forked-session',
          nativeSession: {
            ownerId: sourceSession.agentId,
            schemaVersion: 1,
            value: { id: 'forked-session' },
          },
          agentOwnershipEpoch: 'forked-epoch',
        });
        await settings.ensureInNormal(targetChatId);
        return {
          sourceChatId: CHAT_ID,
          chatId: targetChatId,
          agentId: sourceSession.agentId,
          agentSessionId: 'forked-session',
        };
      },
    }),
  });
  return {
    sessions,
    registry,
    settings,
    queue,
    pathCache,
    metadata,
    chatViews,
    agents,
    agentSwitch,
    routes,
  };
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
    agentSettings: { ownerId: 'claude', schemaVersion: 1, values: {} },
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
    const runPromise = new Promise((resolve) => {
      resolveRun = resolve;
    });
    agent.queue.registerPendingUserInput.mockImplementation(() => {
      order.push('pending');
      return Promise.resolve();
    });
    agent.queue.runReservedTurn.mockImplementation(() => {
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
    expect(agent.queue.registerPendingUserInput).toHaveBeenCalledWith(
      CHAT_ID,
      'hello',
      expect.objectContaining({
        clientRequestId: 'req-run-1',
        clientMessageId: 'msg-run-1',
        turnId: body.turnId,
        model: 'opus',
      }),
    );

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
    expect(agent.queue.runReservedTurn).toHaveBeenCalledTimes(1);
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

  it('POST /run returns current execution control when direct admission is busy', async () => {
    const agent = createRouteAgent();
    const control = storedQueue([], {
      version: 4,
      updatedAt: '2026-07-18T00:00:00.000Z',
    });
    agent.queue.readChatExecutionControl.mockResolvedValue(control);
    agent.queue.reserveDirectTurn.mockImplementation(() => {
      throw new DomainError('SESSION_BUSY', 'Another chat turn already owns execution', 409, true);
    });

    const { response, body } = await callJson(
      agent.routes['/api/v1/chats/run'].POST,
      agentRunBody({ clientRequestId: 'req-run-busy', clientMessageId: 'msg-run-busy' }),
    );

    expect(response.status).toBe(409);
    expect(body).toMatchObject({
      success: false,
      errorCode: 'SESSION_BUSY',
      retryable: true,
      control: {
        version: 4,
        recoveredInputContinuation: null,
        queue: { entries: [], pause: null },
      },
    });
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
    expect(body.chatId).toBe(TARGET_CHAT_ID);
    expect(body.chat).toMatchObject({
      id: TARGET_CHAT_ID,
      orderGroup: 'normal',
    });
    expect(forkChatFileCopy).toHaveBeenCalledTimes(1);
    expect(agent.queue.registerPendingUserInput).toHaveBeenCalledWith(
      TARGET_CHAT_ID,
      'continue here',
      expect.objectContaining({
        clientRequestId: 'req-fork-run-1',
        clientMessageId: 'msg-fork-run-1',
      }),
    );
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

  it('POST /queue/entries creates, deduplicates, and preserves queue state', async () => {
    const agent = createRouteAgent();
    const handler = agent.routes['/api/v1/chats/queue/entries'].POST;
    const payload = {
      clientRequestId: 'req-queue-1',
      chatId: CHAT_ID,
      content: 'queued',
    };

    const first = await callJson(handler, payload);
    const retry = await callJson(handler, payload);

    expect(first.response.status).toBe(202);
    expect(first.body).toMatchObject({
      commandType: 'queue-entry-create',
      clientRequestId: 'req-queue-1',
      entryId: 'entry-1',
    });
    expect(first.body.control.version).toBe(1);
    expect(retry.response.status).toBe(202);
    expect(retry.body.status).toBe('duplicate');
    expect(agent.queue.createChatQueueEntry).toHaveBeenCalledTimes(1);
    expect(agent.queue.createChatQueueEntry).toHaveBeenCalledWith(
      CHAT_ID,
      'queued',
      expect.objectContaining({
        key: `queue-entry-create:${CHAT_ID}:req-queue-1`,
      }),
    );
  });

  it('PUT and DELETE /queue/entries mutate the entry by stable ID', async () => {
    const agent = createRouteAgent();
    const route = agent.routes['/api/v1/chats/queue/entries'];

    const replaced = await callJson(
      route.PUT,
      {
        clientRequestId: 'req-replace-1',
        chatId: CHAT_ID,
        entryId: 'entry-1',
        content: '  edited in the middle\n',
        expectedRevision: 4,
      },
      'PUT',
    );
    const deleted = await callJson(
      route.DELETE,
      {
        clientRequestId: 'req-delete-1',
        chatId: CHAT_ID,
        entryId: 'entry-1',
      },
      'DELETE',
    );

    expect(replaced.response.status).toBe(200);
    expect(agent.queue.replaceChatQueueEntry).toHaveBeenCalledWith(CHAT_ID, 'entry-1', '  edited in the middle\n', 4, {
      key: `queue-entry-replace:${CHAT_ID}:req-replace-1`,
      entryId: 'entry-1',
    });
    expect(deleted.response.status).toBe(200);
    expect(agent.queue.deleteChatQueueEntry).toHaveBeenCalledWith(CHAT_ID, 'entry-1', {
      key: `queue-entry-delete:${CHAT_ID}:req-delete-1`,
      entryId: 'entry-1',
    });
  });

  it('POST /active-input uses the independent active delivery command', async () => {
    const agent = createRouteAgent();
    const result = await callJson(agent.routes['/api/v1/chats/active-input'].POST, {
      clientRequestId: 'req-steer-1',
      chatId: CHAT_ID,
      content: 'focus here',
    });

    expect(result.response.status).toBe(202);
    expect(result.body.delivery).toBe('active');
    expect(agent.queue.deliverActiveInput).toHaveBeenCalledWith(CHAT_ID, 'focus here', {
      clientRequestId: 'req-steer-1',
    }, expect.any(Function));
  });

  it('POST /queue/entries rejects conflicting retries', async () => {
    const agent = createRouteAgent();
    const handler = agent.routes['/api/v1/chats/queue/entries'].POST;

    await callJson(handler, {
      clientRequestId: 'req-queue-1',
      chatId: CHAT_ID,
      content: 'first',
    });
    const conflict = await callJson(handler, {
      clientRequestId: 'req-queue-1',
      chatId: CHAT_ID,
      content: 'second',
    });

    expect(conflict.response.status).toBe(409);
    expect(conflict.body.errorCode).toBe('IDEMPOTENCY_CONFLICT');
    expect(agent.queue.createChatQueueEntry).toHaveBeenCalledTimes(1);
  });

  it('returns the latest queue snapshot with revision conflicts', async () => {
    const agent = createRouteAgent();
    const currentQueue = storedQueue([queueEntry('entry-1', 'edited elsewhere', 'queued', 5)], { version: 8 });
    agent.queue.replaceChatQueueEntry.mockRejectedValueOnce(
      new QueueEntryMutationError(
        'QUEUE_ENTRY_REVISION_CONFLICT',
        'This queued message changed before it could be saved',
        currentQueue,
      ),
    );

    const result = await callJson(
      agent.routes['/api/v1/chats/queue/entries'].PUT,
      {
        clientRequestId: 'req-conflict',
        chatId: CHAT_ID,
        entryId: 'entry-1',
        content: 'local draft',
        expectedRevision: 4,
      },
      'PUT',
    );

    expect(result.response.status).toBe(409);
    expect(result.body.errorCode).toBe('QUEUE_ENTRY_REVISION_CONFLICT');
    expect(result.body.control.queue.entries).toEqual([expect.objectContaining({ id: 'entry-1', revision: 5 })]);
    expect(result.body.control.queue.entries[0]).not.toHaveProperty('status');
  });

  it('queue mutations return normalized authoritative state', async () => {
    const agent = createRouteAgent();

    const paused = await callJson(agent.routes['/api/v1/chats/queue/pause'].POST, { chatId: CHAT_ID });
    const resumed = await callJson(agent.routes['/api/v1/chats/queue/resume'].POST, {
      chatId: CHAT_ID,
      pauseId: 'pause-1',
    });

    expect(paused.body.control.queue.pause).not.toBeNull();
    expect(paused.body.control.version).toBe(2);
    expect(resumed.body.control.queue.pause).toBeNull();
    expect(resumed.body.control.version).toBe(3);
    expect(agent.queue.triggerDrain).toHaveBeenCalledTimes(1);
    expect(agent.queue.resumeChatQueue).toHaveBeenCalledWith(CHAT_ID, 'pause-1');
  });

  it('returns the latest queue when resume names a superseded pause', async () => {
    const agent = createRouteAgent();
    const latestQueue = storedQueue([queueEntry('entry-1')], {
      pause: {
        id: 'pause-new',
        kind: 'queued-turn-failed',
        entryId: 'entry-1',
        pausedAt: '2026-07-16T00:00:00.000Z',
      },
      version: 4,
    });
    agent.queue.resumeChatQueue.mockRejectedValueOnce(new QueuePauseChangedError(latestQueue));

    const result = await callJson(agent.routes['/api/v1/chats/queue/resume'].POST, {
      chatId: CHAT_ID,
      pauseId: 'pause-old',
    });

    expect(result.response.status).toBe(409);
    expect(result.body.errorCode).toBe('QUEUE_PAUSE_CHANGED');
    expect(result.body.control.queue.pause).toMatchObject({
      id: 'pause-new',
      kind: 'queued-turn-failed',
    });
    expect(agent.queue.triggerDrain).not.toHaveBeenCalled();
  });

  it('continues recovered input by stable ID and returns the current composite control', async () => {
    const agent = createRouteAgent();
    const continuationId = '4c31d9ed-f33a-4ccc-8bd1-b11f88d08040';
    const continued = storedQueue([queueEntry('entry-1')], { version: 7 });
    agent.queue.continuePastRecoveredInput.mockResolvedValueOnce(continued);

    const result = await callJson(agent.routes['/api/v1/chats/recovered-input/continue'].POST, {
      chatId: CHAT_ID,
      continuationId,
    });

    expect(result.response.status).toBe(200);
    expect(agent.queue.continuePastRecoveredInput).toHaveBeenCalledWith(CHAT_ID, continuationId);
    expect(result.body.control).toMatchObject({
      version: 7,
      recoveredInputContinuation: null,
      queue: { entries: [expect.objectContaining({ id: 'entry-1' })] },
    });
  });

  it('returns the current composite control for stale continuation IDs', async () => {
    const agent = createRouteAgent();
    const latest = storedQueue([queueEntry('entry-1')], {
      recoveredInputContinuation: {
        id: '20b5a703-199d-4d29-ae05-d0942574cb79',
        installedAt: '2026-07-18T00:00:00.000Z',
      },
      version: 8,
    });
    agent.queue.continuePastRecoveredInput.mockRejectedValueOnce(
      new RecoveredInputContinuationChangedError(latest),
    );

    const result = await callJson(agent.routes['/api/v1/chats/recovered-input/continue'].POST, {
      chatId: CHAT_ID,
      continuationId: '4c31d9ed-f33a-4ccc-8bd1-b11f88d08040',
    });

    expect(result.response.status).toBe(409);
    expect(result.body.errorCode).toBe('RECOVERED_INPUT_CONTINUATION_CHANGED');
    expect(result.body.control.recoveredInputContinuation.id).toBe(
      '20b5a703-199d-4d29-ae05-d0942574cb79',
    );
  });

  it('preserves continuation when a stale dialog continues an already-empty queue', async () => {
    const agent = createRouteAgent();
    const latest = storedQueue([], {
      recoveredInputContinuation: {
        id: '20b5a703-199d-4d29-ae05-d0942574cb79',
        installedAt: '2026-07-18T00:00:00.000Z',
      },
      version: 9,
    });
    agent.queue.continuePastRecoveredInput.mockRejectedValueOnce(
      new RecoveredInputContinuationRequiresQueueError(latest),
    );

    const result = await callJson(agent.routes['/api/v1/chats/recovered-input/continue'].POST, {
      chatId: CHAT_ID,
      continuationId: latest.recoveredInputContinuation.id,
    });

    expect(result.response.status).toBe(409);
    expect(result.body.errorCode).toBe('RECOVERED_INPUT_CONTINUATION_REQUIRES_QUEUE');
    expect(result.body.control).toMatchObject({
      version: 9,
      recoveredInputContinuation: { id: latest.recoveredInputContinuation.id },
      queue: { entries: [] },
    });
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

  it('POST /stop deduplicates pause-and-stop requests', async () => {
    const agent = createRouteAgent();
    const handler = agent.routes['/api/v1/chats/stop'].POST;
    const payload = {
      clientRequestId: 'req-stop-1',
      chatId: CHAT_ID,
      agentId: 'claude',
    };

    const first = await callJson(handler, payload);
    const retry = await callJson(handler, payload);

    expect(first.body.stopped).toBe(true);
    expect(first.body.control.version).toBe(1);
    expect(retry.body.status).toBe('duplicate');
    expect(retry.body.stopped).toBe(true);
    expect(agent.queue.stopActiveTurn).toHaveBeenCalledTimes(1);
  });

  it('POST /interrupt-and-send uses the distinct interrupt command', async () => {
    const agent = createRouteAgent();
    const payload = {
      clientRequestId: 'req-interrupt-1',
      chatId: CHAT_ID,
      agentId: 'claude',
    };

    const result = await callJson(
      agent.routes['/api/v1/chats/interrupt-and-send'].POST,
      payload,
    );

    expect(result.response.status).toBe(200);
    expect(result.body.stopped).toBe(true);
    expect(agent.queue.interruptActiveTurn).toHaveBeenCalledTimes(1);
    expect(agent.queue.stopActiveTurn).not.toHaveBeenCalled();
  });

  it('PATCH /execution-settings normalizes modes and patches agent and registry', async () => {
    const agent = createRouteAgent();

    const { response, body } = await callJson(
      agent.routes['/api/v1/chats/execution-settings'].PATCH,
      {
        chatId: CHAT_ID,
        permissionMode: 'bogus',
        thinkingMode: 'ultra',
        agentSettingsPatch: {},
      },
      'PATCH',
    );

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      chatId: CHAT_ID,
      permissionMode: 'default',
      thinkingMode: 'ultra',
      agentSettings: { ownerId: 'claude', schemaVersion: 1, values: {} },
    });
    expect(agent.agents.updateSessionSettings).toHaveBeenCalledWith(
      CHAT_ID,
      expect.objectContaining({
        permissionMode: 'default',
        thinkingMode: 'ultra',
        agentSettingsPatch: {},
      }),
    );
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
    expect(agent.agents.updateSessionSettings).toHaveBeenCalledWith(
      CHAT_ID,
      expect.objectContaining({
        model: 'endpoint:model-a',
        apiProviderId: 'provider-1',
        modelEndpointId: 'endpoint',
      }),
    );
    expect(agent.registry.updateChat).toHaveBeenCalledWith(
      CHAT_ID,
      expect.objectContaining({
        model: 'endpoint:model-a',
        apiProviderId: 'provider-1',
        modelEndpointId: 'endpoint',
        modelProtocol: 'openai-compatible',
      }),
    );
  });

  it('PATCH /model returns 400 when model is missing', async () => {
    const agent = createRouteAgent();

    const { response, body } = await callJson(agent.routes['/api/v1/chats/model'].PATCH, { chatId: CHAT_ID }, 'PATCH');

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
      effectiveProjectKey: realNextPath,
      previousProjectPath: '/workspace/project',
      previousEffectiveProjectKey: '/workspace/project',
    });
    expect(agent.agents.prepareProjectPathUpdate).toHaveBeenCalledWith(
      'claude',
      expect.objectContaining({
        chatId: CHAT_ID,
        agentSessionId: 'provider-session-123',
        previousProjectPath: '/workspace/project',
        nextProjectPath: realNextPath,
        nativeSession: expect.objectContaining({ ownerId: 'claude' }),
      }),
    );
    expect(agent.registry.updateProjectPath).toHaveBeenCalledWith(
      CHAT_ID,
      expect.objectContaining({
        projectPath: realNextPath,
        effectiveProjectKey: realNextPath,
        previousProjectPath: '/workspace/project',
      }),
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
    agent.queue.readChatExecutionControl.mockResolvedValueOnce({
      entries: [
        {
          id: 'entry-1',
          content: 'queued',
          status: 'queued',
          createdAt: '2026-05-14T00:00:00.000Z',
        },
      ],
      pause: null,
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
