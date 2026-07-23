import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';

import { ChatCommandService } from '../chat-command-service.ts';
import { CommandLedger, commandLedgerKey } from '../command-ledger.ts';
import { UserMessage } from '../../../common/chat-types.js';
import { ChatIdAllocator } from '../../chats/chat-id-allocator.js';
import {
  ACTIVE_INPUT_NOT_DELIVERED_MESSAGE,
  ACTIVE_INPUT_OUTCOME_UNKNOWN_MESSAGE,
  ActiveInputDeliveryError,
  DomainError,
} from '../../lib/domain-error.js';
import {
  QueueEntryMutationError,
  ChatExecutionCoordinator,
} from '../../chat-execution/chat-execution-coordinator.js';
import { ChatViewStore } from '../../chats/chat-view-store.js';
import { PendingUserInputService } from '../../chats/pending-user-input-service.js';
import {
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

async function completeWithin(operation, operationName, timeoutMs = 1_000) {
  let timeout;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`${operationName} did not complete within ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
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
      try {
        reservation = queue.reserveDirectTurn(input.command.chatId, input.options);
        await input.preparation?.prepare();
        await queue.registerPendingUserInput(input.command.chatId, input.content, input.options);
        await input.settlement.markScheduled(input.command, input.options.turnId);
        await input.dispatch?.(reservation.executionAdmission);
        await queue.completeDirectTurn(reservation);
      } catch (error) {
        await input.settlement.settleOperationFailure(input.command, error);
        await input.preparation?.compensate();
        if (reservation) await queue.failDirectTurn(reservation);
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
    deliverAcceptedActiveInput: mock(async (input) => {
      let deliveryAccepted = false;
      try {
        const delivered = await queue.deliverActiveInput(
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
          await input.settlement.settleActiveInput(input.command);
          return { delivery: 'active', control: await queue.readChatExecutionControl(input.command.chatId) };
        }
        const result = await queue.enqueueAccepted(input);
        return { delivery: 'queued', entryId: result.entryId, control: result.control };
      } catch (error) {
        deliveryAccepted ||= error instanceof ActiveInputDeliveryError && error.deliveryAccepted;
        if (!deliveryAccepted) activeFallbacks.delete(input.command.key);
        await input.settlement.settleActiveInputFailure(input.command, error, deliveryAccepted);
        throw error;
      }
    }),
    recoverAcceptedActiveInput: mock(async (input) => {
      const fallback = activeFallbacks.get(input.command.key);
      if (!fallback) {
        throw new DomainError(
          'INTERNAL_ERROR',
          'The previous active-input delivery did not reach a recorded outcome',
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
    registerPendingUserInput: mock(() => Promise.resolve(undefined)),
    reserveTranscriptSnapshot: mock((chatId) => {
      const source = sessions.get(chatId);
      if (
        queue.hasChatExecutionOwner(chatId)
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
    stopActiveTurn: mock(() => Promise.resolve({ stopped: true, control: storedQueue() })),
    interruptActiveTurn: mock(() => Promise.resolve(true)),
    abortForChatDeletion: mock(() => Promise.resolve(true)),
    deleteChatQueueFile: mock(() => Promise.resolve(undefined)),
    waitForDispatches: mock(() => Promise.all([...executionTasks]).then(() => undefined)),
    triggerDrain: mock(() => Promise.resolve(undefined)),
    isChatExecutionReserved: mock(() => false),
    hasChatExecutionOwner: mock(() => false),
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
    deliverActiveInput: mock(() => Promise.resolve(false)),
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
    supportsForkAtMessageWhileRunning: mock(() => false),
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
    runSingleQuery: mock(() => Promise.resolve('')),
    ...overrides.agents,
  };
  const pendingInputs = overrides.pendingInputsService ?? {
    register: mock(() => Promise.resolve(undefined)),
    clearChat: mock(() => undefined),
    reconcileRetainedHistory: mock(() => Promise.resolve(undefined)),
    reconcileNativeHistory: mock(() => Promise.resolve(undefined)),
    markFailed: mock(() => false),
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
  const ownership = {
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
  const service = new ChatCommandService({
    chats,
    queue,
    ledger,
    settings,
    metadata,
    agents,
    pendingInputs,
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
    settings,
    agents,
    pendingInputs,
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
      abortSession: mock(async () => false),
      isChatRunning: mock(() => false),
      waitUntilTurnAbortable: mock(async () => false),
      ...turnRunnerOverrides,
    },
    pendingInputsService,
    { appendMessages: mock(async () => ({ generationId: 'generation-1', messages: [] })) },
    () => ({}),
    () => true,
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
    expect(chats.getChat(TARGET_CHAT_ID)).toBeNull();
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
      return { stopped: true, control: storedQueue() };
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
    await expect(interrupt).resolves.toMatchObject({ stopped: true });
    await successorStarted.promise;

    queueService.onAgentTurnTerminal(SOURCE_CHAT_ID, predecessorTurn);
    await queueService.triggerDrain(SOURCE_CHAT_ID);
    expect(successorLaunches).toBe(1);

    successorResult.resolve();
    await completeWithin(queueService.waitForExecutionOwners(), 'successor settlement');
    const [pause, fork] = await completeWithin(Promise.all([
      service.mutateQueue({ chatId: SOURCE_CHAT_ID, action: 'pause' }),
      service.forkChat({
        sourceChatId: SOURCE_CHAT_ID,
        chatId: TARGET_CHAT_ID,
        upToSeq: 1,
      }),
    ]), 'post-interrupt mutations');

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
      return { stopped: true, control: storedQueue() };
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
    queue.hasChatExecutionOwner.mockReturnValue(true);

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

  it('rejects a whole-head fork while the source is running', async () => {
    const { service, agents, forkChatFileCopy } = makeService();
    agents.isAgentSessionRunning.mockReturnValue(true);
    agents.supportsForkAtMessageWhileRunning.mockReturnValue(true);

    await expect(service.forkChat({
      sourceChatId: SOURCE_CHAT_ID,
      chatId: TARGET_CHAT_ID,
    })).rejects.toMatchObject({ code: 'SESSION_BUSY', status: 409, retryable: true });

    expect(forkChatFileCopy).not.toHaveBeenCalled();
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
    agents.supportsForkAtMessageWhileRunning.mockReturnValue(true);

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
    expect(record.payload.response).toEqual(response);
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
  });

  it('completes handled active input without exposing a synthetic queue entry', async () => {
    const { service, queue, ledger } = makeService({
      queue: {
        readChatExecutionControl: mock(() => Promise.resolve(storedQueue([], { version: 4 }))),
        deliverActiveInput: mock(async (_chatId, _content, _options, afterPendingRegistered) => {
          await afterPendingRegistered();
          return true;
        }),
      },
    });

    const result = await service.submitActiveInput({
      chatId: SOURCE_CHAT_ID,
      content: '/goal pause',
      clientRequestId: 'request-active',
    });

    expect(result.status).toBe('accepted');
    expect(result.delivery).toBe('active');
    expect(result.control.queue.entries).toEqual([]);
    expect(result.entryId).toBeUndefined();
    expect(queue.triggerDrain).not.toHaveBeenCalled();
    expect(queue.deliverActiveInput).toHaveBeenCalledWith(
      SOURCE_CHAT_ID,
      '/goal pause',
      expect.objectContaining({ clientRequestId: 'request-active' }),
      expect.any(Function),
    );
    expect(await readLedgerRecord(ledger, 'active-input', 'request-active')).toMatchObject({
      status: 'finished',
    });
  });

  it('reopens pre-accept active delivery failures for the same request id', async () => {
    let attempts = 0;
    const { service, queue, ledger } = makeService({
      queue: {
        readChatExecutionControl: mock(() => Promise.resolve(storedQueue())),
        deliverActiveInput: mock(async () => {
          attempts += 1;
          if (attempts === 1) throw new ActiveInputDeliveryError(new Error('live registration failed'), false);
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
    await expect(service.submitActiveInput(input)).rejects.toMatchObject({
      message: ACTIVE_INPUT_NOT_DELIVERED_MESSAGE,
      cause: expect.objectContaining({ message: 'live registration failed' }),
      deliveryAccepted: false,
      retryable: true,
    });
    let record = await readLedgerRecord(ledger, 'active-input', input.clientRequestId);
    expect(record).toEqual(
      expect.objectContaining({
        status: 'failed',
        errorCode: 'PRE_SCHEDULE_FAILED',
      }),
    );

    await expect(service.submitActiveInput(input)).resolves.toEqual(
      expect.objectContaining({
        status: 'accepted',
        delivery: 'queued',
        entryId: 'queued-retry',
      }),
    );
    record = await readLedgerRecord(ledger, 'active-input', input.clientRequestId);
    expect(record.status).toBe('finished');
    expect(queue.deliverActiveInput).toHaveBeenCalledTimes(2);
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
    const { service, agents, queue } = makeService();
    agents.isAgentSessionRunning.mockReturnValue(true);

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
    const { service, queue } = makeService({
      queue: { isChatExecutionReserved: mock(() => true) },
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
    const { service, agents, queue } = makeService();
    agents.isAgentSessionRunning.mockReturnValue(true);

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
        deliverActiveInput: mock(async (_chatId, _content, _options, afterPendingRegistered) => {
          await afterPendingRegistered();
          throw new ActiveInputDeliveryError(new Error('live steer failed after acceptance'), true);
        }),
      },
    });
    const input = {
      chatId: SOURCE_CHAT_ID,
      content: 'deliver once',
      clientRequestId: 'request-accepted',
    };

    await expect(service.submitActiveInput(input)).rejects.toMatchObject({
      message: ACTIVE_INPUT_OUTCOME_UNKNOWN_MESSAGE,
      cause: expect.objectContaining({
        message: 'live steer failed after acceptance',
      }),
      deliveryAccepted: true,
      retryable: false,
    });
    let record = await readLedgerRecord(ledger, 'active-input', input.clientRequestId);
    expect(record).toEqual(
      expect.objectContaining({
        status: 'accepted',
        error: ACTIVE_INPUT_OUTCOME_UNKNOWN_MESSAGE,
      }),
    );
    expect(record.errorCode).toBe('ACTIVE_INPUT_OUTCOME_UNKNOWN');

    const recovered = await service.submitActiveInput(input);
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
    record = await readLedgerRecord(ledger, 'active-input', input.clientRequestId);
    expect(record).toMatchObject({ status: 'finished', entryId: recovered.entryId });
    expect(queue.deliverActiveInput).toHaveBeenCalledTimes(1);
    expect(queue.triggerDrain).toHaveBeenCalledTimes(1);
  });

  it('recovers an ambiguous active delivery through the real execution control transitions', async () => {
    const pendingInputsService = new PendingUserInputService({
      loadNativeMessages: mock(async () => []),
      getRetainedHistoryMessages: mock(() => []),
    });
    const submitActiveInput = mock(async (_chatId, _content, _options, beforeDelivery) => {
      await beforeDelivery();
      throw new Error('connection closed after provider acceptance');
    });
    const queueService = makeRealQueue(pendingInputsService, {
      isChatRunning: mock(() => true),
      submitActiveInput,
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

    await expect(service.submitActiveInput(input)).rejects.toMatchObject({
      deliveryAccepted: true,
      message: ACTIVE_INPUT_OUTCOME_UNKNOWN_MESSAGE,
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

    const recovered = await service.submitActiveInput(input);
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
    expect(submitActiveInput).toHaveBeenCalledTimes(1);
    expect(await readLedgerRecord(ledger, 'active-input', input.clientRequestId)).toMatchObject({
      status: 'finished',
      entryId: uncertain.entries[0].id,
    });

    const repeated = await service.submitActiveInput(input);
    expect(repeated).toMatchObject({
      status: 'duplicate',
      delivery: 'queued',
      entryId: uncertain.entries[0].id,
    });
    expect((await queueService.readChatExecutionControl(SOURCE_CHAT_ID)).entries).toHaveLength(1);
    expect(submitActiveInput).toHaveBeenCalledTimes(1);
  });

  it('does not report an incomplete active-input ledger record as delivered', async () => {
    const { service, queue, ledger } = makeService();
    await ledger.accept({
      commandType: 'active-input',
      chatId: SOURCE_CHAT_ID,
      clientRequestId: 'request-active-incomplete',
      payload: { chatId: SOURCE_CHAT_ID, content: 'uncertain delivery' },
      entryId: 'prepared-fallback-id',
    });

    await expect(
      service.submitActiveInput({
        chatId: SOURCE_CHAT_ID,
        content: 'uncertain delivery',
        clientRequestId: 'request-active-incomplete',
      }),
    ).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      status: 409,
      retryable: false,
    });

    expect(queue.deliverActiveInput).not.toHaveBeenCalled();
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
      expect(queueService.isChatExecutionReserved(SOURCE_CHAT_ID)).toBe(true);

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
      expect(queueService.isChatExecutionReserved(SOURCE_CHAT_ID)).toBe(true);
      expect(queueService.hasChatExecutionOwner(SOURCE_CHAT_ID)).toBe(true);

      holdNextQueueRead = true;
      pathUpdate = service.updateProjectPath({
        chatId: SOURCE_CHAT_ID,
        projectPath: nextPath,
      });
      await waitForCheckpoint(queueReadStarted.promise, pathUpdate, 'project path update');

      releaseCompact.resolve();
      await service.waitForBackgroundTasks();
      expect(queueService.isChatExecutionReserved(SOURCE_CHAT_ID)).toBe(false);
      expect(queueService.hasChatExecutionOwner(SOURCE_CHAT_ID)).toBe(true);

      releaseQueueRead.resolve();
      await expect(pathUpdate).rejects.toMatchObject({
        code: 'CHAT_NOT_IDLE',
        message: 'Cannot update project path while a turn is being prepared or finalized',
      });
      expect(agents.prepareProjectPathUpdate).not.toHaveBeenCalled();

      runtimeRunning = false;
      queueService.onAgentTurnTerminal(SOURCE_CHAT_ID, compactTurn);
      expect(queueService.hasChatExecutionOwner(SOURCE_CHAT_ID)).toBe(false);
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
