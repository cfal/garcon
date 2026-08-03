import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { AgentIntegrationError } from '@garcon/server-agent-interface';

import { ChatCommandService } from '../chat-command-service.ts';
import { projectAgentTurnReceipt } from '../agent-turn-receipt-projector.ts';
import { CommandLedger, LEDGER_RECORD_LIMIT, commandLedgerKey } from '../command-ledger.ts';
import { UserMessage } from '../../../common/chat-types.js';
import { ChatIdAllocator } from '../../chats/chat-id-allocator.js';
import {
  GOAL_CONTROL_NOT_DELIVERED_MESSAGE,
  GOAL_CONTROL_OUTCOME_UNKNOWN_MESSAGE,
  GoalControlDeliveryError,
  SteerDeliveryError,
  DomainError,
} from '../../lib/domain-error.js';
import {
  QueueEntryMutationError,
  ChatExecutionCoordinator,
} from '../../chat-execution/chat-execution-coordinator.js';
import { InMemoryChatExecutionControlRepository } from '../../chat-execution/chat-execution-control-repository.ts';
import { ChatViewStore } from '../../chats/chat-view-store.js';
import { PendingUserInputService } from '../../chats/pending-user-input-service.js';
import { KeyedPromiseLock } from '../../lib/keyed-lock.js';
import {
  COMMAND_CORRELATION_ID_MAX_BYTES,
  QUEUE_ENTRY_ID_MAX_BYTES,
  parseForkChatCommandRequest,
  parseStartChatCommandRequest,
} from '../../../common/chat-command-contracts.ts';

let workspaceDir;
let projectBaseDir;
let originalProjectBaseDir;
let activeServices = [];
const SOURCE_CHAT_ID = '1783725900000000';
const TARGET_CHAT_ID = '1783725900000001';
const SCHEDULED_CHAT_ID = '1783725900000002';

