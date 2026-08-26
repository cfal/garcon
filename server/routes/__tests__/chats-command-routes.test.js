import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { QUEUE_ENTRY_ID_MAX_BYTES } from '../../../common/chat-command-contracts.ts';
import { AGENT_HANDOFF_REQUEST_TIMEOUT_SECONDS } from '../../../common/handoff-timeouts.ts';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { AgentIntegrationError } from '@garcon/server-agent-interface';

let testBasePath;
let workspaceDir;
const routeLogger = {
  debug: mock(() => undefined),
  info: mock(() => undefined),
  warn: mock(() => undefined),
  error: mock(() => undefined),
};

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

mock.module('../../lib/log.js', () => ({
  createLogger: mock(() => routeLogger),
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
import { CommandValidationError } from '../../lib/command-validation-error.js';
import { ModelSelectionError } from '../../api-providers/endpoint-resolver.js';
import {
  DomainError,
  QueueEntrySteerError,
  SteerDeliveryError,
  TRANSCRIPT_TEMPORARILY_UNAVAILABLE_MESSAGE,
} from '../../lib/domain-error.js';
import {
  QueueEntryMutationError,
  QueuePauseChangedError,
} from '../../chat-execution/chat-execution-coordinator.js';
import {
  createRouteChatListProjector,
  createRouteCommandLedger,
  createRouteCommandService,
  createRoutePathCache,
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
    serverInstanceId: 'server-instance-test',
    entries,
    recentlyDispatched: [],
    appliedCommands: [],
    pause: null,
    reorderRevision: 0,
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
    carryOverSegments: [],
    nativeSeedReceipt: null,
    carryOverMigrationQuarantine: null,
    agentSettingsById: {
      claude: { ownerId: 'claude', schemaVersion: 1, values: {} },
    },
    projectPath: '/workspace/project',
    tags: [],
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
    flush: mock(() => Promise.resolve(undefined)),
  };
  const settings = {
    getChatName: mock(() => null),
    ensureInNormal: mock((chatId) => {
      normalIds.splice(normalIds.indexOf(chatId), normalIds.includes(chatId) ? 1 : 0);
      normalIds.unshift(chatId);
      return Promise.resolve(undefined);
    }),
    setSessionName: mock(() => Promise.resolve(undefined)),
    recordChatStartup: mock(() => Promise.resolve(undefined)),
    removeFromAllOrderLists: mock(() => Promise.resolve(undefined)),
    removeSessionName: mock(() => Promise.resolve(undefined)),
    togglePin: mock(() => Promise.resolve({ isPinned: true })),
    toggleArchive: mock(() => Promise.resolve({ isArchived: true })),
    getPinnedChatIds: mock(() => []),
    getNormalChatIds: mock(() => [...normalIds]),
    getArchivedChatIds: mock(() => []),
	reorderChat: mock(() => Promise.resolve({
		success: true,
		response: { success: true, chatId: 'chat', orderGroup: 'normal', changed: true },
	})),
  };
  const queue = {
    scheduleDirectInput: mock(async (input) => {
      const reservation = queue.reserveDirectTurn(input.command.chatId, input.options);
      try {
        const control = await queue.readChatExecutionControl(input.command.chatId);
        if (control.entries.length > 0 || control.pause) {
          throw new DomainError('SESSION_BUSY', 'Chat execution is blocked by pending control state', 409, true);
        }
        await input.preparation?.prepare();
        await queue.registerPendingUserInput(input.command.chatId, input.content, input.options);
        await input.settlement.markScheduled(input.command, input.options.turnId);
      } catch (error) {
        await queue.releaseDirectTurn(reservation);
        await input.preparation?.compensate();
        await input.settlement.markPreScheduleFailure(input.command, {
          error,
          retryable: true,
        });
        throw error;
      }
      void queue.runReservedTurn(reservation, input.content, input.options);
    }),
    runInitialInput: mock(async (input) => {
      const reservation = queue.reserveDirectTurn(input.command.chatId, input.options);
      await input.preparation?.prepare();
      await queue.registerPendingUserInput(input.command.chatId, input.content, input.options);
      await input.settlement.markScheduled(input.command, input.options.turnId);
      await input.dispatch?.(reservation.executionAdmission);
      await queue.completeDirectTurn(reservation);
    }),
    scheduleDirectOperation: mock(async (input) => {
      const reservation = queue.reserveDirectTurn(input.command.chatId, input.command);
      await input.settlement.markScheduled(input.command, input.command.turnId);
      void input.dispatch(reservation.executionAdmission);
    }),
    enqueueAccepted: mock(async (input) => {
      try {
        const result = await queue.createChatQueueEntry(
          input.command.chatId,
          input.content,
          { key: input.command.key, entryId: input.command.entryId },
        );
        await input.settlement.settleQueueMutation(input.command, result.entryId);
        await queue.triggerDrain(input.command.chatId);
        return result;
      } catch (error) {
        await input.settlement.settleQueueMutationFailure(input.command, error);
        throw error;
      }
    }),
    replaceAccepted: mock(async (input) => {
      try {
        const result = await queue.replaceChatQueueEntry(
          input.command.chatId,
          input.command.entryId,
          input.content,
          input.expectedRevision,
          { key: input.command.key, entryId: input.command.entryId },
        );
        await input.settlement.settleQueueMutation(input.command, result.entryId);
        return result;
      } catch (error) {
        await input.settlement.settleQueueMutationFailure(input.command, error);
        throw error;
      }
    }),
    deleteAccepted: mock(async (input) => {
      try {
        const result = await queue.deleteChatQueueEntry(
          input.command.chatId,
          input.command.entryId,
          { key: input.command.key, entryId: input.command.entryId },
        );
        await input.settlement.settleQueueMutation(input.command, result.entryId);
        return result;
      } catch (error) {
        await input.settlement.settleQueueMutationFailure(input.command, error);
        throw error;
      }
    }),
    moveAccepted: mock(async (input) => {
      try {
        const result = await queue.moveChatQueueEntry(
          input.command.chatId,
          {
            entryId: input.command.entryId,
            targetEntryId: input.targetEntryId,
            placement: input.placement,
            expectedReorderRevision: input.expectedReorderRevision,
            expectedSourceRevision: input.expectedSourceRevision,
            expectedTargetRevision: input.expectedTargetRevision,
          },
          { key: input.command.key, entryId: input.command.entryId },
        );
        await input.settlement.settleQueueMutation(input.command, result.entryId);
        return result;
      } catch (error) {
        await input.settlement.settleQueueMutationFailure(input.command, error);
        throw error;
      }
    }),
    deliverAcceptedGoalControl: mock(async (input) => {
      const delivered = await queue.deliverGoalControlInput(
        input.command.chatId,
        input.content,
        { clientRequestId: input.command.clientRequestId, turnId: input.command.turnId },
        () => input.settlement.markScheduled(input.command, input.command.turnId),
      );
      if (delivered) {
        await input.settlement.settleGoalControl(input.command);
        return { delivery: 'active', control: await queue.readChatExecutionControl(input.command.chatId) };
      }
      const result = await queue.enqueueAccepted(input);
      return { delivery: 'queued', entryId: result.entryId, control: result.control };
    }),
    recoverAcceptedGoalControl: mock(async (input) => ({
      delivery: 'queued',
      entryId: input.command.entryId,
      control: await queue.readChatExecutionControl(input.command.chatId),
    })),
    captureSteerTarget: mock(() => ({
      attempt: {},
      identity: { turnId: 'turn-active' },
    })),
    deliverAcceptedSteer: mock(async (input) => {
      await input.settlement.markScheduled(input.command, input.target.identity.turnId);
      await input.settlement.settleSteerSuccess(input.command, input.target.identity.turnId);
      return { turnId: input.target.identity.turnId };
    }),
    deliverAcceptedQueueEntrySteer: mock(async (input) => {
      await input.settlement.markScheduled(input.command, input.target.identity.turnId);
      await input.settlement.settleSteerSuccess(input.command, input.target.identity.turnId);
      return {
        turnId: input.target.identity.turnId,
        control: await queue.readChatExecutionControl(input.command.chatId),
      };
    }),
    recoverQueueEntrySteer: mock((chatId) => queue.readChatExecutionControl(chatId)),
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
    completeDirectTurn: mock(() => Promise.resolve(undefined)),
    failDirectTurn: mock(() => Promise.resolve(undefined)),
    runReservedTurn: mock(() => Promise.resolve(undefined)),
    stopActiveTurn: mock(() => Promise.resolve({
      outcome: 'interrupt-requested',
      control: storedQueue([], { version: 1 }),
    })),
    interruptActiveTurn: mock(() => Promise.resolve('interrupt-requested')),
    abortForChatDeletion: mock(() => Promise.resolve(true)),
    triggerDrain: mock(() => Promise.resolve(undefined)),
    ownsExecution: mock(() => false),
    reserveTranscriptSnapshot: mock((chatId) => {
      const source = registry.getChat(chatId);
      if (agents.isAgentSessionRunning(source?.agentId, source?.agentSessionId)) {
        throw new DomainError('SESSION_BUSY', 'Another chat turn already owns execution', 409, true);
      }
      return { chatId, reservationId: 'snapshot-reservation' };
    }),
    releaseTranscriptSnapshot: mock(() => Promise.resolve(undefined)),
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
    moveChatQueueEntry: mock((_chatId, input) =>
      Promise.resolve({
        entryId: input.entryId,
        control: storedQueue([
          queueEntry(input.entryId),
          queueEntry(input.targetEntryId, 'target', 'queued', input.expectedTargetRevision),
        ], { version: 2, reorderRevision: input.expectedReorderRevision + 1 }),
        duplicate: false,
        rebased: false,
      }),
    ),
    deliverGoalControlInput: mock(async (_chatId, _content, _options, beforeDelivery) => {
      await beforeDelivery();
      return true;
    }),
    clearChatQueue: mock(() => Promise.resolve(storedQueue([], { version: 2 }))),
    pauseChatQueue: mock(() => Promise.resolve(storedQueue(
      [queueEntry('entry-1')],
      { pause: manualPause(), version: 2 },
    ))),
    resumeChatQueue: mock(() => Promise.resolve(storedQueue([queueEntry('entry-1')], { version: 3 }))),
    resumeAndDrain: mock(async (chatId, pauseId) => {
      const control = await queue.resumeChatQueue(chatId, pauseId);
      await queue.triggerDrain(chatId);
      return control;
    }),
    waitForDispatches: mock(() => Promise.resolve(undefined)),
  };
  const pathCache = createRoutePathCache();
  const metadata = {
    addNewChatMetadata: mock(() => undefined),
    listAllChatMetadata: mock(() => new Map()),
    getChatMetadata: mock(() => null),
  };
  const chatViews = {
    page: mock(() =>
      Promise.resolve({
        transcriptViewId: 'view-1',
        messages: [],
        lastOrdinal: 0,
        pageOldestOrdinal: 0,
        pageNewestOrdinal: 0,
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
    currentTranscriptViewId: mock(() => Promise.resolve('view-current')),
    getRunningSessions: mock(() => ({ claude: [{ id: CHAT_ID }] })),
    startSession: mock(() => Promise.resolve(undefined)),
    modelSupportsImages: mock(() => Promise.resolve(true)),
    getAgentCatalogEntry: mock(() => Promise.resolve({
      supportedPermissionModes: ['default', 'acceptEdits', 'manualBypass', 'bypassPermissions', 'plan'],
      supportedThinkingModes: ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    })),
    runSingleQuery: mock(() => Promise.resolve('title')),
    forkAgentSession: mock(() => Promise.resolve({
      kind: 'materialized',
      session: { agentSessionId: 'forked-session', nativeSession: null },
    })),
    discardForkedAgentSession: mock(() => Promise.resolve(undefined)),
    resolvePermission: mock(() => undefined),
    resolveNativeSession: mock((chat) => Promise.resolve(chat.nativeSession ?? null)),
    prepareProjectPathUpdate: mock(() => Promise.resolve(undefined)),
    publishSessionFact: mock(() => undefined),
    updateSessionSettings: mock((chatId, patch) => Promise.resolve(registry.updateChat(chatId, patch))),
  };
  const commandLedger = createRouteCommandLedger('chats-command-routes');
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
    processing: { phase: mock(() => null) },
    pathCache,
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
    commandLedger,
    routes,
  };
}

async function callJson(handler, body, method = 'POST', server) {
  const inputBody = body && typeof body === 'object' && 'chatId' in body
    ? {
        ...body,
        ...((('clientMessageId' in body) || ('content' in body))
          && !('transcriptViewId' in body)
          ? { transcriptViewId: 'view-current' }
          : {}),
        ...('content' in body && 'clientRequestId' in body && !('clientMessageId' in body)
          ? { clientMessageId: `message-${body.clientRequestId}` }
          : {}),
      }
    : body;
  const requestBody = inputBody;
  parseJsonBody.mockResolvedValueOnce(requestBody);
  const request = new Request('http://localhost/test', { method });
  const response = await handler(request, new URL(request.url), server);
  return { request, response, body: await response.json() };
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
    routeLogger.debug.mockClear();
    routeLogger.info.mockClear();
    routeLogger.warn.mockClear();
    routeLogger.error.mockClear();
  });

  afterEach(async () => {
    await fs.rm(testBasePath, { recursive: true, force: true });
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it('POST /run returns before agent completion and persists before running', async () => {
    const agent = createRouteAgent();
    const server = { timeout: mock(() => undefined) };
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

    const { response, body } = await callJson(
      agent.routes['/api/v1/chats/run'].POST,
      agentRunBody(),
      'POST',
      server,
    );

    expect(response.status).toBe(202);
    expect(body).toMatchObject({
      success: true,
      commandType: 'agent-run',
      clientRequestId: 'req-run-1',
      chatId: CHAT_ID,
      status: 'accepted',
    });
    expect(typeof body.turnId).toBe('string');
    expect(response.headers.get('Location')).toBe(
      `/api/v1/chats/turn-receipt?chatId=${CHAT_ID}&turnId=${body.turnId}`,
    );
    expect(order).toEqual(['pending', 'run']);
    expect(server.timeout).not.toHaveBeenCalled();
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

  it('[TLV5-ADOPT.10-RUN-ROUTE-UNIT-01] maps retryable transcript adoption failure to the typed run response', async () => {
    const agent = createRouteAgent();
    agent.agents.currentTranscriptViewId.mockRejectedValueOnce(new AgentIntegrationError(
      'TRANSCRIPT_UNAVAILABLE',
      'Transcript adoption source failed',
      true,
      { provider: 'claude', phase: 'legacy-history-import' },
    ));

    const { response, body } = await callJson(
      agent.routes['/api/v1/chats/run'].POST,
      agentRunBody(),
    );

    expect(response.status).toBe(503);
    expect(body).toEqual({
      success: false,
      error: TRANSCRIPT_TEMPORARILY_UNAVAILABLE_MESSAGE,
      errorCode: 'TRANSCRIPT_UNAVAILABLE',
      retryable: true,
    });
    expect(agent.queue.scheduleDirectInput).not.toHaveBeenCalled();
    expect(agent.queue.reserveDirectTurn).not.toHaveBeenCalled();
    expect(agent.queue.registerPendingUserInput).not.toHaveBeenCalled();
    expect(agent.queue.runReservedTurn).not.toHaveBeenCalled();
    expect(await agent.commandLedger.getRecord(`agent-run:${CHAT_ID}:req-run-1`)).toBeNull();

    const retry = await callJson(
      agent.routes['/api/v1/chats/run'].POST,
      agentRunBody(),
    );
    expect(retry.response.status).toBe(202);
    expect(retry.body).toMatchObject({ success: true, status: 'accepted' });
    expect(agent.queue.scheduleDirectInput).toHaveBeenCalledTimes(1);
    expect(agent.queue.reserveDirectTurn).toHaveBeenCalledTimes(1);
    expect(agent.queue.registerPendingUserInput).toHaveBeenCalledTimes(1);
    expect(agent.queue.runReservedTurn).toHaveBeenCalledTimes(1);
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

  it('POST /run validates attachments at the request boundary', async () => {
    const agent = createRouteAgent();
    const invalid = await callJson(
      agent.routes['/api/v1/chats/run'].POST,
      agentRunBody({
        images: [{
          data: `data:application/octet-stream;base64,${Buffer.from('bad').toString('base64')}`,
          name: 'bad.bin',
          mimeType: 'application/octet-stream',
        }],
      }),
    );

    expect(invalid.response.status).toBe(400);
    expect(invalid.body.errorCode).toBe('VALIDATION_FAILED');
    expect(agent.queue.registerPendingUserInput).not.toHaveBeenCalled();
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
        queue: { entries: [], pause: null },
      },
    });
  });

  it('POST /run rejects a handoff before preparation when the chat is not idle', async () => {
    const agent = createRouteAgent();
    const server = { timeout: mock(() => undefined) };
    const control = storedQueue([queueEntry('entry-1')], { version: 5 });
    agent.queue.ownsExecution.mockReturnValue(true);
    agent.queue.readChatExecutionControl.mockResolvedValue(control);

    const { request, response, body } = await callJson(
      agent.routes['/api/v1/chats/run'].POST,
      {
        clientRequestId: 'req-handoff-busy',
        clientMessageId: 'msg-handoff-busy',
        chatId: CHAT_ID,
        command: 'delegate this work',
        handoff: {
          expectedAgentOwnershipEpoch: 'epoch-1',
          target: {
            agentId: 'codex',
            model: 'gpt-5.5',
            permissionMode: 'default',
            thinkingMode: 'high',
            agentSettings: { ownerId: 'codex', schemaVersion: 1, values: {} },
          },
        },
      },
      'POST',
      server,
    );

    expect(response.status).toBe(409);
    expect(body).toMatchObject({
      success: false,
      errorCode: 'AGENT_HANDOFF_REQUIRES_IDLE',
      retryable: true,
      control: { version: 5, queue: { entries: [{ id: 'entry-1' }] } },
    });
    expect(agent.queue.reserveDirectTurn).not.toHaveBeenCalled();
    expect(server.timeout).toHaveBeenCalledWith(
      request,
      AGENT_HANDOFF_REQUEST_TIMEOUT_SECONDS,
    );
  });

  it('POST /run disables the Bun idle timeout for an accepted handoff', async () => {
    const agent = createRouteAgent();
    const server = { timeout: mock(() => undefined) };

    const { request, response, body } = await callJson(
      agent.routes['/api/v1/chats/run'].POST,
      {
        clientRequestId: 'req-handoff-accepted',
        clientMessageId: 'msg-handoff-accepted',
        chatId: CHAT_ID,
        command: 'delegate this work',
        handoff: {
          expectedAgentOwnershipEpoch: 'epoch-1',
          target: {
            agentId: 'codex',
            model: 'gpt-5.5',
            permissionMode: 'default',
            thinkingMode: 'high',
            agentSettings: { ownerId: 'codex', schemaVersion: 1, values: {} },
          },
        },
      },
      'POST',
      server,
    );

    expect(response.status).toBe(202);
    expect(body).toMatchObject({
      success: true,
      commandType: 'agent-run',
      clientRequestId: 'req-handoff-accepted',
      status: 'accepted',
    });
    expect(AGENT_HANDOFF_REQUEST_TIMEOUT_SECONDS).toBe(0);
    expect(server.timeout).toHaveBeenCalledWith(
      request,
      AGENT_HANDOFF_REQUEST_TIMEOUT_SECONDS,
    );
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

  it('POST /fork-run copies committed source rows while the source is running', async () => {
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

    expect(response.status).toBe(202);
    expect(body.chatId).toBe(TARGET_CHAT_ID);
    expect(forkChatFileCopy).toHaveBeenCalledOnce();
    expect(agent.queue.registerPendingUserInput).toHaveBeenCalledOnce();
  });

  it('POST /fork-run carries handoff-fork consent and rejects a non-boolean', async () => {
    const agent = createRouteAgent();
    const request = agentRunBody({
      clientRequestId: 'req-fork-run-consent',
      clientMessageId: 'msg-fork-run-consent',
      sourceChatId: CHAT_ID,
      chatId: TARGET_CHAT_ID,
      command: 'continue',
    });

    const accepted = await callJson(agent.routes['/api/v1/chats/fork-run'].POST, {
      ...request,
      allowHandoffFork: true,
    });

    expect(accepted.response.status).toBe(202);
    expect(forkChatFileCopy).toHaveBeenCalledWith(
      expect.objectContaining({ allowHandoffFork: true }),
    );

    const rejected = await callJson(agent.routes['/api/v1/chats/fork-run'].POST, {
      ...request,
      allowHandoffFork: 'yes',
    });

    expect(rejected.response.status).toBe(400);
    expect(rejected.body).toMatchObject({ error: 'allowHandoffFork must be a boolean' });
  });

  it('POST /fork preserves retryable transcript-persistence refusals', async () => {
    const agent = createRouteAgent();
    forkChatFileCopy.mockRejectedValueOnce(new CommandValidationError(
      'TRANSCRIPT_NOT_YET_PERSISTED',
      "This chat's transcript hasn't been written yet. Try the fork again in a moment.",
      409,
      true,
    ));

    const { response, body } = await callJson(agent.routes['/api/v1/chats/fork'].POST, {
      sourceChatId: CHAT_ID,
      chatId: TARGET_CHAT_ID,
    });

    expect(response.status).toBe(409);
    expect(body).toEqual({
      success: false,
      error: "This chat's transcript hasn't been written yet. Try the fork again in a moment.",
      errorCode: 'TRANSCRIPT_NOT_YET_PERSISTED',
      retryable: true,
    });
  });

  it('POST /fork carries handoff-fork consent and rejects a non-boolean', async () => {
    const agent = createRouteAgent();

    const accepted = await callJson(agent.routes['/api/v1/chats/fork'].POST, {
      sourceChatId: CHAT_ID,
      chatId: TARGET_CHAT_ID,
      allowHandoffFork: true,
    });

    expect(accepted.response.status).toBe(200);
    expect(forkChatFileCopy.mock.calls.at(-1)[0]).toMatchObject({ allowHandoffFork: true });

    const rejected = await callJson(agent.routes['/api/v1/chats/fork'].POST, {
      sourceChatId: CHAT_ID,
      chatId: TARGET_CHAT_ID,
      allowHandoffFork: 'yes',
    });

    expect(rejected.response.status).toBe(400);
    expect(rejected.body).toMatchObject({ error: 'allowHandoffFork must be a boolean' });
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
    expect(agent.queue.replaceChatQueueEntry).toHaveBeenCalledWith(
      CHAT_ID,
      'entry-1',
      '  edited in the middle\n',
      4,
      {
        key: `queue-entry-replace:${CHAT_ID}:req-replace-1`,
        entryId: 'entry-1',
      },
    );
    expect(deleted.response.status).toBe(200);
    expect(agent.queue.deleteChatQueueEntry).toHaveBeenCalledWith(CHAT_ID, 'entry-1', {
      key: `queue-entry-delete:${CHAT_ID}:req-delete-1`,
      entryId: 'entry-1',
    });
  });

  it('PUT /queue/entries/move sends explicit order and entry revisions', async () => {
    const agent = createRouteAgent();
    const result = await callJson(
      agent.routes['/api/v1/chats/queue/entries/move'].PUT,
      {
        clientRequestId: 'req-move-1',
        chatId: CHAT_ID,
        entryId: 'entry-3',
        targetEntryId: 'entry-1',
        placement: 'before',
        expectedReorderRevision: 2,
        expectedSourceRevision: 1,
        expectedTargetRevision: 4,
      },
      'PUT',
    );

    expect(result.response.status).toBe(200);
    expect(result.body).toMatchObject({
      commandType: 'queue-entry-move',
      entryId: 'entry-3',
      control: { queue: { reorderRevision: 3 } },
    });
    expect(agent.queue.moveChatQueueEntry).toHaveBeenCalledWith(
      CHAT_ID,
      {
        entryId: 'entry-3',
        targetEntryId: 'entry-1',
        placement: 'before',
        expectedReorderRevision: 2,
        expectedSourceRevision: 1,
        expectedTargetRevision: 4,
      },
      {
        key: 'queue-entry-move:1783725900000700:req-move-1',
        entryId: 'entry-3',
      },
    );
  });

  it('PUT /queue/entries/move rejects malformed revisions before mutation', async () => {
    const agent = createRouteAgent();
    const result = await callJson(
      agent.routes['/api/v1/chats/queue/entries/move'].PUT,
      {
        clientRequestId: 'req-move-invalid',
        chatId: CHAT_ID,
        entryId: 'entry-3',
        targetEntryId: 'entry-1',
        placement: 'before',
        expectedReorderRevision: -1,
        expectedSourceRevision: 1,
        expectedTargetRevision: 4,
      },
      'PUT',
    );

    expect(result.response.status).toBe(400);
    expect(result.body.errorCode).toBe('VALIDATION_FAILED');
    expect(agent.queue.moveChatQueueEntry).not.toHaveBeenCalled();
  });

  it('PUT /queue/entries/move rejects a source that started processing', async () => {
    const agent = createRouteAgent();
    const currentQueue = storedQueue([
      queueEntry('entry-1'),
    ], {
      version: 5,
      recentlyDispatched: [{
        entryId: 'entry-3',
        revision: 1,
        dispatchedAt: '2026-08-02T00:00:01.000Z',
      }],
    });
    agent.queue.moveChatQueueEntry.mockRejectedValueOnce(
      new QueueEntryMutationError(
        'QUEUE_ENTRY_ALREADY_SENT',
        'This queued message has already been sent',
        currentQueue,
      ),
    );

    const result = await callJson(
      agent.routes['/api/v1/chats/queue/entries/move'].PUT,
      {
        clientRequestId: 'req-move-sent',
        chatId: CHAT_ID,
        entryId: 'entry-3',
        targetEntryId: 'entry-1',
        placement: 'before',
        expectedReorderRevision: 0,
        expectedSourceRevision: 1,
        expectedTargetRevision: 1,
      },
      'PUT',
    );

    expect(result.response.status).toBe(409);
    expect(result.body.errorCode).toBe('QUEUE_ENTRY_ALREADY_SENT');
    expect(result.body.control.queue.recentlyDispatched).toContainEqual(
      expect.objectContaining({ entryId: 'entry-3' }),
    );
  });

  it('POST /goal-control preserves immediate goal delivery', async () => {
    const agent = createRouteAgent();
	    const result = await callJson(agent.routes['/api/v1/chats/goal-control'].POST, {
	      clientRequestId: 'req-goal-1',
	      chatId: CHAT_ID,
	      content: '/goal pause',
	    });

	    expect(result.response.status).toBe(202);
	    expect(result.body.delivery).toBe('active');
	    expect(agent.queue.deliverGoalControlInput).toHaveBeenCalledWith(
	      CHAT_ID,
	      '/goal pause',
	      expect.objectContaining({ clientRequestId: 'req-goal-1' }),
	      expect.any(Function),
	    );
	  });

	  it('POST /steer returns the captured current turn without queue state', async () => {
	    const agent = createRouteAgent();
	    const result = await callJson(agent.routes['/api/v1/chats/steer'].POST, {
	      clientRequestId: 'req-steer-1',
	      clientMessageId: 'message-steer-1',
	      chatId: CHAT_ID,
	      content: 'focus here',
	    });

	    expect(result.response.status).toBe(202);
	    expect(result.body).toMatchObject({
	      commandType: 'steer',
	      chatId: CHAT_ID,
	      turnId: 'turn-active',
	    });
	    expect(result.body.delivery).toBeUndefined();
	    expect(result.body.control).toBeUndefined();
	    expect(agent.queue.deliverAcceptedSteer).toHaveBeenCalledOnce();
	    expect(agent.routes['/api/v1/chats/active-input']).toBeUndefined();
	  });

  it('POST /queue/entries/steer consumes the authoritative queue head idempotently', async () => {
    const agent = createRouteAgent();
    const queued = storedQueue([
      {
        ...queueEntry('entry-head', 'authoritative guidance', 'queued', 3),
        submission: {
          clientMessageId: 'message-queue-steer',
          transcriptViewId: 'view-current',
        },
      },
    ], { reorderRevision: 7, version: 4 });
    const consumed = storedQueue([], {
      reorderRevision: 7,
      version: 6,
      recentlyDispatched: [{
        entryId: 'entry-head',
        revision: 3,
        dispatchedAt: '2026-08-02T00:00:01.000Z',
      }],
    });
    let currentControl = queued;
    agent.queue.readChatExecutionControl.mockImplementation(async () => currentControl);
    agent.queue.deliverAcceptedQueueEntrySteer.mockImplementation(async (input) => {
      expect(input).toMatchObject({
        content: 'authoritative guidance',
        clientMessageId: 'message-queue-steer',
        expectedRevision: 3,
        expectedReorderRevision: 7,
      });
      await input.settlement.markScheduled(input.command, 'turn-active');
      currentControl = consumed;
      await input.settlement.settleSteerSuccess(input.command, 'turn-active');
      return { turnId: 'turn-active', control: consumed };
    });
    const request = {
      clientRequestId: 'request-queue-steer',
      clientMessageId: 'message-queue-steer',
      chatId: CHAT_ID,
      entryId: 'entry-head',
      expectedRevision: 3,
      expectedReorderRevision: 7,
    };

    const accepted = await callJson(
      agent.routes['/api/v1/chats/queue/entries/steer'].POST,
      request,
    );
    const duplicate = await callJson(
      agent.routes['/api/v1/chats/queue/entries/steer'].POST,
      request,
    );

    expect(accepted.response.status).toBe(202);
    expect(accepted.body).toMatchObject({
      commandType: 'steer',
      status: 'accepted',
      turnId: 'turn-active',
      serverInstanceId: 'server-instance-test',
      control: { queue: { entries: [], steeringEntryId: null } },
    });
    expect(duplicate.response.status).toBe(202);
    expect(duplicate.body).toMatchObject({
      status: 'duplicate',
      turnId: 'turn-active',
      serverInstanceId: 'server-instance-test',
      control: { queue: { entries: [], steeringEntryId: null } },
    });
    expect(agent.queue.deliverAcceptedQueueEntrySteer).toHaveBeenCalledOnce();
  });

  it('POST /queue/entries/steer rejects malformed revisions before command delivery', async () => {
    const agent = createRouteAgent();
    const result = await callJson(agent.routes['/api/v1/chats/queue/entries/steer'].POST, {
      clientRequestId: 'request-queue-steer-invalid',
      clientMessageId: 'message-queue-steer-invalid',
      chatId: CHAT_ID,
      entryId: 'entry-head',
      expectedRevision: -1,
      expectedReorderRevision: 7,
    });

    expect(result.response.status).toBe(400);
    expect(result.body.errorCode).toBe('VALIDATION_FAILED');
    expect(agent.queue.deliverAcceptedQueueEntrySteer).not.toHaveBeenCalled();
  });

  it('POST /queue/entries/steer identifies control-free errors by server instance', async () => {
    const agent = createRouteAgent();
    agent.registry.getChat.mockReturnValue(null);

    const result = await callJson(agent.routes['/api/v1/chats/queue/entries/steer'].POST, {
      clientRequestId: 'request-queue-steer-missing-chat',
      clientMessageId: 'message-queue-steer-missing-chat',
      chatId: CHAT_ID,
      entryId: 'entry-head',
      expectedRevision: 1,
      expectedReorderRevision: 0,
    });

    expect(result.response.status).toBe(404);
    expect(result.body).toMatchObject({
      errorCode: 'SESSION_NOT_FOUND',
      deliveryOutcome: 'not-sent',
      serverInstanceId: 'server-instance-test',
    });
    expect(result.body.control).toBeUndefined();
  });

  it('POST /queue/entries/steer rejects oversized source identities before command delivery', async () => {
    const agent = createRouteAgent();
    const result = await callJson(agent.routes['/api/v1/chats/queue/entries/steer'].POST, {
      clientRequestId: 'request-queue-steer-invalid-entry',
      clientMessageId: 'message-queue-steer-invalid-entry',
      chatId: CHAT_ID,
      entryId: 'x'.repeat(QUEUE_ENTRY_ID_MAX_BYTES + 1),
      expectedRevision: 1,
      expectedReorderRevision: 0,
    });

    expect(result.response.status).toBe(400);
    expect(result.body).toMatchObject({
      errorCode: 'VALIDATION_FAILED',
      error: `entryId must be at most ${QUEUE_ENTRY_ID_MAX_BYTES} bytes`,
    });
    expect(agent.queue.deliverAcceptedQueueEntrySteer).not.toHaveBeenCalled();
  });

  it('POST /queue/entries/steer preserves typed finalization failure state', async () => {
    const agent = createRouteAgent();
    const queued = storedQueue([
      queueEntry('entry-head', 'authoritative guidance', 'queued', 3),
    ], { reorderRevision: 7, version: 4 });
    const paused = storedQueue([
      queueEntry('entry-head', 'authoritative guidance', 'queued', 3),
    ], {
      reorderRevision: 7,
      version: 6,
      pause: { kind: 'completion-uncertain', entryId: 'entry-head' },
    });
    agent.queue.readChatExecutionControl.mockResolvedValue(queued);
    agent.queue.deliverAcceptedQueueEntrySteer.mockRejectedValue(new QueueEntrySteerError(
      'QUEUE_STEER_FINALIZATION_FAILED',
      'finalization failed',
      500,
      'accepted',
      paused,
    ));

    const result = await callJson(agent.routes['/api/v1/chats/queue/entries/steer'].POST, {
      clientRequestId: 'request-queue-steer-finalization',
      clientMessageId: 'message-queue-steer-finalization',
      chatId: CHAT_ID,
      entryId: 'entry-head',
      expectedRevision: 3,
      expectedReorderRevision: 7,
    });

    expect(result.response.status).toBe(500);
    expect(result.body).toMatchObject({
      success: false,
      errorCode: 'QUEUE_STEER_FINALIZATION_FAILED',
      deliveryOutcome: 'accepted',
      serverInstanceId: 'server-instance-test',
      control: {
        queue: {
          entries: [{ id: 'entry-head' }],
          steeringEntryId: null,
          pause: { kind: 'completion-uncertain', entryId: 'entry-head' },
        },
      },
    });
  });

  it('POST /steer does not duplicate command-boundary delivery logging', async () => {
    const agent = createRouteAgent();
    agent.queue.deliverAcceptedSteer.mockImplementationOnce(() => Promise.reject(
      new SteerDeliveryError(new Error('transport closed'), 'unknown'),
    ));

    const result = await callJson(agent.routes['/api/v1/chats/steer'].POST, {
      clientRequestId: 'req-steer-unknown',
      clientMessageId: 'message-steer-unknown',
      chatId: CHAT_ID,
      content: 'focus here',
    });

    expect(result.response.status).toBe(500);
    expect(routeLogger.error).not.toHaveBeenCalled();
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

  it('returns the latest queue snapshot with reorder conflicts', async () => {
    const agent = createRouteAgent();
    const currentQueue = storedQueue(
      [queueEntry('entry-1'), queueEntry('entry-3')],
      { version: 9, reorderRevision: 4 },
    );
    agent.queue.moveChatQueueEntry.mockRejectedValueOnce(
      new QueueEntryMutationError(
        'QUEUE_ENTRY_REORDER_CONFLICT',
        'The queue order changed before the item could be moved',
        currentQueue,
      ),
    );

    const result = await callJson(
      agent.routes['/api/v1/chats/queue/entries/move'].PUT,
      {
        clientRequestId: 'req-move-conflict',
        chatId: CHAT_ID,
        entryId: 'entry-3',
        targetEntryId: 'entry-1',
        placement: 'before',
        expectedReorderRevision: 3,
        expectedSourceRevision: 1,
        expectedTargetRevision: 1,
      },
      'PUT',
    );

    expect(result.response.status).toBe(409);
    expect(result.body.errorCode).toBe('QUEUE_ENTRY_REORDER_CONFLICT');
    expect(result.body.control).toMatchObject({
      version: 9,
      queue: { reorderRevision: 4 },
    });
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

  it('POST /permissions/decision deduplicates identical decisions and rejects conflicts', async () => {
    const agent = createRouteAgent();
    const handler = agent.routes['/api/v1/chats/permissions/decision'].POST;
    const decision = {
      clientRequestId: 'req-permission-1',
      chatId: CHAT_ID,
      permissionOccurrenceId: 'incarnation-1',
      allow: true,
      alwaysAllow: false,
      response: { outcome: { outcome: 'accepted' } },
      control: {
        serverInstanceId: 'server-instance-test',
        chatId: CHAT_ID,
        runId: 'run-1',
        permissionOccurrenceId: 'incarnation-1',
      },
    };

    const first = await callJson(handler, decision);
    const retry = await callJson(handler, decision);
    const conflict = await callJson(handler, { ...decision, allow: false });

    expect(first.response.status).toBe(200);
    expect(retry.body.status).toBe('duplicate');
    expect(conflict.response.status).toBe(409);
    expect(conflict.body.errorCode).toBe('IDEMPOTENCY_CONFLICT');
    expect(agent.agents.resolvePermission).toHaveBeenCalledTimes(1);
    expect(agent.agents.resolvePermission).toHaveBeenCalledWith(CHAT_ID, 'incarnation-1', {
      allow: true,
      alwaysAllow: false,
      response: { outcome: { outcome: 'accepted' } },
    }, decision.control);
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

    expect(first.body.outcome).toBe('interrupt-requested');
    expect(first.body.control.version).toBe(1);
    expect(retry.body.status).toBe('duplicate');
    expect(retry.body.outcome).toBe('interrupt-requested');
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
    expect(result.body.outcome).toBe('interrupt-requested');
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