const runtimeHandoff = () => ({
  validate: () => undefined,
  commit: () => undefined,
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitForCheckpoint(checkpoint, operation, operationName) {
  await Promise.race([
    checkpoint,
    operation.then(
      () => {
        throw new Error(`${operationName} completed before reaching the checkpoint`);
      },
      (error) => {
        throw new Error(`${operationName} failed before reaching the checkpoint`, { cause: error });
      },
    ),
  ]);
}

function directReservation(chatId) {
  const controller = new AbortController();
  return {
    chatId,
    reservationId: randomUUID(),
    executionAdmission: {
      signal: controller.signal,
      markStarted: mock(() => undefined),
    },
  };
}

function queueEntry(id, content = 'queued', status = 'queued', revision = 1) {
  return {
    id,
    content,
    status,
    revision,
    createdAt: '2026-02-27T00:00:00.000Z',
    updatedAt: '2026-02-27T00:00:00.000Z',
  };
}

function storedQueue(entries = [], overrides = {}) {
  return {
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

function agentSettings(ownerId = 'claude', values = {}) {
  return { ownerId, schemaVersion: 1, values };
}

function projectedChat(chatId, projectPath = '/repo') {
  return {
    id: chatId,
    agentId: 'claude',
    model: 'opus',
    permissionMode: 'default',
    thinkingMode: 'none',
    agentSettings: agentSettings(),
    title: 'Chat',
    projectPath,
    effectiveProjectKey: projectPath,
    orderGroup: 'normal',
    tags: [],
    activity: { createdAt: null, lastActivityAt: null, lastReadAt: null },
    preview: { lastMessage: '' },
    isPinned: false,
    isArchived: false,
    isActive: false,
    isUnread: false,
  };
}

function makeService(overrides = {}) {
  const activeFallbacks = new Map();
  const session = {
    id: SOURCE_CHAT_ID,
    agentId: 'claude',
    agentSessionId: 'agent-1',
    nativeSession: {
      ownerId: 'claude',
      schemaVersion: 1,
      value: { path: '/tmp/agent-1.jsonl', agentSessionId: 'agent-1' },
    },
    agentOwnershipEpoch: 'epoch-1',
    agentSettingsById: { claude: agentSettings() },
    projectPath: '/repo',
    model: 'opus',
    tags: [],
    ...overrides.session,
  };
  const sessions = new Map([[SOURCE_CHAT_ID, session]]);
  const chats = {
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
    addTags: mock((chatId, tags) => {
      const current = sessions.get(chatId);
      if (!current) return null;
      const next = { ...current, tags: [...new Set([...current.tags, ...tags])].sort() };
      sessions.set(chatId, next);
      return { id: chatId, ...next };
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
    ...overrides.chats,
  };
  const executionTasks = new Set();
  const queue = overrides.queueService ?? {
    scheduleDirectInput: mock(async (input) => {
      let reservation;
      try {
        reservation = queue.reserveDirectTurn(input.command.chatId, input.options);
        const control = await queue.readChatExecutionControl(input.command.chatId);
        if (control.entries.length > 0 || control.pause) {
          throw new DomainError('SESSION_BUSY', 'Chat execution is blocked by pending control state', 409, true);
        }
        await input.preparation?.prepare();
        await queue.registerPendingUserInput(input.command.chatId, input.content, input.options);
        await input.settlement.markScheduled(input.command, input.options.turnId);
      } catch (error) {
        if (reservation) await queue.releaseDirectTurn(reservation);
        pendingInputs.markFailed(
          input.command.chatId,
          input.options.clientRequestId,
        );
        let failure = error;
        try {
          await input.preparation?.compensate();
        } catch (compensationError) {
          failure = new AggregateError(
            [error, compensationError],
            `Failed to prepare and roll back ${input.preparation.operation} for ${input.command.chatId}`,
          );
        }
        await input.settlement.markPreScheduleFailure(input.command, {
          error: failure,
          retryable: failure === error,
          preserveForkPreparation: failure !== error,
        });
        throw failure;
      }
      const task = queue.runReservedTurn(reservation, input.content, input.options)
        .then(() => queue.completeDirectTurn(reservation), () => queue.failDirectTurn(reservation));
      executionTasks.add(task);
      void task.finally(() => executionTasks.delete(task));
    }),
    runInitialInput: mock(async (input) => {
      let reservation;
      let scheduled = false;
      try {
        reservation = queue.reserveDirectTurn(input.command.chatId, input.options);
        await input.preparation?.prepare();
        await queue.registerPendingUserInput(input.command.chatId, input.content, input.options);
        await input.settlement.markScheduled(input.command, input.options.turnId);
        scheduled = true;
        await input.dispatch?.(reservation.executionAdmission);
        await queue.completeDirectTurn(reservation);
      } catch (error) {
        if (scheduled) {
          await input.settlement.settleOperationFailure(input.command, error);
          await input.preparation?.compensate();
          if (reservation) await queue.failDirectTurn(reservation);
        } else {
          pendingInputs.markFailed(input.command.chatId, input.options.clientRequestId);
          await input.preparation?.compensate();
          if (reservation) await queue.releaseDirectTurn(reservation);
          await input.settlement.markPreScheduleFailure(input.command, {
            error,
            retryable: true,
            preserveForkPreparation: false,
          });
        }
        throw error;
      }
    }),
    scheduleDirectOperation: mock(async (input) => {
      const reservation = queue.reserveDirectTurn(input.command.chatId, input.command);
      const control = await queue.readChatExecutionControl(input.command.chatId);
      if (control.entries.length > 0 || control.pause) {
        await queue.releaseDirectTurn(reservation);
        const error = new DomainError('SESSION_BUSY', 'Chat execution is blocked by pending control state', 409, true);
        await input.settlement.markPreScheduleFailure(input.command, {
          error,
          retryable: true,
        });
        throw error;
      }
      await input.settlement.markScheduled(input.command, input.command.turnId);
      const task = input.dispatch(reservation.executionAdmission)
        .then(() => queue.completeDirectTurn(reservation), () => queue.failDirectTurn(reservation));
      executionTasks.add(task);
      void task.finally(() => executionTasks.delete(task));
    }),
    enqueueAccepted: mock(async (input) => {
      const result = await queue.createChatQueueEntry(
        input.command.chatId,
        input.content,
        { key: input.command.key, entryId: input.command.entryId },
      );
      await input.settlement.settleQueueMutation(input.command, result.entryId);
      await queue.triggerDrain(input.command.chatId);
      return result;
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
      let deliveryAccepted = false;
      try {
        const delivered = await queue.deliverGoalControlInput(
          input.command.chatId,
          input.content,
          {
            clientRequestId: input.command.clientRequestId,
            clientMessageId: input.command.entryId,
            turnId: input.command.turnId,
          },
          async () => {
            activeFallbacks.set(input.command.key, {
              ...queueEntry(input.command.entryId, input.content, 'sending'),
              delivery: {
                clientRequestId: input.command.clientRequestId,
                clientMessageId: input.command.entryId,
                turnId: input.command.turnId,
              },
            });
            try {
              await input.settlement.markScheduled(input.command, input.command.turnId);
            } catch (error) {
              activeFallbacks.delete(input.command.key);
              throw error;
            }
          },
        );
        if (delivered) {
          deliveryAccepted = true;
          activeFallbacks.delete(input.command.key);
          await input.settlement.settleGoalControl(input.command);
          return { delivery: 'active', control: await queue.readChatExecutionControl(input.command.chatId) };
        }
        const result = await queue.enqueueAccepted(input);
        return { delivery: 'queued', entryId: result.entryId, control: result.control };
      } catch (error) {
        deliveryAccepted ||= error instanceof GoalControlDeliveryError && error.deliveryAccepted;
        if (!deliveryAccepted) activeFallbacks.delete(input.command.key);
        await input.settlement.settleGoalControlFailure(input.command, error, deliveryAccepted);
        throw error;
      }
    }),
    recoverAcceptedGoalControl: mock(async (input) => {
      const fallback = activeFallbacks.get(input.command.key);
      if (!fallback) {
        throw new DomainError(
          'INTERNAL_ERROR',
          'The previous goal-control delivery did not reach a recorded outcome',
          409,
          false,
        );
      }
      fallback.status = 'queued';
      const control = storedQueue([fallback], {
        appliedCommands: [{
          key: input.command.key,
          operation: 'create',
          entryId: input.command.entryId,
          appliedAt: '2026-07-20T00:00:00.000Z',
        }],
      });
      await input.settlement.settleQueueMutation(input.command, input.command.entryId);
      await queue.triggerDrain(input.command.chatId);
      return {
        delivery: 'queued',
        entryId: input.command.entryId,
        control,
      };
    }),
    captureSteerTarget: mock(() => null),
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
    registerPendingUserInput: mock(() => Promise.resolve(undefined)),
    reserveTranscriptSnapshot: mock((chatId) => {
      const source = sessions.get(chatId);
      if (
        queue.ownsExecution(chatId)
        || agents.isAgentSessionRunning(source?.agentId, source?.agentSessionId)
      ) {
        throw new DomainError('SESSION_BUSY', 'Another chat turn already owns execution', 409, true);
      }
      return { chatId, reservationId: `snapshot-${chatId}` };
    }),
    releaseTranscriptSnapshot: mock(() => Promise.resolve(undefined)),
    reserveDirectTurn: mock((chatId) => directReservation(chatId)),
    assertDirectTurnReservationActive: mock(() => undefined),
    releaseDirectTurn: mock(() => Promise.resolve(undefined)),
    completeDirectTurn: mock(() => Promise.resolve(undefined)),
    failDirectTurn: mock(() => Promise.resolve(undefined)),
    runReservedTurn: mock(() => Promise.resolve(undefined)),
    stopActiveTurn: mock(() => Promise.resolve({
      outcome: 'interrupt-requested',
      control: storedQueue(),
    })),
    interruptActiveTurn: mock(() => Promise.resolve('interrupt-requested')),
    abortForChatDeletion: mock(() => Promise.resolve(true)),
    rollbackChatDeletion: mock(() => undefined),
    deleteChatQueueFile: mock(() => Promise.resolve(undefined)),
    waitForDispatches: mock(() => Promise.all([...executionTasks]).then(() => undefined)),
    triggerDrain: mock(() => Promise.resolve(undefined)),
    ownsExecution: mock(() => false),
    readChatExecutionControl: mock(() => Promise.resolve(storedQueue())),
    createChatQueueEntry: mock(() =>
      Promise.resolve({
        entry: queueEntry('entry-1'),
        entryId: 'entry-1',
        control: storedQueue([queueEntry('entry-1')], { version: 1 }),
        duplicate: false,
      }),
    ),
    replaceChatQueueEntry: mock((_chatId, entryId, content, revision) =>
      Promise.resolve({
        entry: queueEntry(entryId, content, 'queued', revision + 1),
        entryId,
        control: storedQueue([queueEntry(entryId, content, 'queued', revision + 1)], { version: 1 }),
        duplicate: false,
      }),
    ),
    deleteChatQueueEntry: mock((_chatId, entryId) =>
      Promise.resolve({
        entryId,
        control: storedQueue([], { version: 1 }),
        duplicate: false,
      }),
    ),
    moveChatQueueEntry: mock((_chatId, input) =>
      Promise.resolve({
        entryId: input.entryId,
        control: storedQueue([
          queueEntry(input.entryId),
          queueEntry(input.targetEntryId, 'target', 'queued', input.expectedTargetRevision),
        ], { version: 1, reorderRevision: input.expectedReorderRevision + 1 }),
        duplicate: false,
        rebased: false,
      }),
    ),
    deliverGoalControlInput: mock(() => Promise.resolve(false)),
    clearChatQueue: mock(() => Promise.resolve(storedQueue([], { version: 1 }))),
    pauseChatQueue: mock(() => Promise.resolve(storedQueue([], { version: 1 }))),
    resumeChatQueue: mock(() => Promise.resolve(storedQueue([], { version: 1 }))),
    resumeAndDrain: mock(async (chatId, pauseId) => {
      const control = await queue.resumeChatQueue(chatId, pauseId);
      await queue.triggerDrain(chatId);
      return control;
    }),
    ...overrides.queue,
  };
  const settings = {
    getUiSettings: mock(() => null),
    getChatName: mock(() => null),
    setSessionName: mock(() => Promise.resolve(undefined)),
    recordChatStartup: mock(() => Promise.resolve(undefined)),
    ensureInNormal: mock(() => Promise.resolve(undefined)),
    removeFromAllOrderLists: mock(() => Promise.resolve(undefined)),
    removeSessionName: mock(() => Promise.resolve(undefined)),
  };
  const metadata = {
    addNewChatMetadata: mock(() => undefined),
    getChatMetadata: mock(() => null),
  };
  const agents = {
    hasAgent: mock(() => true),
    supportsImages: mock(() => true),
    modelSupportsImages: mock(() => Promise.resolve(true)),
    startSession: mock(() => Promise.resolve(undefined)),
    resolvePermission: mock(() => undefined),
    supportsFork: mock(() => true),
    supportsForkAtMessage: mock(() => true),
    supportsForkWhileRunning: mock(() => false),
    supportsUpdateProjectPath: mock(() => true),
    requiresNativePathForProjectPathUpdate: mock((agentId) => agentId === 'pi'),
    isAgentSessionRunning: mock(() => false),
    forkAgentSession: mock(() => Promise.resolve(null)),
    discardForkedAgentSession: mock(() => Promise.resolve(undefined)),
    compactSession: mock(() => Promise.resolve(undefined)),
    resolveNativeSession: mock((chat) => Promise.resolve(chat.nativeSession ?? null)),
    prepareProjectPathUpdate: mock(() => Promise.resolve(undefined)),
    getAgentAuthStatusMap: mock(() => ({})),
    getAgentReadinessMap: mock(() => ({})),
    getAgentCatalogEntries: mock(() => []),
    getAgentCatalogEntry: mock(() => Promise.resolve({
      supportedPermissionModes: ['default', 'acceptEdits', 'manualBypass', 'bypassPermissions', 'plan'],
      supportedThinkingModes: ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    })),
    runSingleQuery: mock(() => Promise.resolve('')),
    ...overrides.agents,
  };
  const pendingInputs = overrides.pendingInputsService ?? {
    register: mock(() => Promise.resolve(undefined)),
    clearChat: mock(() => undefined),
    reconcileRetainedHistory: mock(() => Promise.resolve(undefined)),
    reconcileNativeHistory: mock(() => Promise.resolve(undefined)),
    markFailed: mock(() => false),
    markUnconfirmed: mock(() => false),
    clear: mock(() => false),
    hasInFlightForChat: mock(() => false),
    ...overrides.pendingInputs,
  };
  const forkChatFileCopy = overrides.forkChatFileCopy ?? mock(() => Promise.resolve({
    sourceChatId: SOURCE_CHAT_ID,
    chatId: TARGET_CHAT_ID,
    agentId: 'claude',
    agentSessionId: 'agent-2',
    sourceNextForkOrdinal: 1,
    rollback: mock(() => Promise.resolve(undefined)),
  }));
  const carryOver = {
    stageFork: mock(() => Promise.resolve({
      sourceRenderedMessageCount: 0,
      selectedRenderedMessageCount: 0,
      staged: false,
    })),
    promoteStaged: mock(() => Promise.resolve()),
    discardStaged: mock(() => Promise.resolve()),
  };
  const ownership = overrides.ownership ?? {
    delete: mock(async (chatId) => {
      sessions.delete(chatId);
    }),
  };
  const ledger = overrides.ledger ?? new CommandLedger(workspaceDir);
  const chatListProjector = {
    buildOne: mock((chatId) => {
      const chat = sessions.get(chatId);
      return Promise.resolve(projectedChat(chatId, chat?.projectPath ?? '/repo'));
    }),
  };
  const pathCache = {
    resolveProjectPath: mock((projectPath) =>
      Promise.resolve({
        available: true,
        effectiveProjectKey: projectPath,
      }),
    ),
  };
  const chatViews = overrides.chatViews ?? {
    getNativeHistoryLastSeq: mock(() => null),
    getCursor: mock(() => ({ generationId: 'generation-1', lastSeq: 0 })),
  };
  const idleReconciler = overrides.idleReconciler ?? {
    ensureReconciled: mock(async () => undefined),
  };
  const fileMentions = overrides.fileMentions ?? {
    resolve: mock(async (command) => command),
  };
  const service = new ChatCommandService({
    chats,
    queue,
    chatViews,
    idleReconciler,
    ledger,
    settings,
    recentTitleIcons: {
      getRecentIcons: () => [],
    },
    metadata,
    agents,
    pendingInputs,
    fileMentions,
    chatIds: overrides.chatIds ?? new ChatIdAllocator(chats),
    chatListProjector,
    pathCache,
    forkChatFileCopy,
    carryOver,
    ownership,
    chatMutationLock: overrides.chatMutationLock,
  });
  activeServices.push(service);
  return {
    service,
    chats,
    queue,
    chatViews,
    idleReconciler,
    settings,
    agents,
    pendingInputs,
    fileMentions,
    forkChatFileCopy,
    ledger,
    sessions,
    chatListProjector,
    pathCache,
    ownership,
  };
}

function makeRealQueue(pendingInputsService, turnRunnerOverrides = {}) {
  return new ChatExecutionCoordinator(
    workspaceDir,
    {
      runAgentTurn: mock(async () => undefined),
      captureSteerTarget: mock(() => null),
      abortSession: mock(async () => false),
      isChatRunning: mock(() => false),
      waitUntilTurnAbortable: mock(async () => false),
      ...turnRunnerOverrides,
    },
    pendingInputsService,
    { appendMessages: mock(async () => ({ generationId: 'generation-1', messages: [] })) },
    () => ({}),
    () => true,
    new InMemoryChatExecutionControlRepository('server-instance-test'),
  );
}

function readLedgerRecord(ledger, commandType, clientRequestId, chatId = SOURCE_CHAT_ID) {
  return ledger.getRecord(commandLedgerKey(commandType, chatId, clientRequestId));
}

function attachment(mimeType, content = 'hello') {
  return {
    data: `data:${mimeType};base64,${Buffer.from(content).toString('base64')}`,
    name: 'attachment.bin',
    mimeType,
  };
}

describe('ChatCommandService', () => {
  beforeEach(async () => {
    activeServices = [];
    workspaceDir = path.join(os.tmpdir(), `garcon-command-service-${randomUUID()}`);
    projectBaseDir = path.join(os.tmpdir(), `garcon-command-service-project-${randomUUID()}`);
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(projectBaseDir, { recursive: true });
    originalProjectBaseDir = process.env.GARCON_PROJECT_BASE_DIR;
    process.env.GARCON_PROJECT_BASE_DIR = projectBaseDir;
  });

  afterEach(async () => {
    await Promise.all(activeServices.map((service) => service.waitForBackgroundTasks()));
    await fs.rm(workspaceDir, { recursive: true, force: true });
    await fs.rm(projectBaseDir, { recursive: true, force: true });
    if (originalProjectBaseDir === undefined) {
      delete process.env.GARCON_PROJECT_BASE_DIR;
    } else {
      process.env.GARCON_PROJECT_BASE_DIR = originalProjectBaseDir;
    }
  });

  it('rejects empty commands', async () => {
    const { service } = makeService();

    await expect(
      service.submitRun({
        chatId: SOURCE_CHAT_ID,
        command: '',
        clientRequestId: 'req-1',
        clientMessageId: 'msg-1',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('rejects unsupported chat start attachments before creating the chat', async () => {
    const { service, chats, agents } = makeService();

    await expect(
      service.submitStart({
        chatId: TARGET_CHAT_ID,
        agentId: 'claude',
        projectPath: projectBaseDir,
        command: 'start with this file',
        model: 'opus',
        images: [attachment('image/png')],
        clientRequestId: 'req-start-bad-attachment',
        clientMessageId: 'msg-start-bad-attachment',
      }),
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      status: 400,
    });

    expect(chats.addChat).not.toHaveBeenCalled();
    expect(agents.startSession).not.toHaveBeenCalled();
  });

  it('rejects a colliding chat ID before accepting a command ledger record', async () => {
    const { service, ledger, queue } = makeService();

    await expect(service.submitStart({
      chatId: SOURCE_CHAT_ID,
      agentId: 'claude',
      projectPath: projectBaseDir,
      command: 'start somewhere new',
      model: 'opus',
      agentSettings: agentSettings(),
      clientRequestId: 'req-chat-id-collision',
      clientMessageId: 'msg-chat-id-collision',
    })).rejects.toMatchObject({
      code: 'CHAT_ID_COLLISION',
      status: 409,
    });

    expect(await ledger.getRecord(commandLedgerKey(
      'chat-start',
      SOURCE_CHAT_ID,
      'req-chat-id-collision',
    ))).toBeNull();
    expect(queue.runInitialInput).not.toHaveBeenCalled();
  });

  it('stores chat start tags normalized by the request boundary', async () => {
    const { service, chats, ledger } = makeService();

    const result = await service.submitStart(parseStartChatCommandRequest({
      chatId: TARGET_CHAT_ID,
      agentId: 'claude',
      projectPath: projectBaseDir,
      command: 'start with normalized tags',
      model: 'opus',
      agentSettings: agentSettings(),
      tags: ['Review Needed', 'review-needed', '  QA  ', 42, '!!!'],
      clientRequestId: 'req-start-tags',
      clientMessageId: 'msg-start-tags',
      permissionMode: 'default',
      thinkingMode: 'none',
    }));

    expect(result.status).toBe('accepted');
    expect(chats.addChat).toHaveBeenCalledWith(
      expect.objectContaining({
        tags: ['qa', 'review-needed'],
      }),
    );

    const record = await readLedgerRecord(ledger, 'chat-start', 'req-start-tags', TARGET_CHAT_ID);
    expect(record.payload.tags).toEqual(['qa', 'review-needed']);
  });

  it('keeps interactive and scheduled new-chat creation behavior conformant', async () => {
    const allocate = mock(() => SCHEDULED_CHAT_ID);
    const { service, chats, agents } = makeService({ chatIds: { allocate } });
    const shared = {
      agentId: 'claude',
      projectPath: projectBaseDir,
      command: 'review the repository',
      model: 'opus',
      apiProviderId: null,
      modelEndpointId: null,
      modelProtocol: null,
      permissionMode: 'default',
      thinkingMode: 'ultra',
      tags: ['qa', 'review-needed'],
    };

    await service.submitStart({
      ...shared,
      chatId: TARGET_CHAT_ID,
      clientRequestId: 'req-interactive',
      clientMessageId: 'msg-interactive',
      agentSettings: agentSettings(),
    });
    const scheduled = await service.submitScheduledStart({
      ...shared,
      clientRequestId: 'req-scheduled',
      clientMessageId: 'msg-scheduled',
      agentSettingsById: { claude: agentSettings() },
    });

    expect(scheduled.chatId).toBe(SCHEDULED_CHAT_ID);
    expect(allocate).toHaveBeenCalledTimes(1);
    const [{ id: interactiveId, ...interactive }, { id: scheduledId, ...scheduledEntry }] =
      chats.addChat.mock.calls.map(([entry]) => entry);
    expect(interactiveId).toBe(TARGET_CHAT_ID);
    expect(scheduledId).toBe(SCHEDULED_CHAT_ID);
    expect(scheduledEntry).toEqual(interactive);
    expect(interactive.thinkingMode).toBe('ultra');
    expect(interactive.tags).toEqual(['qa', 'review-needed']);
    expect(agents.startSession).toHaveBeenNthCalledWith(
      1,
      TARGET_CHAT_ID,
      shared.command,
      expect.objectContaining({ projectPath: projectBaseDir }),
    );
    expect(agents.startSession).toHaveBeenNthCalledWith(
      2,
      SCHEDULED_CHAT_ID,
      shared.command,
      expect.objectContaining({ projectPath: projectBaseDir }),
    );
  });

  it('holds the chat mutation lock and execution reservation throughout session start', async () => {
    let releaseStart;
    let markStartEntered;
    const startGate = new Promise((resolve) => {
      releaseStart = resolve;
    });
    const startEntered = new Promise((resolve) => {
      markStartEntered = resolve;
    });
    const startSession = mock(async () => {
      markStartEntered();
      await startGate;
    });
    const { service, queue } = makeService({ agents: { startSession } });
    const startPromise = service.submitStart({
      chatId: TARGET_CHAT_ID,
      agentId: 'claude',
      projectPath: projectBaseDir,
      command: 'start safely',
          model: 'opus',
          agentSettings: agentSettings(),
      clientRequestId: 'req-start-reserved',
      clientMessageId: 'msg-start-reserved',
    });
    await startEntered;
    expect(startSession).toHaveBeenCalledTimes(1);

    const queuePromise = service.submitQueueEntryCreate({
      chatId: TARGET_CHAT_ID,
      content: 'run after start',
      clientRequestId: 'req-queue-after-start',
    });
    await Promise.resolve();

    expect(queue.reserveDirectTurn).toHaveBeenCalledWith(
      TARGET_CHAT_ID,
      expect.objectContaining({
        clientRequestId: 'req-start-reserved',
        turnId: expect.any(String),
      }),
    );
    expect(queue.createChatQueueEntry).not.toHaveBeenCalled();

    releaseStart();
    await startPromise;
    await queuePromise;

    expect(queue.completeDirectTurn).toHaveBeenCalledTimes(1);
    expect(queue.createChatQueueEntry).toHaveBeenCalledTimes(1);
    expect(queue.completeDirectTurn.mock.invocationCallOrder[0])
      .toBeLessThan(queue.createChatQueueEntry.mock.invocationCallOrder[0]);
  });

  it('removes a failed start before releasing its execution reservation', async () => {
    const startSession = mock(async () => {
      throw new Error('provider startup failed');
    });
    const { service, chats, queue, pendingInputs, settings } = makeService({
      agents: { startSession },
    });

    await expect(service.submitStart({
      chatId: TARGET_CHAT_ID,
      agentId: 'claude',
      projectPath: projectBaseDir,
      command: 'start then fail',
      model: 'opus',
      agentSettings: agentSettings(),
      clientRequestId: 'req-start-failed',
      clientMessageId: 'msg-start-failed',
    })).rejects.toThrow('provider startup failed');

    expect(pendingInputs.clearChat).toHaveBeenCalledWith(TARGET_CHAT_ID, 'chat-removed');
    expect(settings.removeFromAllOrderLists).toHaveBeenCalledWith(TARGET_CHAT_ID);
    expect(chats.removeChat.mock.invocationCallOrder[0])
      .toBeLessThan(queue.failDirectTurn.mock.invocationCallOrder[0]);
    expect(chats.removeChat).toHaveBeenCalledWith(TARGET_CHAT_ID, 'start-compensation');
    expect(chats.getChat(TARGET_CHAT_ID)).toBeNull();
  });

  it('keeps a compensated pre-schedule start failure reopenable', async () => {
    let attempts = 0;
    const { service, queue, settings, agents } = makeService();
    settings.ensureInNormal.mockImplementation(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('startup bookkeeping failed');
    });
    const input = {
      chatId: TARGET_CHAT_ID,
      agentId: 'claude',
      projectPath: projectBaseDir,
      command: 'retry startup',
      model: 'opus',
      agentSettings: agentSettings(),
      clientRequestId: 'req-start-reopen',
      clientMessageId: 'msg-start-reopen',
    };

    await expect(service.submitStart(input)).rejects.toThrow('startup bookkeeping failed');
    await expect(service.submitStart(input)).resolves.toMatchObject({ status: 'accepted' });

    expect(settings.ensureInNormal).toHaveBeenCalledTimes(2);
    expect(agents.startSession).toHaveBeenCalledTimes(1);
    expect(queue.runInitialInput).toHaveBeenCalledTimes(2);
  });

  it('replays an accepted start before revalidating a removed project path', async () => {
    const { service, queue } = makeService({ session: null });
    const input = {
      chatId: TARGET_CHAT_ID,
      agentId: 'claude',
      projectPath: projectBaseDir,
      command: 'start once',
      model: 'opus',
      agentSettings: agentSettings(),
      clientRequestId: 'req-start-replay',
      clientMessageId: 'msg-start-replay',
    };

    const first = await service.submitStart(input);
    await fs.rm(projectBaseDir, { recursive: true, force: true });
    const replay = await service.submitStart(input);

    expect(replay).toMatchObject({
      status: 'duplicate',
      chatId: TARGET_CHAT_ID,
      turnId: first.turnId,
    });
    expect(queue.runInitialInput).toHaveBeenCalledTimes(1);
  });

  it('replays accepted start identity without retaining a deleted chat projection', async () => {
    const { service, queue, sessions, chatListProjector } = makeService({ session: null });
    const input = {
      chatId: TARGET_CHAT_ID,
      agentId: 'claude',
      projectPath: projectBaseDir,
      command: 'start once',
      model: 'opus',
      agentSettings: agentSettings(),
      clientRequestId: 'req-start-deleted-replay',
      clientMessageId: 'msg-start-deleted-replay',
    };

    const first = await service.submitStart(input);
    sessions.delete(TARGET_CHAT_ID);
    chatListProjector.buildOne.mockResolvedValueOnce(null);
    const replay = await service.submitStart(input);

    expect(replay).toEqual({
      ...first,
      status: 'duplicate',
      chat: null,
    });
    expect(queue.runInitialInput).toHaveBeenCalledTimes(1);
  });

  it('keeps an unprojectable live start replay retryable', async () => {
    const { service, queue, chatListProjector } = makeService({ session: null });
    const input = {
      chatId: TARGET_CHAT_ID,
      agentId: 'claude',
      projectPath: projectBaseDir,
      command: 'start once',
      model: 'opus',
      agentSettings: agentSettings(),
      clientRequestId: 'req-start-unprojectable-replay',
      clientMessageId: 'msg-start-unprojectable-replay',
    };

    await service.submitStart(input);
    chatListProjector.buildOne.mockResolvedValueOnce(null);

    await expect(service.submitStart(input)).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      status: 500,
      retryable: true,
    });
    expect(queue.runInitialInput).toHaveBeenCalledTimes(1);
  });

  it('replays a terminally failed start so callers can read its receipt', async () => {
    const { service, ledger, queue } = makeService({ session: null });
    const input = {
      chatId: TARGET_CHAT_ID,
      agentId: 'claude',
      projectPath: projectBaseDir,
      command: 'start then fail',
      model: 'opus',
      agentSettings: agentSettings(),
      clientRequestId: 'req-start-terminal-replay',
      clientMessageId: 'msg-start-terminal-replay',
    };

    const first = await service.submitStart(input);
    await ledger.settleTerminal(
      `chat-start:${TARGET_CHAT_ID}:req-start-terminal-replay`,
      'failed',
      { error: 'provider rejected the turn' },
    );
    await ledger.markPublicTerminal(TARGET_CHAT_ID, first.turnId);
    const replay = await service.submitStart(input);

    expect(replay).toMatchObject({
      status: 'duplicate',
      chatId: TARGET_CHAT_ID,
      turnId: first.turnId,
    });
    expect(queue.runInitialInput).toHaveBeenCalledTimes(1);
  });

  it('rejects a private terminal start failure instead of returning an unreadable receipt', async () => {
    const { service, ledger, queue } = makeService({ session: null });
    const input = {
      chatId: TARGET_CHAT_ID,
      agentId: 'claude',
      projectPath: projectBaseDir,
      command: 'start then fail privately',
      model: 'opus',
      agentSettings: agentSettings(),
      clientRequestId: 'req-start-private-failure',
      clientMessageId: 'msg-start-private-failure',
    };

    await service.submitStart(input);
    await ledger.settleTerminal(
      `chat-start:${TARGET_CHAT_ID}:req-start-private-failure`,
      'failed',
      { error: 'startup rollback failed' },
    );

    await expect(service.submitStart(input)).rejects.toThrow('startup rollback failed');
    expect(queue.runInitialInput).toHaveBeenCalledTimes(1);
  });

  it('serializes Stop behind provider startup for the same chat', async () => {
    const events = [];
    const startGate = deferred();
    const startEntered = deferred();
    const startSession = mock(async () => {
      events.push('start-entered');
      startEntered.resolve();
      await startGate.promise;
      events.push('start-finished');
    });
    const stopActiveTurn = mock(async () => {
      events.push('stop');
      return { outcome: 'interrupt-requested', control: storedQueue() };
    });
    const { service } = makeService({
      agents: { startSession },
      queue: { stopActiveTurn },
    });
    const start = service.submitStart({
      chatId: TARGET_CHAT_ID,
      agentId: 'claude',
      projectPath: projectBaseDir,
      command: 'start before stop',
      model: 'opus',
      agentSettings: agentSettings(),
      clientRequestId: 'req-start-before-stop',
      clientMessageId: 'msg-start-before-stop',
    });
    await startEntered.promise;

    const stop = service.submitStop({
      chatId: TARGET_CHAT_ID,
      clientRequestId: 'req-stop-during-start',
    });
    await Promise.resolve();
    expect(stopActiveTurn).not.toHaveBeenCalled();

    startGate.resolve();
    await Promise.all([start, stop]);
    expect(events).toEqual(['start-entered', 'start-finished', 'stop']);
  });

  it('records already-idle Stop as finished and replays its exact outcome', async () => {
    const stopActiveTurn = mock(async () => ({
      outcome: 'already-idle',
      control: storedQueue(),
    }));
    const { service } = makeService({ queue: { stopActiveTurn } });
    const input = {
      chatId: SOURCE_CHAT_ID,
      clientRequestId: 'req-stop-already-idle',
    };

    const first = await service.submitStop(input);
    const duplicate = await service.submitStop(input);

    expect(first).toMatchObject({
      status: 'accepted',
      outcome: 'already-idle',
    });
    expect(duplicate).toMatchObject({
      status: 'duplicate',
      outcome: 'already-idle',
    });
    expect(stopActiveTurn).toHaveBeenCalledTimes(1);
  });

  it('records provider Stop rejection as failed and replays its exact outcome', async () => {
    const stopActiveTurn = mock(async () => ({
      outcome: 'failed',
      control: storedQueue(),
    }));
    const { service } = makeService({ queue: { stopActiveTurn } });
    const input = {
      chatId: SOURCE_CHAT_ID,
      clientRequestId: 'req-stop-failed',
    };

    const first = await service.submitStop(input);
    const duplicate = await service.submitStop(input);

    expect(first).toMatchObject({
      status: 'accepted',
      outcome: 'failed',
    });
    expect(duplicate).toMatchObject({
      status: 'duplicate',
      outcome: 'failed',
    });
    expect(stopActiveTurn).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['finished', 'interrupt-requested'],
    ['failed', 'failed'],
  ])('maps a legacy %s Stop ledger record to %s', async (status, expectedOutcome) => {
    const input = {
      chatId: SOURCE_CHAT_ID,
      clientRequestId: `req-stop-legacy-${status}`,
    };
    const { service, ledger, queue } = makeService();
    await service.submitStop(input);
    await ledger.update(
      commandLedgerKey('agent-stop', SOURCE_CHAT_ID, input.clientRequestId),
      { status, stopOutcome: undefined },
    );

    await expect(service.submitStop(input)).resolves.toMatchObject({
      status: 'duplicate',
      outcome: expectedOutcome,
    });
    expect(queue.stopActiveTurn).toHaveBeenCalledTimes(1);
  });

  it('replays an Interrupt and Send outcome without executing a second abort', async () => {
    const interruptActiveTurn = mock(async () => 'already-idle');
    const { service } = makeService({ queue: { interruptActiveTurn } });
    const input = {
      chatId: SOURCE_CHAT_ID,
      clientRequestId: 'req-interrupt-duplicate',
    };

    const first = await service.submitInterruptAndSend(input);
    const duplicate = await service.submitInterruptAndSend(input);

    expect(first).toMatchObject({
      status: 'accepted',
      outcome: 'already-idle',
    });
    expect(duplicate).toMatchObject({
      status: 'duplicate',
      outcome: 'already-idle',
    });
    expect(interruptActiveTurn).toHaveBeenCalledTimes(1);
  });

  it('records one acknowledged latch outcome for two unique Stop commands', async () => {
    const pendingInputsService = new PendingUserInputService({
      loadNativeMessages: mock(async () => []),
      getRetainedHistoryMessages: mock(() => []),
    });
    let running = true;
    const abortSession = mock(async () => true);
    const queueService = makeRealQueue(pendingInputsService, {
      abortSession,
      isChatRunning: mock(() => running),
    });
    const { service, ledger } = makeService({
      pendingInputsService,
      queueService,
    });

    const first = await service.submitStop({
      chatId: SOURCE_CHAT_ID,
      clientRequestId: 'req-stop-first',
    });
    const second = await service.submitStop({
      chatId: SOURCE_CHAT_ID,
      clientRequestId: 'req-stop-second',
    });

    expect(first.outcome).toBe('interrupt-requested');
    expect(second.outcome).toBe('interrupt-requested');
    expect(abortSession).toHaveBeenCalledTimes(1);
    expect((await readLedgerRecord(ledger, 'agent-stop', 'req-stop-first')).stopOutcome)
      .toBe('interrupt-requested');
    expect((await readLedgerRecord(ledger, 'agent-stop', 'req-stop-second')).stopOutcome)
      .toBe('interrupt-requested');

    running = false;
    await queueService.checkChatIdle(SOURCE_CHAT_ID);
  });

  it('settles Send now through the command lock before launching its successor once', async () => {
    const firstTurnStarted = deferred();
    const firstTurnResult = deferred();
    const firstTurnSettled = deferred();
    const successorStarted = deferred();
    const successorResult = deferred();
    const abortStarted = deferred();
    const enqueueStarted = deferred();
    const enqueueAllowed = deferred();
    let runtimeRunning = false;
    let predecessorTurn;
    let successorLaunches = 0;
    let queueService;
    const pendingInputsService = new PendingUserInputService({
      loadNativeMessages: mock(async () => []),
      getRetainedHistoryMessages: mock(() => []),
    });
    const abortSession = mock(async () => {
      abortStarted.resolve();
      return true;
    });
    const runAgentTurn = mock(async (chatId, content, options) => {
      options.executionAdmission?.markStarted();
      runtimeRunning = true;
      if (content === 'active predecessor') {
        predecessorTurn = options;
        firstTurnStarted.resolve();
        try {
          await firstTurnResult.promise;
        } finally {
          firstTurnSettled.resolve();
        }
        return;
      }
      successorLaunches += 1;
      successorStarted.resolve();
      try {
        await successorResult.promise;
      } finally {
        runtimeRunning = false;
        queueService.onAgentTurnTerminal(chatId, options);
      }
    });
    queueService = makeRealQueue(pendingInputsService, {
      runAgentTurn,
      abortSession,
      isChatRunning: mock(() => runtimeRunning),
      waitUntilTurnAbortable: mock(async () => true),
    });
    const enqueueAccepted = queueService.enqueueAccepted.bind(queueService);
    queueService.enqueueAccepted = mock(async (input) => {
      enqueueStarted.resolve();
      await enqueueAllowed.promise;
      return enqueueAccepted(input);
    });
    const { service, forkChatFileCopy } = makeService({
      queueService,
      pendingInputsService,
    });

    await service.submitRun({
      chatId: SOURCE_CHAT_ID,
      command: 'active predecessor',
      clientRequestId: 'req-send-now-predecessor',
      clientMessageId: 'msg-send-now-predecessor',
    });
    await firstTurnStarted.promise;

    const enqueue = service.submitQueueEntryCreate({
      chatId: SOURCE_CHAT_ID,
      content: 'send now successor',
      clientRequestId: 'req-send-now-successor',
    });
    await enqueueStarted.promise;
    const interrupt = service.submitInterruptAndSend({
      chatId: SOURCE_CHAT_ID,
      agentId: 'claude',
      clientRequestId: 'req-send-now-interrupt',
    });
    await Promise.resolve();
    expect(abortSession).not.toHaveBeenCalled();

    enqueueAllowed.resolve();
    await enqueue;
    await abortStarted.promise;
    expect(successorLaunches).toBe(0);

    firstTurnResult.reject(new Error('interrupted by Send now'));
    await firstTurnSettled.promise;
    await Promise.resolve();
    expect(successorLaunches).toBe(0);

    runtimeRunning = false;
    queueService.onAgentTurnTerminal(SOURCE_CHAT_ID, predecessorTurn);
    await expect(interrupt).resolves.toMatchObject({ outcome: 'interrupt-requested' });
    await successorStarted.promise;

    queueService.onAgentTurnTerminal(SOURCE_CHAT_ID, predecessorTurn);
    await queueService.triggerDrain(SOURCE_CHAT_ID);
    expect(successorLaunches).toBe(1);

    successorResult.resolve();
    await queueService.waitForExecutionOwners();
    const [pause, fork] = await Promise.all([
      service.mutateQueue({ chatId: SOURCE_CHAT_ID, action: 'pause' }),
      service.forkChat({
        sourceChatId: SOURCE_CHAT_ID,
        chatId: TARGET_CHAT_ID,
        upToSeq: 1,
      }),
    ]);

    expect(pause.success).toBe(true);
    expect(pause.control.queue).toMatchObject({
      entries: [],
      dispatchingEntryId: null,
      pause: null,
    });
    expect(fork.success).toBe(true);
    expect(forkChatFileCopy).toHaveBeenCalledTimes(1);
    expect(runAgentTurn.mock.calls.filter(([, content]) => content === 'send now successor')).toHaveLength(1);
  });

  it('orders queue creation after an in-progress Stop command', async () => {
    let releaseStop;
    let markStopEntered;
    const stopGate = new Promise((resolve) => {
      releaseStop = resolve;
    });
    const stopEntered = new Promise((resolve) => {
      markStopEntered = resolve;
    });
    const stopActiveTurn = mock(async () => {
      markStopEntered();
      await stopGate;
      return { outcome: 'interrupt-requested', control: storedQueue() };
    });
    const { service, queue } = makeService({ queue: { stopActiveTurn } });

    const stopPromise = service.submitStop({
      chatId: SOURCE_CHAT_ID,
      agentId: 'claude',
      clientRequestId: 'req-stop-with-concurrent-create',
    });
    await stopEntered;

    const createPromise = service.submitQueueEntryCreate({
      chatId: SOURCE_CHAT_ID,
      content: 'submitted while Stop is pending',
      clientRequestId: 'req-create-during-stop',
    });
    await Promise.resolve();

    expect(queue.createChatQueueEntry).not.toHaveBeenCalled();

    releaseStop();
    await stopPromise;
    await createPromise;

    expect(queue.createChatQueueEntry).toHaveBeenCalledTimes(1);
    expect(stopActiveTurn.mock.invocationCallOrder[0])
      .toBeLessThan(queue.createChatQueueEntry.mock.invocationCallOrder[0]);
  });

  it('requires command identity and rejects invalid IDs at the request boundary', async () => {
    const { chats } = makeService();
    const input = {
      chatId: TARGET_CHAT_ID,
      agentId: 'claude',
      projectPath: projectBaseDir,
      command: 'hello',
      model: 'opus',
      agentSettings: agentSettings(),
      clientRequestId: '',
      clientMessageId: 'msg-start',
    };

    expect(() => parseStartChatCommandRequest(input)).toThrow('clientRequestId is required');
    expect(() =>
      parseStartChatCommandRequest({
        ...input,
        chatId: '178372590000007231252',
        clientRequestId: 'req-start',
      }),
    ).toThrow('chatId must be a valid 16-digit Unix-microsecond timestamp');
    expect(chats.addChat).not.toHaveBeenCalled();
    await expect(fs.readFile(path.join(workspaceDir, 'command-ledger.json'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('rejects chat starts outside the configured project base', async () => {
    const { service, agents, chats } = makeService({ session: null });
    const outsidePath = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-command-service-outside-'));

    try {
      await expect(
        service.submitStart({
          chatId: TARGET_CHAT_ID,
          agentId: 'claude',
          projectPath: outsidePath,
          command: 'hello',
      model: 'opus',
      agentSettings: agentSettings(),
          clientRequestId: 'req-start-outside',
          clientMessageId: 'msg-start-outside',
        }),
      ).rejects.toMatchObject({
        code: 'PROJECT_PATH_OUTSIDE_BASE',
        status: 403,
      });

      expect(chats.addChat).not.toHaveBeenCalled();
      expect(agents.startSession).not.toHaveBeenCalled();
    } finally {
      await fs.rm(outsidePath, { recursive: true, force: true });
    }
  });

  it('deduplicates HTTP retries without resubmitting queue work', async () => {
    const { service, queue } = makeService();
    const input = {
      chatId: SOURCE_CHAT_ID,
      command: 'continue',
      clientRequestId: 'req-1',
      clientMessageId: 'msg-1',
      model: 'opus',
      permissionMode: 'default',
      thinkingMode: 'none',
      agentSettings: agentSettings(),
    };

    const first = await service.submitRun(input);
    const second = await service.submitRun(input);

    expect(first.status).toBe('accepted');
    expect(second.status).toBe('duplicate');
    expect(queue.registerPendingUserInput).toHaveBeenCalledTimes(1);
    expect(queue.runReservedTurn).toHaveBeenCalledTimes(1);
    expect(queue.runReservedTurn.mock.calls[0][2]).toMatchObject({
      clientRequestId: 'req-1',
      commandType: 'agent-run',
    });
  });

  it('replays an admitted run before revalidating changed persisted defaults', async () => {
    const { service, chats, queue } = makeService({
      session: { permissionMode: 'default' },
    });
    const input = {
      chatId: SOURCE_CHAT_ID,
      command: 'continue',
      clientRequestId: 'req-stable-replay',
      clientMessageId: 'msg-stable-replay',
      permissionFallbackPolicy: 'require-explicit-bypass',
    };

    await service.submitRun(input);
    chats.updateChat(SOURCE_CHAT_ID, { permissionMode: 'bypassPermissions' });
    const replay = await service.submitRun(input);

    expect(replay.status).toBe('duplicate');
    expect(queue.registerPendingUserInput).toHaveBeenCalledTimes(1);
  });

  it('replays a terminally failed run so callers can read its receipt', async () => {
    const { service, ledger, queue } = makeService();
    const input = {
      chatId: SOURCE_CHAT_ID,
      command: 'continue',
      clientRequestId: 'req-failed-replay',
      clientMessageId: 'msg-failed-replay',
    };

    const first = await service.submitRun(input);
    await ledger.settleTerminal(
      `agent-run:${SOURCE_CHAT_ID}:req-failed-replay`,
      'failed',
      { error: 'provider rejected the turn' },
    );
    await ledger.markPublicTerminal(SOURCE_CHAT_ID, first.turnId);
    const replay = await service.submitRun(input);

    expect(replay).toMatchObject({
      status: 'duplicate',
      chatId: SOURCE_CHAT_ID,
      turnId: first.turnId,
    });
    expect(queue.registerPendingUserInput).toHaveBeenCalledTimes(1);
  });

  it('rejects a private terminal run failure instead of returning an unreadable receipt', async () => {
    const { service, ledger, queue } = makeService();
    const input = {
      chatId: SOURCE_CHAT_ID,
      command: 'continue privately',
      clientRequestId: 'req-private-failed-replay',
      clientMessageId: 'msg-private-failed-replay',
    };

    await service.submitRun(input);
    await ledger.settleTerminal(
      `agent-run:${SOURCE_CHAT_ID}:req-private-failed-replay`,
      'failed',
      { error: 'run rollback failed' },
    );

    await expect(service.submitRun(input)).rejects.toThrow('run rollback failed');
    expect(queue.registerPendingUserInput).toHaveBeenCalledTimes(1);
  });

  it('asserts the resume agent and adds tags only after admission', async () => {
    const { service, chats, queue } = makeService();

    await expect(service.submitRun({
      chatId: SOURCE_CHAT_ID,
      command: 'continue',
      clientRequestId: 'req-agent-mismatch',
      clientMessageId: 'msg-agent-mismatch',
      expectedAgentId: 'codex',
      tagsToAdd: ['cli'],
    })).rejects.toMatchObject({ code: 'EXPECTED_AGENT_MISMATCH', status: 409 });
    expect(queue.registerPendingUserInput).not.toHaveBeenCalled();
    expect(chats.addTags).not.toHaveBeenCalled();

    const result = await service.submitRun({
      chatId: SOURCE_CHAT_ID,
      command: 'continue',
      clientRequestId: 'req-agent-match',
      clientMessageId: 'msg-agent-match',
      expectedAgentId: 'claude',
      tagsToAdd: ['cli'],
    });

    expect(result.status).toBe('accepted');
    expect(chats.addTags).toHaveBeenCalledWith(SOURCE_CHAT_ID, ['cli']);
  });

  it('applies supported resume overrides to one turn without persisting them', async () => {
    const { service, chats, queue } = makeService();

    await service.submitRun({
      chatId: SOURCE_CHAT_ID,
      command: 'continue deeply',
      clientRequestId: 'req-overrides',
      clientMessageId: 'msg-overrides',
      model: 'sonnet',
      permissionMode: 'acceptEdits',
      thinkingMode: 'high',
      agentSettings: agentSettings('claude', { effort: 'high' }),
    });

    expect(queue.runReservedTurn.mock.calls[0][2]).toMatchObject({
      model: 'sonnet',
      permissionMode: 'acceptEdits',
      thinkingMode: 'high',
      agentSettings: agentSettings('claude', { effort: 'high' }),
    });
    expect(chats.updateChat).not.toHaveBeenCalled();
  });

  it('requires bypass permission to be explicit when inherited bypass is rejected', async () => {
    const { service, queue, ledger } = makeService({
      session: { permissionMode: 'bypassPermissions' },
    });

    await expect(service.submitRun({
      chatId: SOURCE_CHAT_ID,
      command: 'continue',
      clientRequestId: 'req-inherited-bypass',
      clientMessageId: 'msg-inherited-bypass',
      permissionFallbackPolicy: 'require-explicit-bypass',
    })).rejects.toMatchObject({ code: 'EXPLICIT_BYPASS_REQUIRED', status: 422 });
    expect(queue.registerPendingUserInput).not.toHaveBeenCalled();
    expect(await readLedgerRecord(ledger, 'agent-run', 'req-inherited-bypass')).toBeNull();

    await service.submitRun({
      chatId: SOURCE_CHAT_ID,
      command: 'continue explicitly',
      clientRequestId: 'req-explicit-bypass',
      clientMessageId: 'msg-explicit-bypass',
      permissionMode: 'bypassPermissions',
      permissionFallbackPolicy: 'require-explicit-bypass',
    });
    expect(queue.registerPendingUserInput).toHaveBeenCalledTimes(1);
  });

  it('rejects unsupported explicit modes before creating a command receipt', async () => {
    const { service, queue, ledger } = makeService({
      agents: {
        getAgentCatalogEntry: mock(() => Promise.resolve({
          supportedPermissionModes: ['default'],
          supportedThinkingModes: ['none'],
        })),
      },
    });

    await expect(service.submitRun({
      chatId: SOURCE_CHAT_ID,
      command: 'continue',
      clientRequestId: 'req-unsupported-mode',
      clientMessageId: 'msg-unsupported-mode',
      permissionMode: 'acceptEdits',
    })).rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 422 });

    expect(queue.registerPendingUserInput).not.toHaveBeenCalled();
    expect(await readLedgerRecord(ledger, 'agent-run', 'req-unsupported-mode')).toBeNull();
  });

  it('rejects a concurrent direct submission before pending input preparation', async () => {
    let activeReservation = null;
    let releaseExecution;
    let markExecutionFinished;
    const executionGate = new Promise((resolve) => {
      releaseExecution = resolve;
    });
    const executionFinished = new Promise((resolve) => {
      markExecutionFinished = resolve;
    });
    const reserveDirectTurn = mock((chatId) => {
      if (activeReservation) {
        throw Object.assign(new Error('Another chat turn already owns execution'), {
          code: 'SESSION_BUSY',
          status: 409,
          retryable: true,
        });
      }
      activeReservation = directReservation(chatId);
      return activeReservation;
    });
    const releaseDirectTurn = mock(async (reservation) => {
      if (activeReservation?.reservationId === reservation.reservationId) activeReservation = null;
    });
    const runReservedTurn = mock(async (reservation) => {
      await executionGate;
      if (activeReservation?.reservationId === reservation.reservationId) activeReservation = null;
      markExecutionFinished();
    });
    const registerPendingUserInput = mock(async () => undefined);
    const { service } = makeService({
      queue: {
        reserveDirectTurn,
        releaseDirectTurn,
        runReservedTurn,
        registerPendingUserInput,
      },
    });

    await expect(service.submitRun({
      chatId: SOURCE_CHAT_ID,
      command: 'first',
      clientRequestId: 'req-concurrent-1',
      clientMessageId: 'msg-concurrent-1',
    })).resolves.toMatchObject({ status: 'accepted' });
    const rejection = service.submitRun({
      chatId: SOURCE_CHAT_ID,
      command: 'second',
      clientRequestId: 'req-concurrent-2',
      clientMessageId: 'msg-concurrent-2',
    });
    await expect(rejection).rejects.toMatchObject({ code: 'SESSION_BUSY', status: 409 });

    expect(registerPendingUserInput).toHaveBeenCalledTimes(1);
    expect(runReservedTurn).toHaveBeenCalledTimes(1);
    expect(releaseDirectTurn).not.toHaveBeenCalled();
    releaseExecution();
    await executionFinished;
    await Promise.resolve();
  });

  it('rejects a direct run that would bypass queued input', async () => {
    const { service, queue, ledger } = makeService({
      queue: {
        readChatExecutionControl: mock(() => Promise.resolve(storedQueue(
          [queueEntry('entry-1', 'first')],
          { pause: manualPause() },
        ))),
      },
    });

    await expect(
      service.submitRun({
        chatId: SOURCE_CHAT_ID,
        command: 'must stay second',
        clientRequestId: 'req-fifo',
        clientMessageId: 'msg-fifo',
      }),
    ).rejects.toMatchObject({
      code: 'SESSION_BUSY',
      status: 409,
      retryable: true,
    });

    expect(queue.registerPendingUserInput).not.toHaveBeenCalled();
    expect(queue.runReservedTurn).not.toHaveBeenCalled();
    expect(queue.releaseDirectTurn).toHaveBeenCalledTimes(1);
  });

  it('rejects a direct run while the queue head is dispatching', async () => {
    const { service, queue } = makeService({
      queue: {
        readChatExecutionControl: mock(() => Promise.resolve(storedQueue([queueEntry('entry-1', 'first', 'sending')]))),
      },
    });

    await expect(
      service.submitRun({
        chatId: SOURCE_CHAT_ID,
        command: 'must stay second',
        clientRequestId: 'req-fifo-sending',
        clientMessageId: 'msg-fifo-sending',
      }),
    ).rejects.toMatchObject({ code: 'SESSION_BUSY', status: 409 });

    expect(queue.registerPendingUserInput).not.toHaveBeenCalled();
    expect(queue.runReservedTurn).not.toHaveBeenCalled();
    expect(queue.releaseDirectTurn).toHaveBeenCalledTimes(1);
  });

  it('marks accepted HTTP commands failed when submit append fails', async () => {
    const { service, queue, pendingInputs, ledger } = makeService();
    queue.registerPendingUserInput.mockRejectedValueOnce(new Error('append failed'));

    await expect(
      service.submitRun({
        chatId: SOURCE_CHAT_ID,
        command: 'continue',
        clientRequestId: 'req-fail-1',
        clientMessageId: 'msg-fail-1',
      }),
    ).rejects.toThrow('append failed');

    const record = await readLedgerRecord(ledger, 'agent-run', 'req-fail-1');
    expect(record).toMatchObject({
      commandType: 'agent-run',
      chatId: SOURCE_CHAT_ID,
      clientRequestId: 'req-fail-1',
      status: 'failed',
      error: 'append failed',
      errorCode: 'PRE_SCHEDULE_FAILED',
    });
    expect(pendingInputs.markFailed).toHaveBeenCalledWith(SOURCE_CHAT_ID, 'req-fail-1');
    expect(queue.runReservedTurn).not.toHaveBeenCalled();
    expect(queue.releaseDirectTurn).toHaveBeenCalledTimes(1);
  });

  it('keeps an already-appended pending row failed when ledger scheduling fails', async () => {
    const record = {
      key: `agent-run:${SOURCE_CHAT_ID}:req-ledger-failed`,
      commandType: 'agent-run',
      chatId: SOURCE_CHAT_ID,
      clientRequestId: 'req-ledger-failed',
      payloadHash: 'hash',
      payload: {},
      status: 'accepted',
      acceptedAt: '2026-07-17T00:00:00.000Z',
      updatedAt: '2026-07-17T00:00:00.000Z',
    };
    const ledger = {
      getRecord: mock(async () => null),
      accept: mock(async () => ({ kind: 'accepted', record })),
      update: mock()
        .mockRejectedValueOnce(new Error('ledger unavailable'))
        .mockResolvedValueOnce({ ...record, status: 'failed' }),
    };
    const { service, queue, pendingInputs } = makeService({ ledger });

    await expect(service.submitRun({
      chatId: SOURCE_CHAT_ID,
      command: 'already appended',
      clientRequestId: 'req-ledger-failed',
      clientMessageId: 'msg-ledger-failed',
    })).rejects.toThrow('ledger unavailable');

    expect(queue.registerPendingUserInput).toHaveBeenCalledTimes(1);
    expect(pendingInputs.markFailed).toHaveBeenCalledWith(
      SOURCE_CHAT_ID,
      'req-ledger-failed',
    );
    expect(queue.releaseDirectTurn).toHaveBeenCalledTimes(1);
  });

  it('does not return duplicate accepted after a failed pre-schedule append', async () => {
    const { service, queue } = makeService();
    const input = {
      chatId: SOURCE_CHAT_ID,
      command: 'continue',
      clientRequestId: 'req-retry-1',
      clientMessageId: 'msg-retry-1',
    };
    queue.registerPendingUserInput.mockRejectedValueOnce(new Error('append failed')).mockResolvedValueOnce(undefined);

    await expect(service.submitRun(input)).rejects.toThrow('append failed');
    const retry = await service.submitRun(input);

    expect(retry.status).toBe('accepted');
    expect(queue.registerPendingUserInput).toHaveBeenCalledTimes(2);
    expect(queue.runReservedTurn).toHaveBeenCalledTimes(1);
  });

  it('rolls back a fork target before admitting a pre-schedule retry', async () => {
    const rollbacks = [];
    const forkChatFileCopy = mock(async () => {
      const rollback = mock(async () => undefined);
      rollbacks.push(rollback);
      return {
        sourceChatId: SOURCE_CHAT_ID,
        chatId: TARGET_CHAT_ID,
        agentId: 'claude',
        agentSessionId: 'agent-2',
        sourceNextForkOrdinal: 1,
        rollback,
      };
    });
    const { service, queue } = makeService({ forkChatFileCopy });
    const input = {
      sourceChatId: SOURCE_CHAT_ID,
      chatId: TARGET_CHAT_ID,
      command: 'continue in fork',
      clientRequestId: 'req-fork-retry',
      clientMessageId: 'msg-fork-retry',
    };
    queue.registerPendingUserInput
      .mockRejectedValueOnce(new Error('fork append failed'))
      .mockResolvedValueOnce(undefined);

    await expect(service.submitForkRun(input)).rejects.toThrow('fork append failed');
    const retry = await service.submitForkRun(input);

    expect(retry.status).toBe('accepted');
    expect(forkChatFileCopy).toHaveBeenCalledTimes(2);
    expect(rollbacks[0]).toHaveBeenCalledOnce();
    expect(rollbacks[1]).not.toHaveBeenCalled();
    expect(queue.registerPendingUserInput).toHaveBeenCalledTimes(2);
    expect(queue.runReservedTurn).toHaveBeenCalledTimes(1);
  });

  it('cleans a fork target when preparation fails before returning its result', async () => {
    const forkChatFileCopy = mock(async ({ registry }) => {
      registry.addChat({
        id: TARGET_CHAT_ID,
        agentId: 'claude',
        agentSessionId: 'agent-2',
        nativeSession: null,
        agentOwnershipEpoch: 'target-epoch',
        agentSettingsById: { claude: agentSettings() },
        projectPath: '/repo',
        model: 'opus',
        tags: [],
      });
      registry.updateChat(SOURCE_CHAT_ID, { nextForkOrdinal: 2 });
      throw new Error('fork setup failed');
    });
    const { service, ownership, sessions, settings } = makeService({ forkChatFileCopy });

    await expect(service.submitForkRun({
      sourceChatId: SOURCE_CHAT_ID,
      chatId: TARGET_CHAT_ID,
      command: 'continue in fork',
      clientRequestId: 'req-fork-setup-failure',
      clientMessageId: 'msg-fork-setup-failure',
    })).rejects.toThrow('fork setup failed');

    expect(ownership.delete).toHaveBeenCalledWith(TARGET_CHAT_ID);
    expect(sessions.has(TARGET_CHAT_ID)).toBeFalse();
    expect(sessions.get(SOURCE_CHAT_ID).nextForkOrdinal).toBe(1);
    expect(settings.removeFromAllOrderLists).toHaveBeenCalledWith(TARGET_CHAT_ID);
    expect(settings.removeSessionName).toHaveBeenCalledWith(TARGET_CHAT_ID);
  });

  it('retains fork preparation when immediate compensation fails', async () => {
    const rollback = mock(async () => {
      throw new Error('rollback failed');
    });
    const forkChatFileCopy = mock(async () => ({
      sourceChatId: SOURCE_CHAT_ID,
      chatId: TARGET_CHAT_ID,
      agentId: 'claude',
      agentSessionId: 'agent-2',
      sourceNextForkOrdinal: 1,
      rollback,
    }));
    const { service, queue, ledger } = makeService({ forkChatFileCopy });
    queue.registerPendingUserInput.mockRejectedValueOnce(new Error('append failed'));

    await expect(service.submitForkRun({
      sourceChatId: SOURCE_CHAT_ID,
      chatId: TARGET_CHAT_ID,
      command: 'continue in fork',
      clientRequestId: 'req-fork-recovery',
      clientMessageId: 'msg-fork-recovery',
    })).rejects.toThrow('Failed to prepare and roll back fork-run');

    expect(rollback).toHaveBeenCalledOnce();
    await expect(readLedgerRecord(
      ledger,
      'fork-run',
      'req-fork-recovery',
      TARGET_CHAT_ID,
    )).resolves.toMatchObject({
      chatId: TARGET_CHAT_ID,
      status: 'failed',
      forkPreparation: {
        phase: 'created',
        sourceChatId: SOURCE_CHAT_ID,
        sourceNextForkOrdinal: 1,
      },
    });
  });

  it('recovers a duplicate accepted command instead of returning false success', async () => {
    const { service, queue, ledger } = makeService();
    const update = ledger.update.bind(ledger);
    let failedWrites = 0;
    ledger.update = mock((key, patch) => {
      if (
        failedWrites < 2
        && (patch.status === 'scheduled' || patch.status === 'failed')
      ) {
        failedWrites += 1;
        return Promise.reject(new Error(`ledger write ${failedWrites} failed`));
      }
      return update(key, patch);
    });
    const input = {
      chatId: SOURCE_CHAT_ID,
      command: 'recover accepted command',
      clientRequestId: 'req-recover-accepted',
      clientMessageId: 'msg-recover-accepted',
    };

    await expect(service.submitRun(input)).rejects.toThrow('ledger write 2 failed');
    expect(await readLedgerRecord(ledger, 'agent-run', input.clientRequestId)).toMatchObject({
      clientRequestId: input.clientRequestId,
      status: 'accepted',
    });

    const retry = await service.submitRun(input);

    expect(retry.status).toBe('duplicate');
    expect(queue.registerPendingUserInput).toHaveBeenCalledTimes(2);
    expect(queue.runReservedTurn).toHaveBeenCalledTimes(1);
    expect(queue.releaseDirectTurn).toHaveBeenCalledTimes(1);
    expect(await readLedgerRecord(ledger, 'agent-run', input.clientRequestId)).toMatchObject({
      clientRequestId: input.clientRequestId,
      status: 'scheduled',
    });
  });

  it('applies shared fork validation before copying', async () => {
    const { service, agents, forkChatFileCopy } = makeService();
    agents.isAgentSessionRunning.mockReturnValue(true);

    await expect(
      service.forkChat({
        sourceChatId: SOURCE_CHAT_ID,
        chatId: TARGET_CHAT_ID,
      }),
    ).rejects.toMatchObject({
      code: 'SESSION_BUSY',
      status: 409,
    });

    expect(forkChatFileCopy).not.toHaveBeenCalled();
  });

  it('keeps retryable fork-run settlement failures out of the command ledger', async () => {
    const { service, pendingInputs, ledger, queue } = makeService();
    const input = {
      sourceChatId: SOURCE_CHAT_ID,
      chatId: TARGET_CHAT_ID,
      command: 'continue in fork',
      clientRequestId: 'req-unsettled-fork',
      clientMessageId: 'msg-unsettled-fork',
    };
    pendingInputs.hasInFlightForChat.mockReturnValueOnce(true).mockReturnValue(false);

    await expect(service.submitForkRun(input)).rejects.toMatchObject({
      code: 'SESSION_BUSY',
      status: 409,
      retryable: true,
    });
    expect(await readLedgerRecord(
      ledger,
      'fork-run',
      input.clientRequestId,
      TARGET_CHAT_ID,
    )).toBeNull();
    expect(queue.releaseTranscriptSnapshot).toHaveBeenCalledTimes(1);

    await expect(service.submitForkRun(input)).resolves.toMatchObject({ status: 'accepted' });
    expect(queue.releaseTranscriptSnapshot).toHaveBeenCalledTimes(2);
  });

  it('releases the source snapshot before admitting the fork target turn', async () => {
    const order = [];
    const forkChatFileCopy = mock(async () => {
      order.push('target-created');
      return {
        sourceChatId: SOURCE_CHAT_ID,
        chatId: TARGET_CHAT_ID,
        agentId: 'claude',
        agentSessionId: 'agent-2',
        sourceNextForkOrdinal: 1,
        rollback: mock(() => Promise.resolve(undefined)),
      };
    });
    const { service, queue } = makeService({ forkChatFileCopy });
    queue.releaseTranscriptSnapshot.mockImplementation(async () => {
      order.push('source-released');
    });
    queue.registerPendingUserInput.mockImplementation(async () => {
      order.push('target-admitted');
    });

    await service.submitForkRun({
      sourceChatId: SOURCE_CHAT_ID,
      chatId: TARGET_CHAT_ID,
      command: 'continue in fork',
      clientRequestId: 'req-fork-release-order',
      clientMessageId: 'msg-fork-release-order',
    });

    expect(order).toEqual(['target-created', 'source-released', 'target-admitted']);
    expect(queue.releaseTranscriptSnapshot).toHaveBeenCalledTimes(1);
  });

  it('rejects a point fork while a lazy source is materializing', async () => {
    const { service, queue, forkChatFileCopy } = makeService({
      session: { agentSessionId: null, nativeSession: null },
    });
    queue.ownsExecution.mockReturnValue(true);

    await expect(service.forkChat({
      sourceChatId: SOURCE_CHAT_ID,
      chatId: TARGET_CHAT_ID,
      upToSeq: 1,
    })).rejects.toMatchObject({ code: 'SESSION_BUSY', status: 409, retryable: true });
    expect(forkChatFileCopy).not.toHaveBeenCalled();
  });

  it('serializes source chat submissions behind an in-progress fork snapshot', async () => {
    let releaseFork;
    let markForkStarted;
    const forkStarted = new Promise((resolve) => {
      markForkStarted = resolve;
    });
    const holdFork = new Promise((resolve) => {
      releaseFork = resolve;
    });
    const forkChatFileCopy = mock(async () => {
      markForkStarted();
      await holdFork;
      return {
        sourceChatId: SOURCE_CHAT_ID,
        chatId: TARGET_CHAT_ID,
        agentId: 'claude',
        agentSessionId: 'agent-2',
        sourceNextForkOrdinal: 1,
        rollback: mock(() => Promise.resolve(undefined)),
      };
    });
    const { service, queue } = makeService({ forkChatFileCopy });

    const fork = service.forkChat({ sourceChatId: SOURCE_CHAT_ID, chatId: TARGET_CHAT_ID });
    await forkStarted;
    const submit = service.submitRun({
      chatId: SOURCE_CHAT_ID,
      command: 'continue',
      clientRequestId: 'req-after-fork',
      clientMessageId: 'msg-after-fork',
    });
    await Promise.resolve();

    expect(queue.registerPendingUserInput).not.toHaveBeenCalled();
    releaseFork();
    await Promise.all([fork, submit]);
    expect(queue.registerPendingUserInput).toHaveBeenCalledTimes(1);
  });

  it('deletes chats through the mutation service cleanup path', async () => {
    const { service, ownership, queue, settings, pendingInputs, sessions } = makeService();

    const result = await service.deleteChat({ chatId: SOURCE_CHAT_ID });

    expect(result).toEqual({ success: true, chatId: SOURCE_CHAT_ID });
    expect(queue.abortForChatDeletion).toHaveBeenCalledWith(SOURCE_CHAT_ID);
    expect(pendingInputs.clearChat).toHaveBeenCalledWith(SOURCE_CHAT_ID, 'chat-removed');
    expect(ownership.delete).toHaveBeenCalledWith(SOURCE_CHAT_ID);
    expect(queue.deleteChatQueueFile).toHaveBeenCalledWith(SOURCE_CHAT_ID);
    expect(settings.removeFromAllOrderLists).toHaveBeenCalledWith(SOURCE_CHAT_ID);
    expect(settings.removeSessionName).toHaveBeenCalledWith(SOURCE_CHAT_ID);
    expect(sessions.has(SOURCE_CHAT_ID)).toBe(false);
  });

  it('keeps deleted-chat receipts private until the ordered removal event', async () => {
    const { service, ledger } = makeService();
    await ledger.accept({
      commandType: 'agent-run',
      chatId: SOURCE_CHAT_ID,
      clientRequestId: 'req-delete-receipt',
      turnId: 'turn-delete-receipt',
      payload: { command: 'working' },
    });

    await service.deleteChat({ chatId: SOURCE_CHAT_ID });

    const record = await ledger.getTurnRecord(SOURCE_CHAT_ID, 'turn-delete-receipt');
    expect(record.status).toBe('accepted');
    expect(record.publicTerminalAt).toBeUndefined();
  });

  it('keeps a failed admission private when deletion commits before its retry', async () => {
    const { service, chats, ledger, queue } = makeService();
    const input = {
      chatId: SOURCE_CHAT_ID,
      command: 'continue after deletion',
      clientRequestId: 'req-delete-private-failure',
      clientMessageId: 'msg-delete-private-failure',
      tagsToAdd: ['cli'],
    };
    queue.registerPendingUserInput.mockRejectedValueOnce(new Error('append failed'));

    await expect(service.submitRun(input)).rejects.toThrow('append failed');
    await service.deleteChat({ chatId: SOURCE_CHAT_ID });
    await ledger.markChatInterrupted(SOURCE_CHAT_ID, 'chat-deleted');

    await expect(service.submitRun(input)).rejects.toMatchObject({
      code: 'SESSION_NOT_FOUND',
      status: 404,
    });
    const record = await ledger.getRecord(
      commandLedgerKey('agent-run', SOURCE_CHAT_ID, input.clientRequestId),
    );
    expect(record).toMatchObject({
      status: 'failed',
      errorCode: 'PRE_SCHEDULE_FAILED',
      retainedPrivateTerminal: true,
    });
    expect(record.publicTerminalAt).toBeUndefined();
    expect(chats.addTags).not.toHaveBeenCalled();
    expect(queue.registerPendingUserInput).toHaveBeenCalledTimes(1);
    expect(queue.runReservedTurn).not.toHaveBeenCalled();
  });

  it('retries a failed admission normally when chat deletion rolls back', async () => {
    const { service, chats, ledger, ownership, queue } = makeService({
      ownership: {
        delete: mock(async () => {
          throw new Error('journal append failed');
        }),
      },
    });
    const input = {
      chatId: SOURCE_CHAT_ID,
      command: 'continue after rollback',
      clientRequestId: 'req-rollback-private-failure',
      clientMessageId: 'msg-rollback-private-failure',
      tagsToAdd: ['cli'],
    };
    queue.registerPendingUserInput
      .mockRejectedValueOnce(new Error('append failed'))
      .mockResolvedValueOnce(undefined);

    await expect(service.submitRun(input)).rejects.toThrow('append failed');
    await expect(service.deleteChat({ chatId: SOURCE_CHAT_ID })).rejects.toThrow(
      'journal append failed',
    );
    const retry = await service.submitRun(input);

    expect(retry.status).toBe('accepted');
    expect(ownership.delete).toHaveBeenCalledWith(SOURCE_CHAT_ID);
    expect(chats.addTags).toHaveBeenCalledTimes(1);
    expect(chats.addTags).toHaveBeenCalledWith(SOURCE_CHAT_ID, ['cli']);
    expect(queue.registerPendingUserInput).toHaveBeenCalledTimes(2);
    expect(queue.runReservedTurn).toHaveBeenCalledTimes(1);
    expect((await ledger.getRecord(
      commandLedgerKey('agent-run', SOURCE_CHAT_ID, input.clientRequestId),
    )).publicTerminalAt).toBeUndefined();
  });

  it('preserves chat ownership when the active runtime cannot be retired', async () => {
    const { service, chats, queue, settings, pendingInputs, sessions } = makeService({
      queue: { abortForChatDeletion: mock(() => Promise.resolve(false)) },
    });

    await expect(service.deleteChat({ chatId: SOURCE_CHAT_ID })).rejects.toMatchObject({
      code: 'SESSION_BUSY',
      status: 409,
      retryable: true,
    });

    expect(pendingInputs.clearChat).not.toHaveBeenCalled();
    expect(chats.removeChat).not.toHaveBeenCalled();
    expect(queue.deleteChatQueueFile).not.toHaveBeenCalled();
    expect(settings.removeFromAllOrderLists).not.toHaveBeenCalled();
    expect(sessions.has(SOURCE_CHAT_ID)).toBe(true);
  });

  it('preserves chat ownership when runtime retirement throws', async () => {
    const { service, chats, queue, pendingInputs, sessions } = makeService({
      queue: { abortForChatDeletion: mock(() => Promise.reject(new Error('abort failed'))) },
    });

    await expect(service.deleteChat({ chatId: SOURCE_CHAT_ID })).rejects.toMatchObject({
      code: 'SESSION_BUSY',
      status: 409,
      retryable: true,
    });

    expect(pendingInputs.clearChat).not.toHaveBeenCalled();
    expect(chats.removeChat).not.toHaveBeenCalled();
    expect(queue.deleteChatQueueFile).not.toHaveBeenCalled();
    expect(sessions.has(SOURCE_CHAT_ID)).toBe(true);
  });

  it('rolls back deletion settlement when ownership removal fails before commit', async () => {
    const retirement = deferred();
    const retirementStarted = deferred();
    const { service, ledger, queue, sessions } = makeService({
      queue: {
        abortForChatDeletion: mock(() => {
          retirementStarted.resolve();
          return retirement.promise;
        }),
      },
      ownership: {
        delete: mock(async () => {
          throw new Error('journal append failed');
        }),
      },
    });
    await ledger.accept({
      commandType: 'agent-run',
      chatId: SOURCE_CHAT_ID,
      clientRequestId: 'req-delete-failed',
      turnId: 'turn-delete-failed',
      payload: { command: 'working' },
    });

    const deletion = service.deleteChat({ chatId: SOURCE_CHAT_ID });
    await retirementStarted.promise;
    await ledger.markPublicTerminal(
      SOURCE_CHAT_ID,
      'turn-delete-failed',
      'chat-deleted',
    );
    retirement.resolve(true);

    await expect(deletion).rejects.toThrow('journal append failed');
    expect(queue.rollbackChatDeletion).toHaveBeenCalledWith(SOURCE_CHAT_ID);
    expect(sessions.has(SOURCE_CHAT_ID)).toBe(true);
    expect(projectAgentTurnReceipt(
      await ledger.getTurnRecord(SOURCE_CHAT_ID, 'turn-delete-failed'),
    )).toMatchObject({
      receipt: { state: 'interrupted', reason: 'user-stop' },
    });
  });

  it('rejects deleting unknown chats', async () => {
    const { service, queue } = makeService();

    await expect(service.deleteChat({ chatId: 'missing' })).rejects.toMatchObject({
      code: 'SESSION_NOT_FOUND',
      status: 404,
    });
    expect(queue.abortForChatDeletion).not.toHaveBeenCalled();
  });

  it('rejects malformed message-point fork sequence values at the request boundary', async () => {
    const { forkChatFileCopy } = makeService();

    expect(() =>
      parseForkChatCommandRequest({
        sourceChatId: SOURCE_CHAT_ID,
        chatId: TARGET_CHAT_ID,
        upToSeq: '2abc',
      }),
    ).toThrow('upToSeq must be a positive integer');

    expect(forkChatFileCopy).not.toHaveBeenCalled();
  });

  it('parses a fork point generation and rejects an empty generation', () => {
    expect(parseForkChatCommandRequest({
      sourceChatId: SOURCE_CHAT_ID,
      chatId: TARGET_CHAT_ID,
      upToSeq: 2,
      generationId: 'generation-1',
    })).toEqual({
      sourceChatId: SOURCE_CHAT_ID,
      chatId: TARGET_CHAT_ID,
      upToSeq: 2,
      generationId: 'generation-1',
    });
    expect(() => parseForkChatCommandRequest({
      sourceChatId: SOURCE_CHAT_ID,
      chatId: TARGET_CHAT_ID,
      upToSeq: 2,
      generationId: ' ',
    })).toThrow('generationId must not be empty');
    expect(() => parseForkChatCommandRequest({
      sourceChatId: SOURCE_CHAT_ID,
      chatId: TARGET_CHAT_ID,
      generationId: 'generation-1',
    })).toThrow('generationId requires upToSeq');
  });

  it('rejects message-point forks when the agent does not support them', async () => {
    const nativeMessages = {
      loadNativeMessages: mock(() => Promise.resolve([])),
    };
    const { service, agents, forkChatFileCopy } = makeService({
      nativeMessages,
    });
    agents.supportsForkAtMessage.mockReturnValue(false);

    await expect(
      service.forkChat({
        sourceChatId: SOURCE_CHAT_ID,
        chatId: TARGET_CHAT_ID,
        upToSeq: 1,
      }),
    ).rejects.toMatchObject({
      code: 'UNSUPPORTED_AGENT',
      status: 422,
    });

    expect(nativeMessages.loadNativeMessages).not.toHaveBeenCalled();
    expect(forkChatFileCopy).not.toHaveBeenCalled();
  });

  it('rejects a whole-head fork while the source is running without running-fork support', async () => {
    const { service, agents, forkChatFileCopy } = makeService();
    agents.isAgentSessionRunning.mockReturnValue(true);
    agents.supportsForkWhileRunning.mockReturnValue(false);

    await expect(service.forkChat({
      sourceChatId: SOURCE_CHAT_ID,
      chatId: TARGET_CHAT_ID,
    })).rejects.toMatchObject({ code: 'SESSION_BUSY', status: 409, retryable: true });

    expect(forkChatFileCopy).not.toHaveBeenCalled();
  });

  it('copies the transcript for a whole-head fork while the source is running', async () => {
    const { service, agents, queue, forkChatFileCopy } = makeService();
    queue.ownsExecution.mockReturnValue(true);
    agents.isAgentSessionRunning.mockReturnValue(true);
    agents.supportsForkWhileRunning.mockReturnValue(true);

    await service.forkChat({ sourceChatId: SOURCE_CHAT_ID, chatId: TARGET_CHAT_ID });

    expect(forkChatFileCopy).toHaveBeenCalledWith(
      expect.objectContaining({ sourceChatId: SOURCE_CHAT_ID, targetChatId: TARGET_CHAT_ID }),
    );
  });

  it('rejects a whole-head fork while the source session is materializing', async () => {
    const { service, queue, forkChatFileCopy } = makeService({
      session: { agentSessionId: null, nativeSession: null },
    });
    queue.ownsExecution.mockReturnValue(true);

    await expect(service.forkChat({
      sourceChatId: SOURCE_CHAT_ID,
      chatId: TARGET_CHAT_ID,
    })).rejects.toMatchObject({ code: 'SESSION_BUSY', status: 409, retryable: true });

    expect(forkChatFileCopy).not.toHaveBeenCalled();
  });

  it('rejects a fork point that only exists on the event stream', async () => {
    const { service, agents, chatViews, queue, forkChatFileCopy } = makeService();
    queue.ownsExecution.mockReturnValue(true);
    agents.isAgentSessionRunning.mockReturnValue(true);
    agents.supportsForkWhileRunning.mockReturnValue(true);
    chatViews.getNativeHistoryLastSeq.mockReturnValue(2);

    await expect(service.forkChat({
      sourceChatId: SOURCE_CHAT_ID,
      chatId: TARGET_CHAT_ID,
      upToSeq: 3,
    })).rejects.toMatchObject({
      code: 'MESSAGE_NOT_IN_NATIVE_HISTORY',
      message: "This message hasn't been written to the provider's transcript yet. It becomes forkable once the turn finishes.",
      status: 409,
      retryable: true,
    });

    expect(forkChatFileCopy).not.toHaveBeenCalled();
  });

  it('reconciles an idle source before resolving its fork point', async () => {
    const { service, chatViews, idleReconciler, forkChatFileCopy } = makeService();
    chatViews.getNativeHistoryLastSeq.mockReturnValue(0);
    // Reconciling is what makes an idle view address native positions, so the guard runs against
    // the rebuilt boundary rather than the stale one.
    idleReconciler.ensureReconciled.mockImplementation(async () => {
      chatViews.getNativeHistoryLastSeq.mockReturnValue(2);
    });

    await service.forkChat({
      sourceChatId: SOURCE_CHAT_ID,
      chatId: TARGET_CHAT_ID,
      upToSeq: 2,
    });

    expect(idleReconciler.ensureReconciled).toHaveBeenCalledWith(SOURCE_CHAT_ID);
    expect(forkChatFileCopy).toHaveBeenCalledWith(
      expect.objectContaining({ upToSequence: 2 }),
    );
  });

  it('refuses a fork point bound to a stale view generation', async () => {
    const { service, chatViews, idleReconciler, forkChatFileCopy } = makeService();
    chatViews.getNativeHistoryLastSeq.mockReturnValue(2);
    chatViews.getCursor.mockReturnValue({ generationId: 'generation-2', lastSeq: 2 });

    await expect(service.forkChat({
      sourceChatId: SOURCE_CHAT_ID,
      chatId: TARGET_CHAT_ID,
      upToSeq: 2,
      generationId: 'generation-1',
    })).rejects.toMatchObject({
      code: 'STALE_VIEW_GENERATION',
      status: 409,
      retryable: true,
    });

    expect(idleReconciler.ensureReconciled).toHaveBeenCalledWith(SOURCE_CHAT_ID);
    expect(forkChatFileCopy).not.toHaveBeenCalled();
  });

  it('rejects a generation binding without a message cutoff', async () => {
    const { service, forkChatFileCopy } = makeService();

    await expect(service.forkChat({
      sourceChatId: SOURCE_CHAT_ID,
      chatId: TARGET_CHAT_ID,
      generationId: 'generation-1',
    })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      status: 400,
    });

    expect(forkChatFileCopy).not.toHaveBeenCalled();
  });

  it('refuses an idle fork point that native history still does not cover', async () => {
    const { service, chatViews, forkChatFileCopy } = makeService();
    chatViews.getNativeHistoryLastSeq.mockReturnValue(1);

    await expect(service.forkChat({
      sourceChatId: SOURCE_CHAT_ID,
      chatId: TARGET_CHAT_ID,
      upToSeq: 2,
    })).rejects.toMatchObject({
      code: 'MESSAGE_NOT_IN_NATIVE_HISTORY',
      message: "This message hasn't been written to the provider's transcript yet. It becomes forkable once the turn finishes.",
      status: 409,
      retryable: true,
    });

    expect(forkChatFileCopy).not.toHaveBeenCalled();
  });

  it('allows a fork point that native history already covers', async () => {
    const { service, agents, chatViews, queue, forkChatFileCopy } = makeService();
    queue.ownsExecution.mockReturnValue(true);
    agents.isAgentSessionRunning.mockReturnValue(true);
    agents.supportsForkWhileRunning.mockReturnValue(true);
    chatViews.getNativeHistoryLastSeq.mockReturnValue(2);

    await service.forkChat({
      sourceChatId: SOURCE_CHAT_ID,
      chatId: TARGET_CHAT_ID,
      upToSeq: 2,
      generationId: 'generation-1',
    });

    expect(chatViews.getCursor).toHaveBeenCalledWith(SOURCE_CHAT_ID);
    expect(forkChatFileCopy).toHaveBeenCalledWith(
      expect.objectContaining({ upToSequence: 2 }),
    );
  });

  it('passes the canonical message cutoff to the owning integration', async () => {
    const { service, forkChatFileCopy } = makeService();

    await service.forkChat({
      sourceChatId: SOURCE_CHAT_ID,
      chatId: TARGET_CHAT_ID,
      upToSeq: 2,
    });

    expect(forkChatFileCopy).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceChatId: SOURCE_CHAT_ID,
        targetChatId: TARGET_CHAT_ID,
        upToSequence: 2,
      }),
    );
  });

  it('allows message-point forks while the source is processing when the agent supports running forks', async () => {
    const { service, agents, forkChatFileCopy } = makeService();
    agents.isAgentSessionRunning.mockReturnValue(true);
    agents.supportsForkWhileRunning.mockReturnValue(true);

    await service.forkChat({
      sourceChatId: SOURCE_CHAT_ID,
      chatId: TARGET_CHAT_ID,
      upToSeq: 1,
    });

    expect(forkChatFileCopy).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceChatId: SOURCE_CHAT_ID,
        targetChatId: TARGET_CHAT_ID,
        upToSequence: 1,
      }),
    );
  });

  it('forwards structured permission decision responses to agents', async () => {
    const { service, agents, ledger } = makeService();
    const response = { outcome: { outcome: 'accepted' } };

    await service.submitPermissionDecision({
      chatId: SOURCE_CHAT_ID,
      permissionRequestId: 'perm-1',
      allow: true,
      alwaysAllow: false,
      response,
      clientRequestId: 'req-perm-1',
    });

    expect(agents.resolvePermission).toHaveBeenCalledWith(SOURCE_CHAT_ID, 'perm-1', {
      allow: true,
      alwaysAllow: false,
      response,
    });

    const record = await readLedgerRecord(ledger, 'permission-decision', 'req-perm-1');
    expect(record).toMatchObject({ status: 'finished', payload: {} });
  });

  it('routes /compact to the agent compaction dispatch', async () => {
    const { service, agents, chats, queue } = makeService();
    chats.addChat({
      id: SOURCE_CHAT_ID,
      agentId: 'claude',
      agentSessionId: 'agent-1',
    });

    const result = await service.submitCompact({
      chatId: SOURCE_CHAT_ID,
      clientRequestId: 'req-compact-1',
      instructions: 'focus on api',
    });

    expect(result.status).toBe('accepted');
    await service.waitForBackgroundTasks();
    expect(agents.compactSession).toHaveBeenCalledWith(
      SOURCE_CHAT_ID,
      expect.objectContaining({
        instructions: 'focus on api',
        clientRequestId: 'req-compact-1',
      }),
    );
    expect(queue.completeDirectTurn).toHaveBeenCalledTimes(1);
    expect(queue.releaseDirectTurn).not.toHaveBeenCalled();
  });

  it('refuses /compact while a turn is already running', async () => {
    const { service, agents, chats } = makeService();
    chats.addChat({
      id: SOURCE_CHAT_ID,
      agentId: 'claude',
      agentSessionId: 'agent-1',
    });
    agents.isAgentSessionRunning = mock(() => true);

    await expect(
      service.submitCompact({
        chatId: SOURCE_CHAT_ID,
        clientRequestId: 'req-compact-2',
      }),
    ).rejects.toThrow(/Cannot compact while a turn is running/);
    expect(agents.compactSession).not.toHaveBeenCalled();
  });

  it('projects dispatch state separately from a created queue entry', async () => {
    const postCreate = storedQueue([queueEntry('s1', 'in flight', 'sending'), queueEntry('q1', 'still waiting')], {
      version: 7,
    });
    const { service } = makeService({
      queue: {
        createChatQueueEntry: mock(() =>
          Promise.resolve({
            entry: queueEntry('q1', 'still waiting'),
            entryId: 'q1',
            control: postCreate,
            duplicate: false,
          }),
        ),
        triggerDrain: mock(() => Promise.resolve(undefined)),
      },
    });

    const result = await service.submitQueueEntryCreate({
      chatId: SOURCE_CHAT_ID,
      content: 'still waiting',
      clientRequestId: 'req-enqueue-1',
    });

    expect(result.control.queue.entries.map((e) => e.id)).toEqual(['q1']);
    expect(result.control.queue.entries[0]).not.toHaveProperty('status');
    expect(result.control.queue.dispatchingEntryId).toBe('s1');
  });

  it('deduplicates identical queue create retries', async () => {
    const { service, queue } = makeService();
    const input = {
      chatId: SOURCE_CHAT_ID,
      content: 'queued across deploy',
      clientRequestId: 'request-cross-version',
    };

    const first = await service.submitQueueEntryCreate(input);
    const retry = await service.submitQueueEntryCreate(input);

    expect(first.status).toBe('accepted');
    expect(retry.status).toBe('duplicate');
    expect(queue.createChatQueueEntry).toHaveBeenCalledTimes(1);
    expect(queue.triggerDrain).toHaveBeenCalledTimes(1);
  });

  it('recovers an accepted queue create from its in-process queue receipt', async () => {
    const { service, queue, ledger } = makeService();
    const clientRequestId = 'request-ambiguous-retry';
    const entryId = 'prepared-entry-id';
    await ledger.accept({
      commandType: 'queue-entry-create',
      chatId: SOURCE_CHAT_ID,
      clientRequestId,
      payload: { chatId: SOURCE_CHAT_ID, content: 'survives retry' },
      entryId,
    });
    queue.createChatQueueEntry.mockResolvedValueOnce({
      entry: queueEntry(entryId, 'survives retry'),
      entryId,
      control: storedQueue([queueEntry(entryId, 'survives retry')], {
        appliedCommands: [
          {
            key: `queue-entry-create:${SOURCE_CHAT_ID}:${clientRequestId}`,
            operation: 'create',
            entryId,
            appliedAt: '2026-07-16T00:00:00.000Z',
          },
        ],
      }),
      duplicate: true,
    });

    const result = await service.submitQueueEntryCreate({
      chatId: SOURCE_CHAT_ID,
      content: 'survives retry',
      clientRequestId,
    });

    expect(result).toMatchObject({ status: 'duplicate', entryId });
    expect(queue.createChatQueueEntry).toHaveBeenCalledWith(SOURCE_CHAT_ID, 'survives retry', {
      key: `queue-entry-create:${SOURCE_CHAT_ID}:${clientRequestId}`,
      entryId,
    });
    expect(await readLedgerRecord(ledger, 'queue-entry-create', clientRequestId)).toMatchObject({
      status: 'finished',
      entryId,
    });
  });

  it('replaces, deletes, and moves queue entries through explicit ID commands', async () => {
    const { service, queue } = makeService();

    const replaced = await service.submitQueueEntryReplace({
      chatId: SOURCE_CHAT_ID,
      entryId: 'entry-1',
      content: 'replacement',
      expectedRevision: 2,
      clientRequestId: 'request-replace',
    });
    const deleted = await service.submitQueueEntryDelete({
      chatId: SOURCE_CHAT_ID,
      entryId: 'entry-1',
      clientRequestId: 'request-delete',
    });
    const moved = await service.submitQueueEntryMove({
      chatId: SOURCE_CHAT_ID,
      entryId: 'entry-3',
      targetEntryId: 'entry-1',
      placement: 'before',
      expectedReorderRevision: 0,
      expectedSourceRevision: 1,
      expectedTargetRevision: 2,
      clientRequestId: 'request-move',
    });

    expect(replaced.entryId).toBe('entry-1');
    expect(queue.replaceChatQueueEntry).toHaveBeenCalledWith(SOURCE_CHAT_ID, 'entry-1', 'replacement', 2, {
      key: `queue-entry-replace:${SOURCE_CHAT_ID}:request-replace`,
      entryId: 'entry-1',
    });
    expect(deleted.entryId).toBe('entry-1');
    expect(queue.deleteChatQueueEntry).toHaveBeenCalledWith(SOURCE_CHAT_ID, 'entry-1', {
      key: `queue-entry-delete:${SOURCE_CHAT_ID}:request-delete`,
      entryId: 'entry-1',
    });
    expect(moved.entryId).toBe('entry-3');
    expect(queue.moveChatQueueEntry).toHaveBeenCalledWith(
      SOURCE_CHAT_ID,
      {
        entryId: 'entry-3',
        targetEntryId: 'entry-1',
        placement: 'before',
        expectedReorderRevision: 0,
        expectedSourceRevision: 1,
        expectedTargetRevision: 2,
      },
      {
        key: 'queue-entry-move:1783725900000000:request-move',
        entryId: 'entry-3',
      },
    );
  });

  it('replays a settled move without reapplying it and rejects changed move payloads', async () => {
    const { service, queue } = makeService();
    const input = {
      chatId: SOURCE_CHAT_ID,
      entryId: 'entry-3',
      targetEntryId: 'entry-1',
      placement: 'before',
      expectedReorderRevision: 2,
      expectedSourceRevision: 1,
      expectedTargetRevision: 2,
      clientRequestId: 'request-move-retry',
    };

    const accepted = await service.submitQueueEntryMove(input);
    const duplicate = await service.submitQueueEntryMove(input);

    expect(accepted.status).toBe('accepted');
    expect(duplicate.status).toBe('duplicate');
    expect(queue.moveChatQueueEntry).toHaveBeenCalledOnce();
    await expect(service.submitQueueEntryMove({
      ...input,
      targetEntryId: 'entry-2',
    })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(queue.moveChatQueueEntry).toHaveBeenCalledOnce();
  });

  it('replays semantic queue mutation failures without applying them after state changes', async () => {
    const latestQueue = storedQueue([queueEntry('entry-1', 'latest', 'queued', 2)], { version: 3 });
    const replaceFailure = new QueueEntryMutationError(
      'QUEUE_ENTRY_REVISION_CONFLICT',
      'This queued message changed before it could be saved',
      latestQueue,
    );
    const { service, queue, ledger } = makeService({
      queue: {
        readChatExecutionControl: mock(() => Promise.resolve(latestQueue)),
        replaceChatQueueEntry: mock(() => Promise.reject(replaceFailure)),
      },
    });
    const replaceInput = {
      chatId: SOURCE_CHAT_ID,
      entryId: 'entry-1',
      content: 'stale replacement',
      expectedRevision: 1,
      clientRequestId: 'request-rejected-replace',
    };

    await expect(service.submitQueueEntryReplace(replaceInput)).rejects.toMatchObject({
      code: 'QUEUE_ENTRY_REVISION_CONFLICT',
    });
    await expect(service.submitQueueEntryReplace(replaceInput)).rejects.toMatchObject({
      code: 'QUEUE_ENTRY_REVISION_CONFLICT',
      control: expect.objectContaining({ version: 3 }),
    });

    expect(queue.replaceChatQueueEntry).toHaveBeenCalledOnce();
    queue.deleteChatQueueEntry.mockRejectedValue(
      new QueueEntryMutationError(
        'QUEUE_ENTRY_ALREADY_SENT',
        'This queued message has already been sent',
        latestQueue,
      ),
    );
    const deleteInput = {
      chatId: SOURCE_CHAT_ID,
      entryId: 'entry-sent',
      clientRequestId: 'request-rejected-delete',
    };
    await expect(service.submitQueueEntryDelete(deleteInput)).rejects.toMatchObject({
      code: 'QUEUE_ENTRY_ALREADY_SENT',
    });
    await expect(service.submitQueueEntryDelete(deleteInput)).rejects.toMatchObject({
      code: 'QUEUE_ENTRY_ALREADY_SENT',
    });

    expect(queue.deleteChatQueueEntry).toHaveBeenCalledOnce();

    queue.moveChatQueueEntry.mockRejectedValue(
      new QueueEntryMutationError(
        'QUEUE_ENTRY_REORDER_CONFLICT',
        'The queue order changed before the item could be moved',
        latestQueue,
      ),
    );
    const moveInput = {
      chatId: SOURCE_CHAT_ID,
      entryId: 'entry-3',
      targetEntryId: 'entry-1',
      placement: 'before',
      expectedReorderRevision: 0,
      expectedSourceRevision: 1,
      expectedTargetRevision: 2,
      clientRequestId: 'request-rejected-move',
    };
    await expect(service.submitQueueEntryMove(moveInput)).rejects.toMatchObject({
      code: 'QUEUE_ENTRY_REORDER_CONFLICT',
    });
    await expect(service.submitQueueEntryMove(moveInput)).rejects.toMatchObject({
      code: 'QUEUE_ENTRY_REORDER_CONFLICT',
      control: expect.objectContaining({ version: 3 }),
    });
    expect(queue.moveChatQueueEntry).toHaveBeenCalledOnce();

    queue.replaceChatQueueEntry.mockRejectedValue(
      new QueueEntryMutationError(
        'QUEUE_ENTRY_IN_FLIGHT',
        'This queued message is already being steered',
        latestQueue,
      ),
    );
    const inFlightInput = {
      ...replaceInput,
      content: 'blocked replacement',
      clientRequestId: 'request-rejected-in-flight-replace',
    };
    await expect(service.submitQueueEntryReplace(inFlightInput)).rejects.toMatchObject({
      code: 'QUEUE_ENTRY_IN_FLIGHT',
    });
    await expect(service.submitQueueEntryReplace(inFlightInput)).rejects.toMatchObject({
      code: 'QUEUE_ENTRY_IN_FLIGHT',
      control: expect.objectContaining({ version: 3 }),
    });
    expect(queue.replaceChatQueueEntry).toHaveBeenCalledTimes(2);

    expect(await readLedgerRecord(
      ledger,
      'queue-entry-replace',
      replaceInput.clientRequestId,
    )).toMatchObject({ status: 'rejected', errorCode: 'QUEUE_ENTRY_REVISION_CONFLICT' });
    expect(await readLedgerRecord(
      ledger,
      'queue-entry-delete',
      deleteInput.clientRequestId,
    )).toMatchObject({ status: 'rejected', errorCode: 'QUEUE_ENTRY_ALREADY_SENT' });
    expect(await readLedgerRecord(
      ledger,
      'queue-entry-move',
      moveInput.clientRequestId,
    )).toMatchObject({ status: 'rejected', errorCode: 'QUEUE_ENTRY_REORDER_CONFLICT' });
    expect(await readLedgerRecord(
      ledger,
      'queue-entry-replace',
      inFlightInput.clientRequestId,
    )).toMatchObject({ status: 'rejected', errorCode: 'QUEUE_ENTRY_IN_FLIGHT' });
  });

  it('completes handled goal control without exposing a synthetic queue entry', async () => {
    const { service, queue, ledger } = makeService({
      queue: {
        readChatExecutionControl: mock(() => Promise.resolve(storedQueue([], { version: 4 }))),
        deliverGoalControlInput: mock(async (_chatId, _content, _options, afterPendingRegistered) => {
          await afterPendingRegistered();
          return true;
        }),
      },
    });

    const result = await service.submitGoalControl({
      chatId: SOURCE_CHAT_ID,
      content: '/goal pause',
      clientRequestId: 'request-active',
    });

    expect(result.status).toBe('accepted');
    expect(result.delivery).toBe('active');
    expect(result.control.queue.entries).toEqual([]);
    expect(result.entryId).toBeUndefined();
    expect(queue.triggerDrain).not.toHaveBeenCalled();
    expect(queue.deliverGoalControlInput).toHaveBeenCalledWith(
      SOURCE_CHAT_ID,
      '/goal pause',
      expect.objectContaining({ clientRequestId: 'request-active' }),
      expect.any(Function),
    );
    expect(await readLedgerRecord(ledger, 'goal-control', 'request-active')).toMatchObject({
      status: 'finished',
    });
  });

  it('delivers strict steering once under the captured active turn identity', async () => {
    const target = {
      attempt: {},
      identity: { clientRequestId: 'request-active', turnId: 'turn-active' },
    };
    const { service, queue, ledger } = makeService({
      queue: { captureSteerTarget: mock(() => target) },
    });
    const input = {
      chatId: SOURCE_CHAT_ID,
      content: 'focus on the failing test',
      clientRequestId: 'request-steer',
      clientMessageId: 'message-steer',
    };

    await expect(service.submitSteer(input)).resolves.toMatchObject({
      commandType: 'steer',
      status: 'accepted',
      turnId: 'turn-active',
    });
    await expect(service.submitSteer(input)).resolves.toMatchObject({
      commandType: 'steer',
      status: 'duplicate',
      turnId: 'turn-active',
    });

    expect(queue.captureSteerTarget).toHaveBeenCalledTimes(2);
    expect(queue.deliverAcceptedSteer).toHaveBeenCalledTimes(1);
    expect(queue.readChatExecutionControl).not.toHaveBeenCalled();
    expect(queue.createChatQueueEntry).not.toHaveBeenCalled();
    expect(await readLedgerRecord(ledger, 'steer', input.clientRequestId)).toMatchObject({
      status: 'finished',
      turnId: 'turn-active',
      entryId: undefined,
    });
  });

  it('steers the authoritative queue head once and replays its terminal result', async () => {
    const target = {
      attempt: {},
      identity: { clientRequestId: 'request-active', turnId: 'turn-active' },
    };
    const queued = storedQueue([
      queueEntry('entry-head', 'authoritative @notes.txt', 'queued', 3),
      queueEntry('entry-next', 'later turn', 'queued', 1),
    ], { reorderRevision: 7, version: 4 });
    const consumed = storedQueue([
      queueEntry('entry-next', 'later turn', 'queued', 1),
    ], {
      reorderRevision: 7,
      version: 6,
      recentlyDispatched: [{
        entryId: 'entry-head',
        revision: 3,
        dispatchedAt: '2026-08-02T00:00:01.000Z',
      }],
    });
    let currentControl = queued;
    const { service, queue, ledger, fileMentions } = makeService({
      fileMentions: {
        resolve: mock(async (content, projectPath) => {
          expect(content).toBe('authoritative @notes.txt');
          expect(projectPath).toBe('/repo');
          return 'authoritative content\n\nresolved context';
        }),
      },
      queue: {
        captureSteerTarget: mock(() => target),
        readChatExecutionControl: mock(async () => currentControl),
        deliverAcceptedQueueEntrySteer: mock(async (accepted) => {
          expect(accepted).toMatchObject({
            content: 'authoritative @notes.txt',
            providerContent: 'authoritative content\n\nresolved context',
            clientMessageId: 'message-queue-steer',
            expectedRevision: 3,
            expectedReorderRevision: 7,
            target,
          });
          await accepted.settlement.markScheduled(accepted.command, target.identity.turnId);
          currentControl = consumed;
          await accepted.settlement.settleSteerSuccess(accepted.command, target.identity.turnId);
          return { turnId: target.identity.turnId, control: consumed };
        }),
      },
    });
    const input = {
      chatId: SOURCE_CHAT_ID,
      clientRequestId: 'request-queue-steer',
      clientMessageId: 'message-queue-steer',
      entryId: 'entry-head',
      expectedRevision: 3,
      expectedReorderRevision: 7,
    };

    await expect(service.submitQueueEntrySteer(input)).resolves.toMatchObject({
      commandType: 'steer',
      status: 'accepted',
      turnId: 'turn-active',
      control: { queue: { entries: [{ id: 'entry-next' }], steeringEntryId: null } },
    });
    await expect(service.submitQueueEntrySteer(input)).resolves.toMatchObject({
      commandType: 'steer',
      status: 'duplicate',
      turnId: 'turn-active',
      control: { queue: { entries: [{ id: 'entry-next' }], steeringEntryId: null } },
    });

    expect(queue.deliverAcceptedQueueEntrySteer).toHaveBeenCalledTimes(1);
    expect(fileMentions.resolve).toHaveBeenCalledTimes(1);
    expect(await readLedgerRecord(ledger, 'steer', input.clientRequestId)).toMatchObject({
      status: 'finished',
      turnId: 'turn-active',
      entryId: 'entry-head',
    });
  });

  it('serializes Stop behind queued steering acknowledgement without deadlocking', async () => {
    const events = [];
    const deliveryEntered = deferred();
    const releaseDelivery = deferred();
    const target = { attempt: {}, identity: { turnId: 'turn-active' } };
    const queued = storedQueue([
      queueEntry('entry-head', 'authoritative content', 'queued', 1),
    ]);
    const consumed = storedQueue([], {
      version: 2,
      recentlyDispatched: [{
        entryId: 'entry-head',
        revision: 1,
        dispatchedAt: '2026-08-02T00:00:01.000Z',
      }],
    });
    const stopActiveTurn = mock(async () => {
      events.push('stop');
      return { outcome: 'interrupt-requested', control: consumed };
    });
    const { service } = makeService({
      queue: {
        captureSteerTarget: mock(() => target),
        readChatExecutionControl: mock(async () => queued),
        deliverAcceptedQueueEntrySteer: mock(async (accepted) => {
          events.push('steer-entered');
          deliveryEntered.resolve();
          await releaseDelivery.promise;
          await accepted.settlement.markScheduled(accepted.command, target.identity.turnId);
          await accepted.settlement.settleSteerSuccess(accepted.command, target.identity.turnId);
          events.push('steer-finished');
          return { turnId: target.identity.turnId, control: consumed };
        }),
        stopActiveTurn,
      },
    });
    const steering = service.submitQueueEntrySteer({
      chatId: SOURCE_CHAT_ID,
      clientRequestId: 'request-queue-steer-before-stop',
      clientMessageId: 'message-queue-steer-before-stop',
      entryId: 'entry-head',
      expectedRevision: 1,
      expectedReorderRevision: 0,
    });
    await deliveryEntered.promise;

    const stop = service.submitStop({
      chatId: SOURCE_CHAT_ID,
      clientRequestId: 'request-stop-during-queue-steer',
    });
    await Promise.resolve();
    expect(stopActiveTurn).not.toHaveBeenCalled();

    releaseDelivery.resolve();
    await Promise.all([steering, stop]);
    expect(events).toEqual(['steer-entered', 'steer-finished', 'stop']);
  });

  it('rejects a changed queued-steer identity without another native delivery', async () => {
    const target = { attempt: {}, identity: { turnId: 'turn-active' } };
    const queued = storedQueue([
      queueEntry('entry-head', 'authoritative content', 'queued', 3),
    ], { reorderRevision: 7 });
    const { service, queue } = makeService({
      queue: {
        captureSteerTarget: mock(() => target),
        readChatExecutionControl: mock(async () => queued),
      },
    });
    const input = {
      chatId: SOURCE_CHAT_ID,
      clientRequestId: 'request-queue-steer-conflict',
      clientMessageId: 'message-queue-steer-conflict',
      entryId: 'entry-head',
      expectedRevision: 3,
      expectedReorderRevision: 7,
    };

    await expect(service.submitQueueEntrySteer(input)).resolves.toMatchObject({ status: 'accepted' });
    await expect(service.submitQueueEntrySteer({
      ...input,
      expectedRevision: 4,
    })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT', status: 409 });

    expect(queue.deliverAcceptedQueueEntrySteer).toHaveBeenCalledTimes(1);
  });

  it('rejects a missing queued-steer source before provider delivery with current control', async () => {
    const current = storedQueue([
      queueEntry('entry-next', 'later turn', 'queued', 1),
    ], { reorderRevision: 8, version: 5 });
    const target = { attempt: {}, identity: { turnId: 'turn-active' } };
    const { service, queue } = makeService({
      queue: {
        captureSteerTarget: mock(() => target),
        readChatExecutionControl: mock(async () => current),
      },
    });

    await expect(service.submitQueueEntrySteer({
      chatId: SOURCE_CHAT_ID,
      clientRequestId: 'request-queue-steer-missing',
      clientMessageId: 'message-queue-steer-missing',
      entryId: 'entry-gone',
      expectedRevision: 3,
      expectedReorderRevision: 7,
    })).rejects.toMatchObject({
      code: 'QUEUE_ENTRY_NOT_FOUND',
      deliveryOutcome: 'not-sent',
      control: current,
    });

    expect(queue.deliverAcceptedQueueEntrySteer).not.toHaveBeenCalled();
  });

  it('does not mask a queued-steer observation rejection when ledger settlement fails', async () => {
    const ledger = new CommandLedger(workspaceDir);
    ledger.update = mock(async () => {
      throw new Error('ledger unavailable');
    });
    const current = storedQueue([], { reorderRevision: 8, version: 5 });
    const { service, queue } = makeService({
      ledger,
      queue: {
        captureSteerTarget: mock(() => ({ attempt: {}, identity: { turnId: 'turn-active' } })),
        readChatExecutionControl: mock(async () => current),
      },
    });

    await expect(service.submitQueueEntrySteer({
      chatId: SOURCE_CHAT_ID,
      clientRequestId: 'request-queue-steer-settlement-failure',
      clientMessageId: 'message-queue-steer-settlement-failure',
      entryId: 'entry-gone',
      expectedRevision: 3,
      expectedReorderRevision: 7,
    })).rejects.toMatchObject({
      code: 'QUEUE_ENTRY_NOT_FOUND',
      deliveryOutcome: 'not-sent',
      control: current,
    });
    expect(queue.deliverAcceptedQueueEntrySteer).not.toHaveBeenCalled();
  });

  it('returns a typed unknown outcome when stale queued-steer recovery fails', async () => {
    const input = {
      chatId: SOURCE_CHAT_ID,
      clientRequestId: 'request-queue-steer-stale-recovery',
      clientMessageId: 'message-queue-steer-stale-recovery',
      entryId: 'entry-head',
      expectedRevision: 3,
      expectedReorderRevision: 7,
    };
    const ledger = new CommandLedger(workspaceDir);
    await ledger.accept({
      commandType: 'steer',
      chatId: input.chatId,
      clientRequestId: input.clientRequestId,
      entryId: input.entryId,
      payload: {
        chatId: input.chatId,
        clientMessageId: input.clientMessageId,
        source: {
          kind: 'queue-entry',
          entryId: input.entryId,
          expectedRevision: input.expectedRevision,
          expectedReorderRevision: input.expectedReorderRevision,
        },
      },
    });
    const current = storedQueue([
      queueEntry('entry-head', 'authoritative content', 'queued', 3),
    ], { reorderRevision: 7, version: 5 });
    const recoverQueueEntrySteer = mock(async () => {
      throw new Error('control commit unavailable');
    });
    const { service, queue, pendingInputs } = makeService({
      ledger,
      queue: {
        captureSteerTarget: mock(() => ({ attempt: {}, identity: { turnId: 'turn-active' } })),
        readChatExecutionControl: mock(async () => current),
        recoverQueueEntrySteer,
      },
    });

    await expect(service.submitQueueEntrySteer(input)).rejects.toMatchObject({
      code: 'STEER_OUTCOME_UNKNOWN',
      deliveryOutcome: 'unknown',
      control: current,
    });
    await expect(service.submitQueueEntrySteer(input)).rejects.toMatchObject({
      code: 'STEER_OUTCOME_UNKNOWN',
      deliveryOutcome: 'unknown',
      control: current,
    });
    expect(recoverQueueEntrySteer).toHaveBeenCalledTimes(1);
    expect(pendingInputs.markUnconfirmed).toHaveBeenCalledTimes(1);
    expect(queue.deliverAcceptedQueueEntrySteer).not.toHaveBeenCalled();
  });

  it('rejects oversized steering identities before target capture or ledger admission', async () => {
    const { service, queue, ledger } = makeService();
    const clientRequestId = 'x'.repeat(COMMAND_CORRELATION_ID_MAX_BYTES + 1);

    await expect(service.submitSteer({
      chatId: SOURCE_CHAT_ID,
      content: 'focus here',
      clientRequestId,
      clientMessageId: 'message-steer',
    })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      status: 400,
      message: `clientRequestId must be at most ${COMMAND_CORRELATION_ID_MAX_BYTES} bytes`,
    });

    expect(queue.captureSteerTarget).not.toHaveBeenCalled();
    expect(await readLedgerRecord(ledger, 'steer', clientRequestId)).toBeNull();
  });

  it('rejects oversized queued-steer source identities before target capture or ledger admission', async () => {
    const { service, queue, ledger } = makeService();
    const clientRequestId = 'request-queue-steer-oversized-source';

    await expect(service.submitQueueEntrySteer({
      chatId: SOURCE_CHAT_ID,
      clientRequestId,
      clientMessageId: 'message-queue-steer-oversized-source',
      entryId: 'x'.repeat(QUEUE_ENTRY_ID_MAX_BYTES + 1),
      expectedRevision: 1,
      expectedReorderRevision: 0,
    })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      status: 400,
      message: `entryId must be at most ${QUEUE_ENTRY_ID_MAX_BYTES} bytes`,
    });

    expect(queue.captureSteerTarget).not.toHaveBeenCalled();
    expect(await readLedgerRecord(ledger, 'steer', clientRequestId)).toBeNull();
  });

  it('captures the strict steering target before waiting for the chat mutation lock', async () => {
    const lock = new KeyedPromiseLock();
    const entered = deferred();
    const release = deferred();
    const initialTarget = { attempt: {}, identity: { turnId: 'turn-initial' } };
    const replacementTarget = { attempt: {}, identity: { turnId: 'turn-replacement' } };
    let currentTarget = initialTarget;
    const held = lock.runExclusive(`chat:${SOURCE_CHAT_ID}`, async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const { service, queue } = makeService({
      chatMutationLock: lock,
      queue: { captureSteerTarget: mock(() => currentTarget) },
    });

    const steering = service.submitSteer({
      chatId: SOURCE_CHAT_ID,
      content: 'keep the observed turn',
      clientRequestId: 'request-steer-captured',
      clientMessageId: 'message-steer-captured',
    });
    expect(queue.captureSteerTarget).toHaveBeenCalledOnce();
    currentTarget = replacementTarget;
    release.resolve();

    await expect(steering).resolves.toMatchObject({ turnId: 'turn-initial' });
    await held;
    expect(queue.deliverAcceptedSteer).toHaveBeenCalledWith(expect.objectContaining({
      target: initialTarget,
    }));
  });

  it('resolves steering file context without holding the chat mutation lock', async () => {
    const resolutionStarted = deferred();
    const releaseResolution = deferred();
    const lock = new KeyedPromiseLock();
    const target = { attempt: {}, identity: { turnId: 'turn-active' } };
    const fileMentions = {
      resolve: mock(async () => {
        resolutionStarted.resolve();
        await releaseResolution.promise;
        return 'focus here\n\nresolved context';
      }),
    };
    const { service, queue } = makeService({
      chatMutationLock: lock,
      fileMentions,
      queue: { captureSteerTarget: mock(() => target) },
    });

    const steering = service.submitSteer({
      chatId: SOURCE_CHAT_ID,
      content: 'focus @notes.txt',
      clientRequestId: 'request-steer-context',
      clientMessageId: 'message-steer-context',
    });
    await resolutionStarted.promise;

    await expect(service.submitStop({
      chatId: SOURCE_CHAT_ID,
      clientRequestId: 'request-stop-during-context',
    })).resolves.toMatchObject({ status: 'accepted' });
    expect(queue.deliverAcceptedSteer).not.toHaveBeenCalled();

    releaseResolution.resolve();
    await expect(steering).resolves.toMatchObject({ turnId: 'turn-active' });
    expect(queue.deliverAcceptedSteer).toHaveBeenCalledWith(expect.objectContaining({
      content: 'focus @notes.txt',
      providerContent: 'focus here\n\nresolved context',
    }));
  });

  it('keeps the first same-identity steering admission while file preparation is delayed', async () => {
    const resolutionStarted = deferred();
    const releaseResolution = deferred();
    const firstTarget = { attempt: {}, identity: { turnId: 'turn-first' } };
    const secondTarget = { attempt: {}, identity: { turnId: 'turn-second' } };
    let captureCount = 0;
    let resolutionCount = 0;
    const { service, queue, fileMentions } = makeService({
      fileMentions: {
        resolve: mock(async () => {
          resolutionCount += 1;
          if (resolutionCount === 1) {
            resolutionStarted.resolve();
            await releaseResolution.promise;
            return 'expanded-first';
          }
          return 'expanded-second';
        }),
      },
      queue: {
        captureSteerTarget: mock(() => {
          captureCount += 1;
          return captureCount === 1 ? firstTarget : secondTarget;
        }),
      },
    });
    const input = {
      chatId: SOURCE_CHAT_ID,
      content: 'focus @notes.txt',
      clientRequestId: 'request-steer-ordered-duplicate',
      clientMessageId: 'message-steer-ordered-duplicate',
    };

    const first = service.submitSteer(input);
    await resolutionStarted.promise;
    const second = service.submitSteer(input);
    expect(fileMentions.resolve).toHaveBeenCalledTimes(1);

    releaseResolution.resolve();
    await expect(first).resolves.toMatchObject({ status: 'accepted', turnId: 'turn-first' });
    await expect(second).resolves.toMatchObject({ status: 'duplicate', turnId: 'turn-first' });
    expect(queue.deliverAcceptedSteer).toHaveBeenCalledTimes(1);
    expect(queue.deliverAcceptedSteer).toHaveBeenCalledWith(expect.objectContaining({
      providerContent: 'expanded-first',
      target: firstTarget,
    }));
  });

  it('delivers distinct steers in admission order when the first file preparation is delayed', async () => {
    const resolutionStarted = deferred();
    const releaseResolution = deferred();
    const firstDeliveryStarted = deferred();
    const releaseFirstDelivery = deferred();
    const secondResolutionStarted = deferred();
    const target = { attempt: {}, identity: { turnId: 'turn-active' } };
    const deliveries = [];
    const { service, queue, fileMentions } = makeService({
      fileMentions: {
        resolve: mock(async (content) => {
          if (content.startsWith('first')) {
            resolutionStarted.resolve();
            await releaseResolution.promise;
            return 'expanded-first';
          }
          secondResolutionStarted.resolve();
          return 'expanded-second';
        }),
      },
      queue: {
        captureSteerTarget: mock(() => target),
        deliverAcceptedSteer: mock(async (input) => {
          deliveries.push({
            clientRequestId: input.command.clientRequestId,
            providerContent: input.providerContent,
          });
          if (input.command.clientRequestId === 'request-steer-ordered-first') {
            firstDeliveryStarted.resolve();
            await releaseFirstDelivery.promise;
          }
          await input.settlement.markScheduled(input.command, target.identity.turnId);
          await input.settlement.settleSteerSuccess(input.command, target.identity.turnId);
          return { turnId: target.identity.turnId };
        }),
      },
    });

    const first = service.submitSteer({
      chatId: SOURCE_CHAT_ID,
      content: 'first @slow.txt',
      clientRequestId: 'request-steer-ordered-first',
      clientMessageId: 'message-steer-ordered-first',
    });
    await resolutionStarted.promise;
    const second = service.submitSteer({
      chatId: SOURCE_CHAT_ID,
      content: 'second @fast.txt',
      clientRequestId: 'request-steer-ordered-second',
      clientMessageId: 'message-steer-ordered-second',
    });
    expect(fileMentions.resolve).toHaveBeenCalledTimes(1);
    expect(queue.deliverAcceptedSteer).not.toHaveBeenCalled();

    releaseResolution.resolve();
    await firstDeliveryStarted.promise;
    await secondResolutionStarted.promise;
    expect(deliveries).toEqual([{
      clientRequestId: 'request-steer-ordered-first',
      providerContent: 'expanded-first',
    }]);

    releaseFirstDelivery.resolve();
    await expect(first).resolves.toMatchObject({ status: 'accepted' });
    await expect(second).resolves.toMatchObject({ status: 'accepted' });
    expect(deliveries).toEqual([
      {
        clientRequestId: 'request-steer-ordered-first',
        providerContent: 'expanded-first',
      },
      {
        clientRequestId: 'request-steer-ordered-second',
        providerContent: 'expanded-second',
      },
    ]);
  });

  it('bounds stalled steering file preparation and skips additional uncancellable reads', async () => {
    const resolutionStarted = deferred();
    const releaseResolution = deferred();
    const target = { attempt: {}, identity: { turnId: 'turn-active' } };
    const deliveries = [];
    const { service, queue, fileMentions } = makeService({
      fileMentions: {
        resolve: mock(async () => {
          resolutionStarted.resolve();
          await releaseResolution.promise;
          return 'late expanded context';
        }),
      },
      queue: {
        captureSteerTarget: mock(() => target),
        deliverAcceptedSteer: mock(async (input) => {
          deliveries.push({
            clientRequestId: input.command.clientRequestId,
            providerContent: input.providerContent,
          });
          await input.settlement.markScheduled(input.command, target.identity.turnId);
          await input.settlement.settleSteerSuccess(input.command, target.identity.turnId);
          return { turnId: target.identity.turnId };
        }),
      },
    });
    const firstInput = {
      chatId: SOURCE_CHAT_ID,
      content: 'first @stalled.txt',
      clientRequestId: 'request-steer-stalled-first',
      clientMessageId: 'message-steer-stalled-first',
    };

    const first = service.submitSteer(firstInput);
    await resolutionStarted.promise;
    const duplicate = service.submitSteer(firstInput);
    const later = service.submitSteer({
      chatId: SOURCE_CHAT_ID,
      content: 'later without mentions',
      clientRequestId: 'request-steer-after-stall',
      clientMessageId: 'message-steer-after-stall',
    });

    const results = await Promise.all([first, duplicate, later]);
    releaseResolution.resolve();

    expect(results).toEqual([
      expect.objectContaining({ status: 'accepted', turnId: 'turn-active' }),
      expect.objectContaining({ status: 'duplicate', turnId: 'turn-active' }),
      expect.objectContaining({ status: 'accepted', turnId: 'turn-active' }),
    ]);
    expect(fileMentions.resolve).toHaveBeenCalledTimes(1);
    expect(queue.deliverAcceptedSteer).toHaveBeenCalledTimes(2);
    expect(deliveries).toEqual([
      {
        clientRequestId: 'request-steer-stalled-first',
        providerContent: 'first @stalled.txt',
      },
      {
        clientRequestId: 'request-steer-after-stall',
        providerContent: 'later without mentions',
      },
    ]);
  });

  it('records session deletion while steering waits for the chat mutation lock', async () => {
    const lock = new KeyedPromiseLock();
    const entered = deferred();
    const release = deferred();
    const held = lock.runExclusive(`chat:${SOURCE_CHAT_ID}`, async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const target = { attempt: {}, identity: { turnId: 'turn-initial' } };
    const { service, queue, ledger, sessions } = makeService({
      chatMutationLock: lock,
      queue: { captureSteerTarget: mock(() => target) },
    });
    const input = {
      chatId: SOURCE_CHAT_ID,
      content: 'do not steer a deleted chat',
      clientRequestId: 'request-steer-deleted',
      clientMessageId: 'message-steer-deleted',
    };

    const steering = service.submitSteer(input);
    sessions.delete(SOURCE_CHAT_ID);
    release.resolve();

    await expect(steering).rejects.toMatchObject({
      code: 'SESSION_NOT_FOUND',
      status: 404,
    });
    await expect(service.submitSteer(input)).rejects.toMatchObject({
      code: 'SESSION_NOT_FOUND',
      status: 404,
    });
    await held;
    expect(queue.deliverAcceptedSteer).not.toHaveBeenCalled();
    expect(await readLedgerRecord(ledger, 'steer', input.clientRequestId)).toMatchObject({
      status: 'rejected',
      errorCode: 'SESSION_NOT_FOUND',
    });
  });

  it('replays a completed steer identity after its chat is deleted', async () => {
    const target = { attempt: {}, identity: { turnId: 'turn-active' } };
    const { service, queue, sessions } = makeService({
      queue: { captureSteerTarget: mock(() => target) },
    });
    const input = {
      chatId: SOURCE_CHAT_ID,
      content: 'retain this outcome',
      clientRequestId: 'request-steer-retained-after-delete',
      clientMessageId: 'message-steer-retained-after-delete',
    };

    await expect(service.submitSteer(input)).resolves.toMatchObject({
      status: 'accepted',
      turnId: 'turn-active',
    });
    sessions.delete(SOURCE_CHAT_ID);

    await expect(service.submitSteer(input)).resolves.toMatchObject({
      status: 'duplicate',
      turnId: 'turn-active',
    });
    await expect(service.submitSteer({ ...input, content: 'changed content' })).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
      status: 409,
    });
    expect(queue.deliverAcceptedSteer).toHaveBeenCalledTimes(1);
  });

  it('replays an unknown steer outcome after its chat is deleted', async () => {
    const target = { attempt: {}, identity: { turnId: 'turn-active' } };
    const deliveryError = new SteerDeliveryError(new Error('connection closed'), 'unknown');
    const { service, queue, sessions } = makeService({
      queue: {
        captureSteerTarget: mock(() => target),
        deliverAcceptedSteer: mock(async (input) => {
          await input.settlement.markScheduled(input.command, target.identity.turnId);
          await input.settlement.settleSteerFailure(input.command, deliveryError);
          throw deliveryError;
        }),
      },
    });
    const input = {
      chatId: SOURCE_CHAT_ID,
      content: 'retain this ambiguity',
      clientRequestId: 'request-steer-unknown-after-delete',
      clientMessageId: 'message-steer-unknown-after-delete',
    };

    await expect(service.submitSteer(input)).rejects.toMatchObject({
      code: 'STEER_OUTCOME_UNKNOWN',
    });
    sessions.delete(SOURCE_CHAT_ID);

    await expect(service.submitSteer(input)).rejects.toMatchObject({
      code: 'STEER_OUTCOME_UNKNOWN',
    });
    expect(queue.deliverAcceptedSteer).toHaveBeenCalledTimes(1);
  });

  it('replays a compact steering tombstone after its chat is deleted', async () => {
    const ledger = new CommandLedger(workspaceDir);
    const input = {
      chatId: SOURCE_CHAT_ID,
      content: 'retain compact evidence',
      clientRequestId: 'request-steer-compact-after-delete',
      clientMessageId: 'message-steer-compact-after-delete',
    };
    const accepted = await ledger.accept({
      commandType: 'steer',
      chatId: input.chatId,
      clientRequestId: input.clientRequestId,
      payload: {
        chatId: input.chatId,
        content: input.content,
        clientMessageId: input.clientMessageId,
      },
    });
    await ledger.settleTerminal(accepted.record.key, 'finished', { turnId: 'turn-compact' });
    for (let index = 0; index <= LEDGER_RECORD_LIMIT; index += 1) {
      const result = await ledger.accept({
        commandType: 'agent-run',
        chatId: SOURCE_CHAT_ID,
        clientRequestId: `compact-filler-${index}`,
        payload: { index },
      });
      await ledger.settleTerminal(result.record.key, 'finished');
    }
    const { service, queue, sessions } = makeService({ ledger });
    sessions.delete(SOURCE_CHAT_ID);

    await expect(service.submitSteer(input)).resolves.toMatchObject({
      status: 'duplicate',
      turnId: 'turn-compact',
    });
    expect(queue.captureSteerTarget).not.toHaveBeenCalled();
    expect(queue.deliverAcceptedSteer).not.toHaveBeenCalled();
  });

  it('settles a missing steer target terminally without queue fallback', async () => {
    const { service, queue, ledger } = makeService();
    const input = {
      chatId: SOURCE_CHAT_ID,
      content: 'too late',
      clientRequestId: 'request-steer-missing',
      clientMessageId: 'message-steer-missing',
    };

    await expect(service.submitSteer(input)).rejects.toMatchObject({
      code: 'STEER_TURN_UNAVAILABLE',
      status: 409,
    });
    await expect(service.submitSteer(input)).rejects.toMatchObject({
      code: 'STEER_TURN_UNAVAILABLE',
      status: 409,
    });

    expect(queue.deliverAcceptedSteer).not.toHaveBeenCalled();
    expect(queue.createChatQueueEntry).not.toHaveBeenCalled();
    expect(await readLedgerRecord(ledger, 'steer', input.clientRequestId)).toMatchObject({
      status: 'rejected',
      errorCode: 'STEER_TURN_UNAVAILABLE',
    });
  });

  it('rejects new steer identities after the process-lifetime capacity is exhausted', async () => {
    const ledger = new CommandLedger(workspaceDir, { steerIdentityLimit: 1 });
    const retained = await ledger.accept({
      commandType: 'steer',
      chatId: SOURCE_CHAT_ID,
      clientRequestId: 'request-steer-retained',
      payload: {
        chatId: SOURCE_CHAT_ID,
        content: 'retained',
        clientMessageId: 'message-steer-retained',
      },
    });
    await ledger.settleTerminal(retained.record.key, 'finished', { turnId: 'turn-retained' });
    const { service, queue } = makeService({ ledger });

    await expect(service.submitSteer({
      chatId: SOURCE_CHAT_ID,
      content: 'new steer',
      clientRequestId: 'request-steer-capacity',
      clientMessageId: 'message-steer-capacity',
    })).rejects.toMatchObject({
      code: 'STEER_CAPACITY_EXHAUSTED',
      status: 503,
      retryable: false,
    });
    expect(queue.deliverAcceptedSteer).not.toHaveBeenCalled();
    expect(await ledger.accept({
      commandType: 'steer',
      chatId: SOURCE_CHAT_ID,
      clientRequestId: 'request-steer-retained',
      payload: {
        chatId: SOURCE_CHAT_ID,
        content: 'retained',
        clientMessageId: 'message-steer-retained',
      },
    })).toMatchObject({ kind: 'duplicate' });
  });

  it('never redelivers a steer whose provider outcome is unknown', async () => {
    const target = { attempt: {}, identity: { turnId: 'turn-active' } };
    const deliveryError = new SteerDeliveryError(new Error('connection closed'), 'unknown');
    const { service, queue, ledger } = makeService({
      queue: {
        captureSteerTarget: mock(() => target),
        deliverAcceptedSteer: mock(async (input) => {
          await input.settlement.markScheduled(input.command, target.identity.turnId);
          await input.settlement.settleSteerFailure(input.command, deliveryError);
          throw deliveryError;
        }),
      },
    });
    const input = {
      chatId: SOURCE_CHAT_ID,
      content: 'deliver once',
      clientRequestId: 'request-steer-unknown',
      clientMessageId: 'message-steer-unknown',
    };

    await expect(service.submitSteer(input)).rejects.toMatchObject({
      code: 'STEER_OUTCOME_UNKNOWN',
      outcome: 'unknown',
    });
    await expect(service.submitSteer(input)).rejects.toMatchObject({
      code: 'STEER_OUTCOME_UNKNOWN',
    });

    expect(queue.deliverAcceptedSteer).toHaveBeenCalledTimes(1);
    expect(await readLedgerRecord(ledger, 'steer', input.clientRequestId)).toMatchObject({
      status: 'failed',
      errorCode: 'STEER_OUTCOME_UNKNOWN',
    });
  });

  it('never redelivers the same steer identity after a definite pre-send failure', async () => {
    const target = { attempt: {}, identity: { turnId: 'turn-active' } };
    const deliveryError = new SteerDeliveryError(new Error('serialization failed'), 'not-sent');
    const { service, queue, ledger } = makeService({
      queue: {
        captureSteerTarget: mock(() => target),
        deliverAcceptedSteer: mock(async (input) => {
          await input.settlement.settleSteerFailure(input.command, deliveryError);
          throw deliveryError;
        }),
      },
    });
    const input = {
      chatId: SOURCE_CHAT_ID,
      content: 'deliver at most once',
      clientRequestId: 'request-steer-not-sent',
      clientMessageId: 'message-steer-not-sent',
    };

    await expect(service.submitSteer(input)).rejects.toMatchObject({
      code: 'STEER_NOT_DELIVERED',
      outcome: 'not-sent',
    });
    await expect(service.submitSteer(input)).rejects.toMatchObject({
      code: 'STEER_NOT_DELIVERED',
    });

    expect(queue.deliverAcceptedSteer).toHaveBeenCalledTimes(1);
    expect(await readLedgerRecord(ledger, 'steer', input.clientRequestId)).toMatchObject({
      status: 'failed',
      errorCode: 'STEER_NOT_DELIVERED',
    });
  });

  it('reopens pre-accept active delivery failures for the same request id', async () => {
    let attempts = 0;
    const { service, queue, ledger } = makeService({
      queue: {
        readChatExecutionControl: mock(() => Promise.resolve(storedQueue())),
        deliverGoalControlInput: mock(async () => {
          attempts += 1;
          if (attempts === 1) throw new GoalControlDeliveryError(new Error('live registration failed'), false);
          return false;
        }),
        createChatQueueEntry: mock(() =>
          Promise.resolve({
            entry: queueEntry('queued-retry', 'retry me'),
            entryId: 'queued-retry',
            control: storedQueue([queueEntry('queued-retry', 'retry me')], {
              version: 1,
            }),
            duplicate: false,
          }),
        ),
      },
    });

    const input = {
      chatId: SOURCE_CHAT_ID,
      content: 'retry me',
      clientRequestId: 'request-retry',
    };
    await expect(service.submitGoalControl(input)).rejects.toMatchObject({
      message: GOAL_CONTROL_NOT_DELIVERED_MESSAGE,
      cause: expect.objectContaining({ message: 'live registration failed' }),
      deliveryAccepted: false,
      retryable: true,
    });
    let record = await readLedgerRecord(ledger, 'goal-control', input.clientRequestId);
    expect(record).toEqual(
      expect.objectContaining({
        status: 'failed',
        errorCode: 'PRE_SCHEDULE_FAILED',
      }),
    );

    await expect(service.submitGoalControl(input)).resolves.toEqual(
      expect.objectContaining({
        status: 'accepted',
        delivery: 'queued',
        entryId: 'queued-retry',
      }),
    );
    record = await readLedgerRecord(ledger, 'goal-control', input.clientRequestId);
    expect(record.status).toBe('finished');
    expect(queue.deliverGoalControlInput).toHaveBeenCalledTimes(2);
    expect(queue.createChatQueueEntry).toHaveBeenCalledOnce();
  });

  it('sends scheduled input immediately when the existing chat is idle', async () => {
    const { service, queue } = makeService();

    const outcome = await service.submitScheduledExistingChat({
      chatId: SOURCE_CHAT_ID,
      command: 'scheduled prompt',
      busyBehavior: 'queue',
      clientRequestId: 'scheduled-prompt-1',
      clientMessageId: 'scheduled-message-1',
    });

    expect(outcome).toEqual({ type: 'sent', chatId: SOURCE_CHAT_ID });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(queue.registerPendingUserInput).toHaveBeenCalledWith(
      SOURCE_CHAT_ID,
      'scheduled prompt',
      expect.objectContaining({
        clientRequestId: 'scheduled-prompt-1',
        clientMessageId: 'scheduled-message-1',
      }),
    );
    expect(queue.createChatQueueEntry).not.toHaveBeenCalled();
  });

  it('strictly queues scheduled input when the existing chat is busy', async () => {
    const { service, queue } = makeService();
    queue.ownsExecution.mockReturnValue(true);

    const outcome = await service.submitScheduledExistingChat({
      chatId: SOURCE_CHAT_ID,
      command: 'scheduled prompt',
      busyBehavior: 'queue',
      clientRequestId: 'scheduled-prompt-2',
      clientMessageId: 'scheduled-message-2',
    });

    expect(outcome).toEqual({
      type: 'queued',
      chatId: SOURCE_CHAT_ID,
      entryId: 'entry-1',
    });
    expect(queue.createChatQueueEntry).toHaveBeenCalledWith(
      SOURCE_CHAT_ID,
      'scheduled prompt',
      expect.objectContaining({
        key: `queue-entry-create:${SOURCE_CHAT_ID}:scheduled-prompt-2`,
      }),
    );
    expect(queue.registerPendingUserInput).not.toHaveBeenCalled();
  });

  it('queues scheduled input while a direct turn is still preparing', async () => {
    // Pins the settlement window: a turn that owns execution without a running provider
    // session still queues scheduled input rather than starting a direct turn.
    const { service, queue } = makeService({
      queue: { ownsExecution: mock(() => true) },
    });

    const outcome = await service.submitScheduledExistingChat({
      chatId: SOURCE_CHAT_ID,
      command: 'scheduled during preparation',
      busyBehavior: 'queue',
      clientRequestId: 'scheduled-during-reservation',
      clientMessageId: 'scheduled-message-during-reservation',
    });

    expect(outcome).toMatchObject({ type: 'queued', chatId: SOURCE_CHAT_ID });
    expect(queue.createChatQueueEntry).toHaveBeenCalledTimes(1);
    expect(queue.reserveDirectTurn).not.toHaveBeenCalled();
  });

  it('queues scheduled input behind a dispatching queue head', async () => {
    const { service, queue } = makeService({
      queue: {
        readChatExecutionControl: mock(() =>
          Promise.resolve(storedQueue([queueEntry('entry-sending', 'in flight', 'sending')], { version: 2 })),
        ),
      },
    });

    const outcome = await service.submitScheduledExistingChat({
      chatId: SOURCE_CHAT_ID,
      command: 'scheduled second',
      busyBehavior: 'queue',
      clientRequestId: 'scheduled-after-sending',
      clientMessageId: 'scheduled-message-after-sending',
    });

    expect(outcome.type).toBe('queued');
    expect(queue.createChatQueueEntry).toHaveBeenCalledWith(
      SOURCE_CHAT_ID,
      'scheduled second',
      expect.any(Object),
    );
    expect(queue.registerPendingUserInput).not.toHaveBeenCalled();
  });

  it('skips scheduled input without queue side effects when configured', async () => {
    const { service, queue } = makeService();
    queue.ownsExecution.mockReturnValue(true);

    const outcome = await service.submitScheduledExistingChat({
      chatId: SOURCE_CHAT_ID,
      command: 'scheduled prompt',
      busyBehavior: 'skip',
      clientRequestId: 'scheduled-prompt-3',
      clientMessageId: 'scheduled-message-3',
    });

    expect(outcome).toEqual({ type: 'skipped-busy', chatId: SOURCE_CHAT_ID });
    expect(queue.createChatQueueEntry).not.toHaveBeenCalled();
    expect(queue.registerPendingUserInput).not.toHaveBeenCalled();
  });

  it('requeues an ambiguous active delivery exactly once on retry', async () => {
    const { service, queue, ledger } = makeService({
      queue: {
        readChatExecutionControl: mock(() => Promise.resolve(storedQueue())),
        deliverGoalControlInput: mock(async (_chatId, _content, _options, afterPendingRegistered) => {
          await afterPendingRegistered();
          throw new GoalControlDeliveryError(new Error('live steer failed after acceptance'), true);
        }),
      },
    });
    const input = {
      chatId: SOURCE_CHAT_ID,
      content: 'deliver once',
      clientRequestId: 'request-accepted',
    };

    await expect(service.submitGoalControl(input)).rejects.toMatchObject({
      message: GOAL_CONTROL_OUTCOME_UNKNOWN_MESSAGE,
      cause: expect.objectContaining({
        message: 'live steer failed after acceptance',
      }),
      deliveryAccepted: true,
      retryable: false,
    });
    let record = await readLedgerRecord(ledger, 'goal-control', input.clientRequestId);
    expect(record).toEqual(
      expect.objectContaining({
        status: 'accepted',
        error: GOAL_CONTROL_OUTCOME_UNKNOWN_MESSAGE,
      }),
    );
    expect(record.errorCode).toBe('GOAL_CONTROL_OUTCOME_UNKNOWN');

    const recovered = await service.submitGoalControl(input);
    expect(recovered).toMatchObject({
      status: 'duplicate',
      delivery: 'queued',
      entryId: record.entryId,
      control: {
        queue: {
          entries: [expect.objectContaining({ id: record.entryId, content: 'deliver once' })],
          dispatchingEntryId: null,
        },
      },
    });
    record = await readLedgerRecord(ledger, 'goal-control', input.clientRequestId);
    expect(record).toMatchObject({ status: 'finished', entryId: recovered.entryId });
    expect(queue.deliverGoalControlInput).toHaveBeenCalledTimes(1);
    expect(queue.triggerDrain).toHaveBeenCalledTimes(1);
  });

  it('recovers an ambiguous active delivery through the real execution control transitions', async () => {
    const pendingInputsService = new PendingUserInputService({
      loadNativeMessages: mock(async () => []),
      getRetainedHistoryMessages: mock(() => []),
    });
    const submitGoalControl = mock(async (_chatId, _content, _options, beforeDelivery) => {
      await beforeDelivery(runtimeHandoff());
      throw new Error('connection closed after provider acceptance');
    });
    const queueService = makeRealQueue(pendingInputsService, {
      isChatRunning: mock(() => true),
      submitGoalControl,
    });
    const { service, ledger } = makeService({
      queueService,
      pendingInputsService,
    });
    const input = {
      chatId: SOURCE_CHAT_ID,
      content: 'recover through control state',
      clientRequestId: 'request-real-active-recovery',
    };

    await expect(service.submitGoalControl(input)).rejects.toMatchObject({
      deliveryAccepted: true,
      message: GOAL_CONTROL_OUTCOME_UNKNOWN_MESSAGE,
    });
    const uncertain = await queueService.readChatExecutionControl(SOURCE_CHAT_ID);
    expect(uncertain.entries).toHaveLength(1);
    expect(uncertain.entries[0]).toMatchObject({
      content: input.content,
      status: 'sending',
      delivery: {
        clientRequestId: input.clientRequestId,
        clientMessageId: uncertain.entries[0].id,
      },
    });
    expect(uncertain.appliedCommands).toContainEqual(expect.objectContaining({
      operation: 'create',
      entryId: uncertain.entries[0].id,
    }));

    const recovered = await service.submitGoalControl(input);
    expect(recovered).toMatchObject({
      status: 'duplicate',
      delivery: 'queued',
      entryId: uncertain.entries[0].id,
      control: {
        queue: {
          entries: [expect.objectContaining({
            id: uncertain.entries[0].id,
            content: input.content,
          })],
          dispatchingEntryId: null,
        },
      },
    });
    expect(submitGoalControl).toHaveBeenCalledTimes(1);
    expect(await readLedgerRecord(ledger, 'goal-control', input.clientRequestId)).toMatchObject({
      status: 'finished',
      entryId: uncertain.entries[0].id,
    });

    const repeated = await service.submitGoalControl(input);
    expect(repeated).toMatchObject({
      status: 'duplicate',
      delivery: 'queued',
      entryId: uncertain.entries[0].id,
    });
    expect((await queueService.readChatExecutionControl(SOURCE_CHAT_ID)).entries).toHaveLength(1);
    expect(submitGoalControl).toHaveBeenCalledTimes(1);
  });

  it('does not report an incomplete goal-control ledger record as delivered', async () => {
    const { service, queue, ledger } = makeService();
    await ledger.accept({
      commandType: 'goal-control',
      chatId: SOURCE_CHAT_ID,
      clientRequestId: 'request-active-incomplete',
      payload: { chatId: SOURCE_CHAT_ID, content: 'uncertain delivery' },
      entryId: 'prepared-fallback-id',
    });

    await expect(
      service.submitGoalControl({
        chatId: SOURCE_CHAT_ID,
        content: 'uncertain delivery',
        clientRequestId: 'request-active-incomplete',
      }),
    ).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      status: 409,
      retryable: false,
    });

    expect(queue.deliverGoalControlInput).not.toHaveBeenCalled();
    expect(queue.createChatQueueEntry).not.toHaveBeenCalled();
  });

  it('projects an in-flight entry from clear responses without deleting it', async () => {
    const afterClear = storedQueue([queueEntry('s1', 'in flight', 'sending')], {
      version: 9,
    });
    const { service } = makeService({
      queue: {
        clearChatQueue: mock(() => Promise.resolve(afterClear)),
      },
    });

    const result = await service.mutateQueue({
      chatId: SOURCE_CHAT_ID,
      action: 'clear',
    });

    expect(result.control.queue.entries).toEqual([]);
    expect(result.control.queue.dispatchingEntryId).toBe('s1');
  });

  it('resumes only the named pause and schedules drain after the mutation succeeds', async () => {
    const { service, queue } = makeService();

    const result = await service.mutateQueue({
      chatId: SOURCE_CHAT_ID,
      action: 'resume',
      pauseId: 'pause-current',
    });

    expect(result.success).toBe(true);
    expect(queue.resumeChatQueue).toHaveBeenCalledWith(SOURCE_CHAT_ID, 'pause-current');
  });

  it('rejects resume without a pause ID before mutating the queue', async () => {
    const { service, queue } = makeService();

    await expect(service.mutateQueue({
      chatId: SOURCE_CHAT_ID,
      action: 'resume',
    })).rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 400 });

    expect(queue.resumeChatQueue).not.toHaveBeenCalled();
    expect(queue.triggerDrain).not.toHaveBeenCalled();
  });

  it('updates the project path only after the chat is idle and the agent is prepared', async () => {
    const { service, chats, agents, sessions } = makeService();
    const nextPath = path.join(projectBaseDir, 'repo-worktree');
    await fs.mkdir(nextPath, { recursive: true });
    const realNextPath = await fs.realpath(nextPath);

    const result = await service.updateProjectPath({
      chatId: SOURCE_CHAT_ID,
      projectPath: nextPath,
    });

    expect(result).toEqual({
      success: true,
      chatId: SOURCE_CHAT_ID,
      projectPath: realNextPath,
      effectiveProjectKey: realNextPath,
      previousProjectPath: '/repo',
      previousEffectiveProjectKey: '/repo',
    });
    expect(agents.prepareProjectPathUpdate).toHaveBeenCalledWith(
      'claude',
      expect.objectContaining({
        chatId: SOURCE_CHAT_ID,
        agentSessionId: 'agent-1',
        previousProjectPath: '/repo',
        nextProjectPath: realNextPath,
        nativeSession: expect.objectContaining({ ownerId: 'claude' }),
      }),
    );
    expect(chats.updateProjectPath).toHaveBeenCalledWith(
      SOURCE_CHAT_ID,
      expect.objectContaining({
        projectPath: realNextPath,
        effectiveProjectKey: realNextPath,
        previousProjectPath: '/repo',
        previousEffectiveProjectKey: '/repo',
      }),
      { flush: true },
    );
    expect(sessions.get(SOURCE_CHAT_ID).projectPath).toBe(realNextPath);
  });

  it('persists a prepared native session before provider cleanup', async () => {
    const relocated = {
      ownerId: 'claude',
      schemaVersion: 1,
      value: {
        path: '/tmp/relocated.jsonl',
        agentSessionId: 'agent-1',
      },
    };
    let sessions;
    const commit = mock(async () => {
      expect(sessions.get(SOURCE_CHAT_ID).nativeSession).toEqual(relocated);
    });
    const rollback = mock(() => Promise.resolve());
    const fixture = makeService({
      agents: {
        prepareProjectPathUpdate: mock(() => Promise.resolve({
          nativeSession: relocated,
          commit,
          rollback,
        })),
      },
    });
    sessions = fixture.sessions;
    const nextPath = path.join(projectBaseDir, 'prepared-native');
    await fs.mkdir(nextPath, { recursive: true });

    await expect(fixture.service.updateProjectPath({
      chatId: SOURCE_CHAT_ID,
      projectPath: nextPath,
    })).resolves.toMatchObject({ success: true });

    expect(fixture.chats.updateProjectPath).toHaveBeenCalledWith(
      SOURCE_CHAT_ID,
      expect.objectContaining({ nativeSession: relocated }),
      { flush: true },
    );
    expect(commit).toHaveBeenCalledTimes(1);
    expect(rollback).not.toHaveBeenCalled();
  });

  it('rolls back provider preparation when registry persistence fails', async () => {
    const commit = mock(() => Promise.resolve());
    const rollback = mock(() => Promise.resolve());
    const fixture = makeService({
      agents: {
        prepareProjectPathUpdate: mock(() => Promise.resolve({
          nativeSession: {
            ownerId: 'claude',
            schemaVersion: 1,
            value: { path: '/tmp/relocated.jsonl' },
          },
          commit,
          rollback,
        })),
      },
      chats: {
        updateProjectPath: mock(() => Promise.reject(new Error('disk full'))),
      },
    });
    const nextPath = path.join(projectBaseDir, 'failed-persistence');
    await fs.mkdir(nextPath, { recursive: true });

    await expect(fixture.service.updateProjectPath({
      chatId: SOURCE_CHAT_ID,
      projectPath: nextPath,
    })).rejects.toThrow('disk full');

    expect(rollback).toHaveBeenCalledTimes(1);
    expect(commit).not.toHaveBeenCalled();
  });

  it('rolls back preparation and preserves the typed error when the chat disappears', async () => {
    const commit = mock(() => Promise.resolve());
    const rollback = mock(() => Promise.resolve());
    const fixture = makeService({
      agents: {
        prepareProjectPathUpdate: mock(() => Promise.resolve({
          nativeSession: null,
          commit,
          rollback,
        })),
      },
      chats: {
        updateProjectPath: mock(() => Promise.resolve(null)),
      },
    });
    const nextPath = path.join(projectBaseDir, 'removed-chat');
    await fs.mkdir(nextPath, { recursive: true });

    await expect(fixture.service.updateProjectPath({
      chatId: SOURCE_CHAT_ID,
      projectPath: nextPath,
    })).rejects.toMatchObject({
      code: 'SESSION_NOT_FOUND',
      status: 404,
    });

    expect(rollback).toHaveBeenCalledTimes(1);
    expect(commit).not.toHaveBeenCalled();
  });

  it('does not report durable project-path updates as failed when cleanup fails', async () => {
    const commit = mock(() => Promise.reject(new Error('cleanup failed')));
    const fixture = makeService({
      agents: {
        prepareProjectPathUpdate: mock(() => Promise.resolve({
          nativeSession: null,
          commit,
          rollback: mock(() => Promise.resolve()),
        })),
      },
    });
    const nextPath = path.join(projectBaseDir, 'cleanup-warning');
    await fs.mkdir(nextPath, { recursive: true });

    await expect(fixture.service.updateProjectPath({
      chatId: SOURCE_CHAT_ID,
      projectPath: nextPath,
    })).resolves.toMatchObject({ success: true });
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('maps unavailable provider transcripts to the project-path error contract', async () => {
    const fixture = makeService({
      agents: {
        prepareProjectPathUpdate: mock(() => Promise.reject(
          new AgentIntegrationError(
            'TRANSCRIPT_UNAVAILABLE',
            'Claude session transcript could not be resolved for project-path update',
            false,
          ),
        )),
      },
    });
    const nextPath = path.join(projectBaseDir, 'missing-transcript');
    await fs.mkdir(nextPath, { recursive: true });

    await expect(fixture.service.updateProjectPath({
      chatId: SOURCE_CHAT_ID,
      projectPath: nextPath,
    })).rejects.toMatchObject({
      code: 'PROJECT_PATH_NATIVE_PATH_UNRESOLVED',
      status: 409,
      retryable: false,
    });

    expect(fixture.chats.updateProjectPath).not.toHaveBeenCalled();
  });

  it('allows an unstarted Claude chat to change project path', async () => {
    const fixture = makeService({
      session: {
        agentSessionId: null,
        nativeSession: null,
      },
    });
    const nextPath = path.join(projectBaseDir, 'unstarted-chat');
    await fs.mkdir(nextPath, { recursive: true });

    await expect(fixture.service.updateProjectPath({
      chatId: SOURCE_CHAT_ID,
      projectPath: nextPath,
    })).resolves.toMatchObject({ success: true });

    expect(fixture.agents.resolveNativeSession).toHaveBeenCalledTimes(1);
    expect(fixture.agents.prepareProjectPathUpdate).toHaveBeenCalledTimes(1);
  });

  it('rejects project path updates while a turn is running', async () => {
    const { service, agents } = makeService();
    const nextPath = path.join(projectBaseDir, 'repo-worktree');
    await fs.mkdir(nextPath, { recursive: true });
    agents.isAgentSessionRunning.mockReturnValueOnce(true);

    await expect(
      service.updateProjectPath({
        chatId: SOURCE_CHAT_ID,
        projectPath: nextPath,
      }),
    ).rejects.toMatchObject({ code: 'CHAT_NOT_IDLE', status: 409 });

    expect(agents.prepareProjectPathUpdate).not.toHaveBeenCalled();
  });

  it('rejects project path updates while a queued turn is dispatching', async () => {
    const { service, queue, agents } = makeService();
    const nextPath = path.join(projectBaseDir, 'repo-worktree');
    await fs.mkdir(nextPath, { recursive: true });
    queue.readChatExecutionControl.mockResolvedValueOnce({
      entries: [
        {
          id: 'sending-1',
          content: 'continue',
          status: 'sending',
          createdAt: '2026-02-27T00:00:00.000Z',
        },
      ],
      pause: null,
      version: 2,
    });

    await expect(
      service.updateProjectPath({
        chatId: SOURCE_CHAT_ID,
        projectPath: nextPath,
      }),
    ).rejects.toMatchObject({ code: 'CHAT_NOT_IDLE', status: 409 });

    expect(agents.prepareProjectPathUpdate).not.toHaveBeenCalled();
  });

  it('rejects project path updates while a queued turn is waiting', async () => {
    const { service, queue, agents } = makeService();
    const nextPath = path.join(projectBaseDir, 'repo-worktree');
    await fs.mkdir(nextPath, { recursive: true });
    queue.readChatExecutionControl.mockResolvedValueOnce(storedQueue([
      queueEntry('queued-1', 'continue', 'queued'),
    ]));

    await expect(
      service.updateProjectPath({
        chatId: SOURCE_CHAT_ID,
        projectPath: nextPath,
      }),
    ).rejects.toMatchObject({ code: 'CHAT_NOT_IDLE', status: 409 });

    expect(agents.prepareProjectPathUpdate).not.toHaveBeenCalled();
  });

  it('rejects project path updates while a queued entry is steering', async () => {
    const { service, queue, agents } = makeService();
    const nextPath = path.join(projectBaseDir, 'repo-worktree');
    await fs.mkdir(nextPath, { recursive: true });
    queue.readChatExecutionControl.mockResolvedValueOnce(storedQueue([
      queueEntry('steering-1', 'continue', 'steering'),
    ]));

    await expect(
      service.updateProjectPath({
        chatId: SOURCE_CHAT_ID,
        projectPath: nextPath,
      }),
    ).rejects.toMatchObject({ code: 'CHAT_NOT_IDLE', status: 409 });

    expect(agents.prepareProjectPathUpdate).not.toHaveBeenCalled();
  });

  it('rejects project path updates with in-flight submitted input after reconcile', async () => {
    const { service, agents } = makeService({
      pendingInputs: {
        hasInFlightForChat: mock(() => true),
      },
    });
    const nextPath = path.join(projectBaseDir, 'repo-worktree');
    await fs.mkdir(nextPath, { recursive: true });

    await expect(
      service.updateProjectPath({
        chatId: SOURCE_CHAT_ID,
        projectPath: nextPath,
      }),
    ).rejects.toMatchObject({ code: 'CHAT_NOT_IDLE', status: 409 });

    expect(agents.prepareProjectPathUpdate).not.toHaveBeenCalled();
  });

  it('keeps terminal delivery evidence without treating it as active work', async () => {
    const views = new ChatViewStore(() => false);
    const loadNativeMessages = mock(async () => {
      throw new Error('project path update must not load native history');
    });
    const pendingInputsService = new PendingUserInputService({
      loadNativeMessages,
      getRetainedHistoryMessages: (chatId) => views.getRetainedHistoryMessages(chatId),
    });
    await pendingInputsService.register(SOURCE_CHAT_ID, 'interrupted input', {
      clientRequestId: 'req-unconfirmed',
      turnId: 'turn-unconfirmed',
      createdAt: '2026-06-01T00:00:00.000Z',
    });
    await pendingInputsService.register(SOURCE_CHAT_ID, 'failed input', {
      clientRequestId: 'req-failed',
      turnId: 'turn-failed',
      createdAt: '2026-06-01T00:00:01.000Z',
      deliveryStatus: 'failed',
    });
    await views.appendAfterEnsuringGeneration(
      SOURCE_CHAT_ID,
      async () => [],
      [new UserMessage(
        '2026-06-01T00:00:00.000Z',
        'interrupted input',
        undefined,
        {
          clientRequestId: 'req-unconfirmed',
          turnId: 'turn-unconfirmed',
          deliveryStatus: 'accepted',
        },
      )],
    );
    await pendingInputsService.reconcileRetainedHistory(SOURCE_CHAT_ID);
    expect(pendingInputsService.hasInFlightForChat(SOURCE_CHAT_ID)).toBe(true);
    pendingInputsService.settleRetainedCohort(
      pendingInputsService.captureCohort(SOURCE_CHAT_ID),
    );

    const { service, chats, agents } = makeService({
      pendingInputsService,
    });
    const nextPath = path.join(projectBaseDir, 'repo-worktree');
    await fs.mkdir(nextPath, { recursive: true });
    const realNextPath = await fs.realpath(nextPath);

    await expect(service.updateProjectPath({
      chatId: SOURCE_CHAT_ID,
      projectPath: nextPath,
    })).resolves.toMatchObject({ projectPath: realNextPath });

    expect(pendingInputsService.listForChat(SOURCE_CHAT_ID)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        clientRequestId: 'req-unconfirmed',
        deliveryStatus: 'unconfirmed',
      }),
      expect.objectContaining({
        clientRequestId: 'req-failed',
        deliveryStatus: 'failed',
      }),
    ]));
    expect(pendingInputsService.hasInFlightForChat(SOURCE_CHAT_ID)).toBe(false);
    expect(loadNativeMessages).not.toHaveBeenCalled();
    expect(agents.prepareProjectPathUpdate).toHaveBeenCalledTimes(1);
    expect(chats.updateProjectPath).toHaveBeenCalledTimes(1);
  });

  it('rejects project path updates during a real execution reservation', async () => {
    const pendingInputsService = new PendingUserInputService({
      loadNativeMessages: mock(async () => []),
      getRetainedHistoryMessages: mock(() => []),
    });
    const queueService = makeRealQueue(pendingInputsService);
    const reservation = queueService.reserveDirectTurn(SOURCE_CHAT_ID, {
      clientRequestId: 'req-preparing',
      turnId: 'turn-preparing',
    });
    const { service, agents } = makeService({
      queueService,
      pendingInputsService,
    });
    const nextPath = path.join(projectBaseDir, 'repo-worktree');
    await fs.mkdir(nextPath, { recursive: true });

    try {
      await expect(service.updateProjectPath({
        chatId: SOURCE_CHAT_ID,
        projectPath: nextPath,
      })).rejects.toMatchObject({
        code: 'CHAT_NOT_IDLE',
        status: 409,
        message: 'Cannot update project path while a turn is being prepared or finalized',
      });
      expect(agents.prepareProjectPathUpdate).not.toHaveBeenCalled();
    } finally {
      await queueService.releaseDirectTurn(reservation);
    }

    await expect(service.updateProjectPath({
      chatId: SOURCE_CHAT_ID,
      projectPath: nextPath,
    })).resolves.toMatchObject({ success: true });
  });

  it('rejects project path updates while a real drain finalizes an empty queue', async () => {
    const pendingInputsService = new PendingUserInputService({
      loadNativeMessages: mock(async () => []),
      getRetainedHistoryMessages: mock(() => []),
    });
    const queueService = makeRealQueue(pendingInputsService);
    const entryRemoved = deferred();
    const releaseFinalization = deferred();
    const removeSentChat = queueService.removeSentChat.bind(queueService);
    queueService.removeSentChat = mock(async (...args) => {
      const queue = await removeSentChat(...args);
      entryRemoved.resolve();
      await releaseFinalization.promise;
      return queue;
    });
    const { service, agents } = makeService({
      queueService,
      pendingInputsService,
    });
    const nextPath = path.join(projectBaseDir, 'repo-worktree');
    await fs.mkdir(nextPath, { recursive: true });
    await queueService.createChatQueueEntry(SOURCE_CHAT_ID, 'queued work');
    const drain = queueService.triggerDrain(SOURCE_CHAT_ID);

    try {
      await waitForCheckpoint(entryRemoved.promise, drain, 'queue drain');
      expect((await queueService.readChatExecutionControl(SOURCE_CHAT_ID)).entries).toEqual([]);
      expect(queueService.ownsExecution(SOURCE_CHAT_ID)).toBe(true);

      await expect(service.updateProjectPath({
        chatId: SOURCE_CHAT_ID,
        projectPath: nextPath,
      })).rejects.toMatchObject({
        code: 'CHAT_NOT_IDLE',
        status: 409,
        message: 'Cannot update project path while a turn is being prepared or finalized',
      });
      expect(agents.prepareProjectPathUpdate).not.toHaveBeenCalled();
    } finally {
      releaseFinalization.resolve();
      await drain;
    }
  });

  it('rejects a path update crossing the reservation-to-runtime compaction handoff', async () => {
    const pendingInputsService = new PendingUserInputService({
      loadNativeMessages: mock(async () => []),
      getRetainedHistoryMessages: mock(() => []),
    });
    let runtimeRunning = false;
    let compactTurn;
    const compactStarted = deferred();
    const releaseCompact = deferred();
    const queueReadStarted = deferred();
    const releaseQueueRead = deferred();
    const queueService = makeRealQueue(pendingInputsService, {
      isChatRunning: mock(() => runtimeRunning),
    });
    const readChatExecutionControl = queueService.readChatExecutionControl.bind(queueService);
    let holdNextQueueRead = false;
    queueService.readChatExecutionControl = mock(async (...args) => {
      const queue = await readChatExecutionControl(...args);
      if (holdNextQueueRead) {
        holdNextQueueRead = false;
        queueReadStarted.resolve();
        await releaseQueueRead.promise;
      }
      return queue;
    });
    const { service, agents } = makeService({
      queueService,
      pendingInputsService,
      agents: {
        isAgentSessionRunning: mock(() => runtimeRunning),
        compactSession: mock(async (_chatId, options) => {
          compactTurn = {
            clientRequestId: options.clientRequestId,
            turnId: options.turnId,
          };
          compactStarted.resolve();
          await releaseCompact.promise;
          runtimeRunning = true;
        }),
      },
    });
    const nextPath = path.join(projectBaseDir, 'repo-worktree');
    await fs.mkdir(nextPath, { recursive: true });
    let pathUpdate;

    try {
      await service.submitCompact({
        chatId: SOURCE_CHAT_ID,
        clientRequestId: 'req-compact-path-guard',
      });
      await compactStarted.promise;
      expect(queueService.ownsExecution(SOURCE_CHAT_ID)).toBe(true);

      holdNextQueueRead = true;
      pathUpdate = service.updateProjectPath({
        chatId: SOURCE_CHAT_ID,
        projectPath: nextPath,
      });
      await waitForCheckpoint(queueReadStarted.promise, pathUpdate, 'project path update');

      releaseCompact.resolve();
      await service.waitForBackgroundTasks();
      // The direct reservation is gone but its attempt is retained, so the chat still owns
      // execution across the handoff; that is one question now, not two.
      expect(queueService.ownsExecution(SOURCE_CHAT_ID)).toBe(true);

      releaseQueueRead.resolve();
      await expect(pathUpdate).rejects.toMatchObject({
        code: 'CHAT_NOT_IDLE',
        message: 'Cannot update project path while a turn is being prepared or finalized',
      });
      expect(agents.prepareProjectPathUpdate).not.toHaveBeenCalled();

      runtimeRunning = false;
      queueService.onAgentTurnTerminal(SOURCE_CHAT_ID, compactTurn);
      expect(queueService.ownsExecution(SOURCE_CHAT_ID)).toBe(false);
      await expect(service.updateProjectPath({
        chatId: SOURCE_CHAT_ID,
        projectPath: nextPath,
      })).resolves.toMatchObject({ success: true });
    } finally {
      releaseCompact.resolve();
      releaseQueueRead.resolve();
      await service.waitForBackgroundTasks();
      runtimeRunning = false;
      if (compactTurn) queueService.onAgentTurnTerminal(SOURCE_CHAT_ID, compactTurn);
      await pathUpdate?.catch(() => undefined);
    }
  });

  it('does not persist a project path when provider preparation fails', async () => {
    const { service, chats } = makeService({
      agents: {
        prepareProjectPathUpdate: mock(async () => {
          throw new Error('provider is not idle');
        }),
      },
    });
    const nextPath = path.join(projectBaseDir, 'repo-worktree');
    await fs.mkdir(nextPath, { recursive: true });

    await expect(service.updateProjectPath({
      chatId: SOURCE_CHAT_ID,
      projectPath: nextPath,
    })).rejects.toMatchObject({
      code: 'CHAT_NOT_IDLE',
      status: 409,
      message: 'provider is not idle',
    });
    expect(chats.updateProjectPath).not.toHaveBeenCalled();
  });

  it('serializes new direct admission behind project path preparation', async () => {
    const preparationStarted = deferred();
    const releasePreparation = deferred();
    const { service, queue, agents } = makeService({
      agents: {
        prepareProjectPathUpdate: mock(async () => {
          preparationStarted.resolve();
          await releasePreparation.promise;
        }),
      },
    });
    const nextPath = path.join(projectBaseDir, 'repo-worktree');
    await fs.mkdir(nextPath, { recursive: true });

    const pathUpdate = service.updateProjectPath({
      chatId: SOURCE_CHAT_ID,
      projectPath: nextPath,
    });
    await preparationStarted.promise;
    const submission = service.submitRun({
      chatId: SOURCE_CHAT_ID,
      command: 'after path update',
      clientRequestId: 'req-after-path',
      clientMessageId: 'msg-after-path',
    });
    await Promise.resolve();
    await Promise.resolve();

    const reservationsDuringPreparation = queue.reserveDirectTurn.mock.calls.length;
    releasePreparation.resolve();
    expect(reservationsDuringPreparation).toBe(0);
    await expect(pathUpdate).resolves.toMatchObject({ success: true });
    await expect(submission).resolves.toMatchObject({ status: 'accepted' });
    expect(queue.reserveDirectTurn).toHaveBeenCalledTimes(1);
    expect(agents.prepareProjectPathUpdate).toHaveBeenCalledTimes(1);
  });

});
