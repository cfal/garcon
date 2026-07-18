import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';

import { ChatCommandService } from '../chat-command-service.ts';
import { CommandLedger } from '../command-ledger.ts';
import { UserMessage } from '../../../common/chat-types.js';
import { attachNativeMessageSource } from '../../agents/shared/native-message-source.js';
import { ChatIdAllocator } from '../../chats/chat-id-allocator.js';
import {
  ACTIVE_INPUT_NOT_DELIVERED_MESSAGE,
  ACTIVE_INPUT_OUTCOME_UNKNOWN_MESSAGE,
  ActiveInputDeliveryError,
} from '../../lib/domain-error.js';
import { QueueEntryMutationError, QueueManager } from '../../queue.js';
import { ChatViewStore } from '../../chats/chat-view-store.js';
import { PendingUserInputService } from '../../chats/pending-user-input-service.js';

let workspaceDir;
let projectBaseDir;
let originalProjectBaseDir;
let activeServices = [];
const SOURCE_CHAT_ID = '1783725900000000';
const TARGET_CHAT_ID = '1783725900000001';
const SCHEDULED_CHAT_ID = '1783725900000002';

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
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
    version: 0,
    updatedAt: null,
    ...overrides,
  };
}

function manualPause(id = 'pause-1') {
  return { id, kind: 'manual', pausedAt: '2026-07-16T00:00:00.000Z' };
}

function projectedChat(chatId, projectPath = '/repo') {
  return {
    id: chatId,
    agentId: 'claude',
    model: 'opus',
    permissionMode: 'default',
    thinkingMode: 'none',
    claudeThinkingMode: 'auto',
    ampAgentMode: 'smart',
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
  const session = {
    id: SOURCE_CHAT_ID,
    agentId: 'claude',
    agentSessionId: 'agent-1',
    nativePath: '/tmp/agent-1.jsonl',
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
        ...('nativePath' in update ? { nativePath: update.nativePath } : {}),
      };
      sessions.set(chatId, next);
      return Promise.resolve(next);
    }),
    removeChat: mock((chatId) => sessions.delete(chatId)),
  };
  const queue = overrides.queueService ?? {
    registerPendingUserInput: mock(() => Promise.resolve(undefined)),
    reserveDirectTurn: mock((chatId) => directReservation(chatId)),
    releaseDirectTurn: mock(() => Promise.resolve(undefined)),
    completeDirectTurn: mock(() => Promise.resolve(undefined)),
    failDirectTurn: mock(() => Promise.resolve(undefined)),
    runReservedTurn: mock(() => Promise.resolve(undefined)),
    stopActiveTurn: mock(() => Promise.resolve({ stopped: true, queue: storedQueue() })),
    interruptActiveTurn: mock(() => Promise.resolve(true)),
    abortForChatDeletion: mock(() => Promise.resolve(true)),
    deleteChatQueueFile: mock(() => Promise.resolve(undefined)),
    triggerDrain: mock(() => Promise.resolve(undefined)),
    isChatExecutionReserved: mock(() => false),
    readChatQueue: mock(() => Promise.resolve(storedQueue())),
    createChatQueueEntry: mock(() =>
      Promise.resolve({
        entry: queueEntry('entry-1'),
        entryId: 'entry-1',
        queue: storedQueue([queueEntry('entry-1')], { version: 1 }),
        duplicate: false,
      }),
    ),
    replaceChatQueueEntry: mock((_chatId, entryId, content, revision) =>
      Promise.resolve({
        entry: queueEntry(entryId, content, 'queued', revision + 1),
        entryId,
        queue: storedQueue([queueEntry(entryId, content, 'queued', revision + 1)], { version: 1 }),
        duplicate: false,
      }),
    ),
    deleteChatQueueEntry: mock((_chatId, entryId) =>
      Promise.resolve({
        entryId,
        queue: storedQueue([], { version: 1 }),
        duplicate: false,
      }),
    ),
    deliverActiveInput: mock(() => Promise.resolve(false)),
    clearChatQueue: mock(() => Promise.resolve(storedQueue([], { version: 1 }))),
    pauseChatQueue: mock(() => Promise.resolve(storedQueue([], { version: 1 }))),
    resumeChatQueue: mock(() => Promise.resolve(storedQueue([], { version: 1 }))),
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
    compactSession: mock(() => Promise.resolve(undefined)),
    resolveNativePath: mock((chat) => Promise.resolve(chat.nativePath ?? null)),
    rewriteForkTranscriptEntry: mock((_agentId, entry) => entry),
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
    nativePath: '/tmp/agent-2.jsonl',
  }));
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
    nativeMessages: overrides.nativeMessages,
    forkChatFileCopy,
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
  };
}

function makeRealQueue(pendingInputsService, turnRunnerOverrides = {}) {
  return new QueueManager(
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

async function readLedgerRecords() {
  const raw = await fs.readFile(path.join(workspaceDir, 'command-ledger.json'), 'utf8');
  return JSON.parse(raw).records;
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

  it('rejects unsupported direct run attachments before scheduling queue work', async () => {
    const { service, queue } = makeService();

    await expect(
      service.submitRun({
        chatId: SOURCE_CHAT_ID,
        command: 'inspect this file',
        images: [attachment('application/octet-stream')],
        clientRequestId: 'req-bad-attachment',
        clientMessageId: 'msg-bad-attachment',
      }),
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      status: 400,
      message: 'Invalid file type. Only images, Markdown, text, and PDF files are allowed.',
    });

    expect(queue.registerPendingUserInput).not.toHaveBeenCalled();
    expect(queue.runReservedTurn).not.toHaveBeenCalled();
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
        images: [attachment('application/octet-stream')],
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

  it('normalizes chat start tags before storing the command and chat', async () => {
    const { service, chats } = makeService();

    const result = await service.submitStart({
      chatId: TARGET_CHAT_ID,
      agentId: 'claude',
      projectPath: projectBaseDir,
      command: 'start with normalized tags',
      model: 'opus',
      tags: ['Review Needed', 'review-needed', '  QA  ', 42, '!!!'],
      clientRequestId: 'req-start-tags',
      clientMessageId: 'msg-start-tags',
    });

    expect(result.status).toBe('accepted');
    expect(chats.addChat).toHaveBeenCalledWith(
      expect.objectContaining({
        tags: ['qa', 'review-needed'],
      }),
    );

    const records = await readLedgerRecords();
    expect(records[0].payload.tags).toEqual(['qa', 'review-needed']);
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
      claudeThinkingMode: 'auto',
      ampAgentMode: 'smart',
      tags: ['Review Needed', 'review-needed', 'QA'],
    };

    await service.submitStart({
      ...shared,
      chatId: TARGET_CHAT_ID,
      clientRequestId: 'req-interactive',
      clientMessageId: 'msg-interactive',
    });
    const scheduled = await service.submitScheduledStart({
      ...shared,
      clientRequestId: 'req-scheduled',
      clientMessageId: 'msg-scheduled',
    });

    expect(scheduled.chatId).toBe(SCHEDULED_CHAT_ID);
    expect(allocate).toHaveBeenCalledTimes(1);
    const [{ id: interactiveId, ...interactive }, { id: scheduledId, ...scheduledEntry }] =
      chats.addChat.mock.calls.map(([entry]) => entry);
    expect(interactiveId).toBe(TARGET_CHAT_ID);
    expect(scheduledId).toBe(SCHEDULED_CHAT_ID);
    expect(scheduledEntry).toEqual(interactive);
    expect(interactive.thinkingMode).toBe('none');
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
      return { stopped: true, queue: storedQueue() };
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
      return { stopped: true, queue: storedQueue() };
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

  it('requires command identity and rejects invalid IDs before ledger acceptance', async () => {
    const { service, chats } = makeService();
    const input = {
      chatId: TARGET_CHAT_ID,
      agentId: 'claude',
      projectPath: projectBaseDir,
      command: 'hello',
      model: 'opus',
      clientRequestId: '',
      clientMessageId: 'msg-start',
    };

    await expect(service.submitStart(input)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      message: 'clientRequestId is required',
    });
    await expect(
      service.submitStart({
        ...input,
        chatId: '178372590000007231252',
        clientRequestId: 'req-start',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
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
      options: { model: 'opus' },
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

  it('reports a restart-interrupted duplicate instead of false acceptance', async () => {
    const record = {
      key: `agent-run:${SOURCE_CHAT_ID}:req-restarted`,
      commandType: 'agent-run',
      chatId: SOURCE_CHAT_ID,
      clientRequestId: 'req-restarted',
      payloadHash: 'hash',
      payload: {},
      status: 'failed',
      acceptedAt: '2026-07-17T00:00:00.000Z',
      updatedAt: '2026-07-17T00:01:00.000Z',
      error: 'Server restarted before command completion was recorded',
      errorCode: 'SERVER_RESTART_INTERRUPTED',
    };
    const ledger = {
      accept: mock(async () => ({ kind: 'duplicate', record })),
      update: mock(async () => record),
    };
    const { service, queue } = makeService({ ledger });

    await expect(service.submitRun({
      chatId: SOURCE_CHAT_ID,
      command: 'continue',
      clientRequestId: 'req-restarted',
      clientMessageId: 'msg-restarted',
    })).rejects.toMatchObject({
      code: 'SERVER_RESTART_INTERRUPTED',
      status: 409,
      retryable: false,
    });

    expect(queue.reserveDirectTurn).not.toHaveBeenCalled();
    expect(queue.registerPendingUserInput).not.toHaveBeenCalled();
  });

  it('keeps a live-failed direct input recoverable across a later restart', async () => {
    const { service, ledger } = makeService({
      queue: {
        runReservedTurn: mock(async () => {
          throw new Error('provider failed live');
        }),
      },
    });

    await expect(service.submitRun({
      chatId: SOURCE_CHAT_ID,
      command: 'do not lose me',
      clientRequestId: 'req-live-failure',
      clientMessageId: 'msg-live-failure',
    })).resolves.toMatchObject({ status: 'accepted' });
    await service.waitForBackgroundTasks();

    expect(await ledger.listPendingInputRecoveries()).toEqual([
      expect.objectContaining({
        commandType: 'agent-run',
        clientRequestId: 'req-live-failure',
        status: 'scheduled',
        pendingInputRecovery: 'required',
      }),
    ]);
    await expect(
      new CommandLedger(workspaceDir).listPendingInputRecoveries(),
    ).resolves.toEqual([
      expect.objectContaining({
        clientRequestId: 'req-live-failure',
        pendingInputRecovery: 'required',
      }),
    ]);
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
    await expect(service.submitRun({
      chatId: SOURCE_CHAT_ID,
      command: 'second',
      clientRequestId: 'req-concurrent-2',
      clientMessageId: 'msg-concurrent-2',
    })).rejects.toMatchObject({ code: 'SESSION_BUSY', status: 409 });

    expect(registerPendingUserInput).toHaveBeenCalledTimes(1);
    expect(runReservedTurn).toHaveBeenCalledTimes(1);
    expect(releaseDirectTurn).not.toHaveBeenCalled();
    releaseExecution();
    await executionFinished;
    await Promise.resolve();
  });

  it('rejects a direct run that would bypass durable queued input', async () => {
    const { service, queue } = makeService({
      queue: {
        readChatQueue: mock(() => Promise.resolve(storedQueue(
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

  it('rejects a direct run while restart uncertainty pauses an empty queue', async () => {
    const { service, queue } = makeService({
      queue: {
        readChatQueue: mock(() => Promise.resolve(storedQueue([], {
          pause: {
            id: 'pause-recovery',
            kind: 'recovered-unconfirmed-input',
            pausedAt: '2026-07-18T00:00:00.000Z',
          },
        }))),
      },
    });

    await expect(service.submitRun({
      chatId: SOURCE_CHAT_ID,
      command: 'must wait for review',
      clientRequestId: 'req-recovery-gate',
      clientMessageId: 'msg-recovery-gate',
    })).rejects.toMatchObject({ code: 'SESSION_BUSY', status: 409, retryable: true });

    expect(queue.registerPendingUserInput).not.toHaveBeenCalled();
    expect(queue.runReservedTurn).not.toHaveBeenCalled();
    expect(queue.releaseDirectTurn).toHaveBeenCalledTimes(1);
  });

  it('rejects a direct run while the queue head is dispatching', async () => {
    const { service, queue } = makeService({
      queue: {
        readChatQueue: mock(() => Promise.resolve(storedQueue([queueEntry('entry-1', 'first', 'sending')]))),
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

  it('marks accepted HTTP commands failed when durable submit append fails', async () => {
    const { service, queue, pendingInputs } = makeService();
    queue.registerPendingUserInput.mockRejectedValueOnce(new Error('append failed'));

    await expect(
      service.submitRun({
        chatId: SOURCE_CHAT_ID,
        command: 'continue',
        clientRequestId: 'req-fail-1',
        clientMessageId: 'msg-fail-1',
      }),
    ).rejects.toThrow('append failed');

    const records = await readLedgerRecords();
    expect(records[0]).toMatchObject({
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
        nativePath: '/tmp/agent-2.jsonl',
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

  it('rejects a fork when the source changes during the file snapshot', async () => {
    const forkChatFileCopy = mock(async (input) => {
      input.assertSourceSnapshotStable(true);
      throw new Error('unreachable');
    });
    const { service } = makeService({ forkChatFileCopy });

    await expect(service.forkChat({
      sourceChatId: SOURCE_CHAT_ID,
      chatId: TARGET_CHAT_ID,
    })).rejects.toMatchObject({
      code: 'SESSION_BUSY',
      status: 409,
    });
  });

  it('deletes chats through the mutation service cleanup path', async () => {
    const { service, chats, queue, settings, pendingInputs, sessions } = makeService();

    const result = await service.deleteChat({ chatId: SOURCE_CHAT_ID });

    expect(result).toEqual({ success: true, chatId: SOURCE_CHAT_ID });
    expect(queue.abortForChatDeletion).toHaveBeenCalledWith(SOURCE_CHAT_ID);
    expect(pendingInputs.clearChat).toHaveBeenCalledWith(SOURCE_CHAT_ID, 'chat-removed');
    expect(chats.removeChat).toHaveBeenCalledWith(SOURCE_CHAT_ID);
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

  it('rejects malformed message-point fork sequence values', async () => {
    const { service, forkChatFileCopy } = makeService();

    await expect(
      service.forkChat({
        sourceChatId: SOURCE_CHAT_ID,
        chatId: TARGET_CHAT_ID,
        upToSeq: '2abc',
      }),
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      status: 400,
    });

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

  it('forks a running source when the agent supports fork-while-running', async () => {
    const { service, agents, forkChatFileCopy } = makeService();
    agents.isAgentSessionRunning.mockReturnValue(true);
    agents.supportsForkWhileRunning.mockReturnValue(true);

    await service.forkChat({
      sourceChatId: SOURCE_CHAT_ID,
      chatId: TARGET_CHAT_ID,
    });

    expect(forkChatFileCopy).toHaveBeenCalledTimes(1);
  });

  it('resolves message-point forks to the native source line', async () => {
    const first = attachNativeMessageSource(new UserMessage('2026-03-27T08:00:00.000Z', 'first'), {
      entryId: 'entry-1',
      lineNumber: 2,
    });
    const second = attachNativeMessageSource(new UserMessage('2026-03-27T08:01:00.000Z', 'second'), {
      entryId: 'entry-2',
      lineNumber: 5,
    });
    const nativeMessages = {
      loadNativeMessages: mock(() => Promise.resolve([first, second])),
    };
    const { service, forkChatFileCopy } = makeService({ nativeMessages });

    await service.forkChat({
      sourceChatId: SOURCE_CHAT_ID,
      chatId: TARGET_CHAT_ID,
      upToSeq: 2,
    });

    expect(nativeMessages.loadNativeMessages).toHaveBeenCalledWith(SOURCE_CHAT_ID);
    expect(forkChatFileCopy).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceChatId: SOURCE_CHAT_ID,
        targetChatId: TARGET_CHAT_ID,
        truncateAfterEntryId: 'entry-2',
        truncateAfterLine: 5,
      }),
    );
  });

  it('routes file-copy transcript rewrites through the source agent', async () => {
    const rewritten = { sessionId: 'agent-2' };
    const { service, agents, forkChatFileCopy } = makeService();
    agents.rewriteForkTranscriptEntry.mockReturnValue(rewritten);

    await service.forkChat({ sourceChatId: SOURCE_CHAT_ID, chatId: TARGET_CHAT_ID });

    const input = forkChatFileCopy.mock.calls[0][0];
    const entry = { sessionId: 'agent-1' };
    const context = {
      sourceAgentSessionId: 'agent-1',
      targetAgentSessionId: 'agent-2',
    };
    expect(input.rewriteForkTranscriptEntry(entry, context)).toBe(rewritten);
    expect(agents.rewriteForkTranscriptEntry).toHaveBeenCalledWith('claude', entry, context);
  });

  it('allows message-point forks while the source is processing when the agent supports running forks', async () => {
    const first = attachNativeMessageSource(new UserMessage('2026-03-27T08:00:00.000Z', 'first'), {
      entryId: 'entry-1',
      lineNumber: 2,
    });
    const nativeMessages = {
      loadNativeMessages: mock(() => Promise.resolve([first])),
    };
    const { service, agents, forkChatFileCopy } = makeService({
      nativeMessages,
    });
    agents.isAgentSessionRunning.mockReturnValue(true);
    agents.supportsForkWhileRunning.mockReturnValue(true);

    await service.forkChat({
      sourceChatId: SOURCE_CHAT_ID,
      chatId: TARGET_CHAT_ID,
      upToSeq: 1,
    });

    expect(nativeMessages.loadNativeMessages).toHaveBeenCalledWith(SOURCE_CHAT_ID);
    expect(forkChatFileCopy).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceChatId: SOURCE_CHAT_ID,
        targetChatId: TARGET_CHAT_ID,
        truncateAfterEntryId: 'entry-1',
        truncateAfterLine: 2,
      }),
    );
  });

  it('forwards structured permission decision responses to agents', async () => {
    const { service, agents } = makeService();
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

    const records = await readLedgerRecords();
    expect(records[0].payload.response).toEqual(response);
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

  it('refuses /compact while recovered input uncertainty pauses the queue', async () => {
    const { service, agents, chats, queue } = makeService({
      queue: {
        readChatQueue: mock(() => Promise.resolve(storedQueue([], {
          pause: {
            id: 'pause-recovered',
            kind: 'recovered-unconfirmed-input',
            pausedAt: '2026-07-18T00:00:00.000Z',
          },
        }))),
      },
    });
    chats.addChat({
      id: SOURCE_CHAT_ID,
      agentId: 'claude',
      agentSessionId: 'agent-1',
    });

    await expect(service.submitCompact({
      chatId: SOURCE_CHAT_ID,
      clientRequestId: 'req-compact-recovered-pause',
    })).rejects.toMatchObject({ code: 'SESSION_BUSY' });

    expect(agents.compactSession).not.toHaveBeenCalled();
    expect(queue.releaseDirectTurn).toHaveBeenCalledTimes(1);
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
            queue: postCreate,
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

    expect(result.queue.entries.map((e) => e.id)).toEqual(['q1']);
    expect(result.queue.entries[0]).not.toHaveProperty('status');
    expect(result.queue.dispatchingEntryId).toBe('s1');
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
    expect(queue.triggerDrain).toHaveBeenCalledTimes(2);
  });

  it('recovers an accepted queue create from its durable queue receipt', async () => {
    const { service, queue, ledger } = makeService();
    const clientRequestId = 'request-crash-recovery';
    const entryId = 'prepared-entry-id';
    await ledger.accept({
      commandType: 'queue-entry-create',
      chatId: SOURCE_CHAT_ID,
      clientRequestId,
      payload: { chatId: SOURCE_CHAT_ID, content: 'survives restart' },
      entryId,
    });
    queue.createChatQueueEntry.mockResolvedValueOnce({
      entry: queueEntry(entryId, 'survives restart'),
      entryId,
      queue: storedQueue([queueEntry(entryId, 'survives restart')], {
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
      content: 'survives restart',
      clientRequestId,
    });

    expect(result).toMatchObject({ status: 'duplicate', entryId });
    expect(queue.createChatQueueEntry).toHaveBeenCalledWith(SOURCE_CHAT_ID, 'survives restart', {
      key: `queue-entry-create:${SOURCE_CHAT_ID}:${clientRequestId}`,
      entryId,
    });
    expect((await readLedgerRecords()).at(-1)).toMatchObject({
      status: 'scheduled',
      entryId,
    });
  });

  it('replaces and deletes queue entries through explicit ID commands', async () => {
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
  });

  it('replays semantic queue mutation failures without applying them after state changes', async () => {
    const latestQueue = storedQueue([queueEntry('entry-1', 'latest', 'queued', 2)], { version: 3 });
    const replaceFailure = new QueueEntryMutationError(
      'QUEUE_ENTRY_REVISION_CONFLICT',
      'This queued message changed before it could be saved',
      latestQueue,
    );
    const { service, queue } = makeService({
      queue: {
        readChatQueue: mock(() => Promise.resolve(latestQueue)),
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
      queue: expect.objectContaining({ version: 3 }),
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
    expect(await readLedgerRecords()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: 'rejected', errorCode: 'QUEUE_ENTRY_REVISION_CONFLICT' }),
        expect.objectContaining({ status: 'rejected', errorCode: 'QUEUE_ENTRY_ALREADY_SENT' }),
      ]),
    );
  });

  it('completes handled active input without exposing a synthetic queue entry', async () => {
    const { service, queue } = makeService({
      queue: {
        readChatQueue: mock(() => Promise.resolve(storedQueue([], { version: 4 }))),
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
    expect(result.queue.entries).toEqual([]);
    expect(result.entryId).toBeUndefined();
    expect(queue.triggerDrain).not.toHaveBeenCalled();
    expect(queue.deliverActiveInput).toHaveBeenCalledWith(SOURCE_CHAT_ID, '/goal pause', {
      clientRequestId: 'request-active',
    }, expect.any(Function));
    const records = await readLedgerRecords();
    expect(records.at(-1)).toMatchObject({
      status: 'finished',
      pendingInputRecovery: 'required',
    });
  });

  it('does not redeliver active input when recording the completed delivery fails', async () => {
    const { service, queue, ledger } = makeService({
      queue: {
        readChatQueue: mock(() => Promise.resolve(storedQueue())),
        deliverActiveInput: mock(async (_chatId, _content, _options, afterPendingRegistered) => {
          await afterPendingRegistered();
          return true;
        }),
      },
    });
    const update = ledger.update.bind(ledger);
    let failFinishedUpdate = true;
    ledger.update = mock((key, record) => {
      if (failFinishedUpdate && record.status === 'finished') {
        failFinishedUpdate = false;
        return Promise.reject(new Error('ledger finish failed'));
      }
      return update(key, record);
    });
    const input = {
      chatId: SOURCE_CHAT_ID,
      content: 'deliver exactly once',
      clientRequestId: 'request-active-ledger-failure',
    };

    await expect(service.submitActiveInput(input)).rejects.toThrow('ledger finish failed');
    await expect(service.submitActiveInput(input)).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      retryable: false,
    });

    expect(queue.deliverActiveInput).toHaveBeenCalledOnce();
    expect((await readLedgerRecords()).at(-1)).toMatchObject({ status: 'failed' });
    expect((await readLedgerRecords()).at(-1)?.errorCode).toBeUndefined();
  });

  it('reopens pre-accept active delivery failures for the same request id', async () => {
    let attempts = 0;
    const { service, queue } = makeService({
      queue: {
        readChatQueue: mock(() => Promise.resolve(storedQueue())),
        deliverActiveInput: mock(async () => {
          attempts += 1;
          if (attempts === 1) throw new ActiveInputDeliveryError(new Error('live registration failed'), false);
          return false;
        }),
        createChatQueueEntry: mock(() =>
          Promise.resolve({
            entry: queueEntry('queued-retry', 'retry me'),
            entryId: 'queued-retry',
            queue: storedQueue([queueEntry('queued-retry', 'retry me')], {
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
    let records = await readLedgerRecords();
    expect(records.at(-1)).toEqual(
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
    records = await readLedgerRecords();
    expect(records.at(-1)?.status).toBe('scheduled');
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
        readChatQueue: mock(() =>
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

  it('queues scheduled input behind an empty recovered-input pause', async () => {
    const { service, queue } = makeService({
      queue: {
        readChatQueue: mock(() => Promise.resolve(storedQueue([], {
          pause: {
            id: 'pause-recovery',
            kind: 'recovered-unconfirmed-input',
            pausedAt: '2026-07-18T00:00:00.000Z',
          },
        }))),
      },
    });

    const outcome = await service.submitScheduledExistingChat({
      chatId: SOURCE_CHAT_ID,
      command: 'scheduled after uncertain input',
      busyBehavior: 'queue',
      clientRequestId: 'scheduled-after-recovery',
      clientMessageId: 'scheduled-message-after-recovery',
    });

    expect(outcome.type).toBe('queued');
    expect(queue.createChatQueueEntry).toHaveBeenCalledWith(
      SOURCE_CHAT_ID,
      'scheduled after uncertain input',
      expect.any(Object),
    );
    expect(queue.reserveDirectTurn).not.toHaveBeenCalled();
  });

  it('skips scheduled input when an empty recovered-input pause blocks direct execution', async () => {
    const { service, queue } = makeService({
      queue: {
        readChatQueue: mock(() => Promise.resolve(storedQueue([], {
          pause: {
            id: 'pause-recovery',
            kind: 'recovered-unconfirmed-input',
            pausedAt: '2026-07-18T00:00:00.000Z',
          },
        }))),
      },
    });

    await expect(service.submitScheduledExistingChat({
      chatId: SOURCE_CHAT_ID,
      command: 'skip after uncertain input',
      busyBehavior: 'skip',
      clientRequestId: 'scheduled-skip-recovery',
      clientMessageId: 'scheduled-message-skip-recovery',
    })).resolves.toEqual({ type: 'skipped-busy', chatId: SOURCE_CHAT_ID });

    expect(queue.createChatQueueEntry).not.toHaveBeenCalled();
    expect(queue.reserveDirectTurn).not.toHaveBeenCalled();
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

  it('does not replay post-accept active delivery failures for the same request id', async () => {
    const { service, queue } = makeService({
      queue: {
        readChatQueue: mock(() => Promise.resolve(storedQueue())),
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
    let records = await readLedgerRecords();
    expect(records.at(-1)).toEqual(
      expect.objectContaining({
        status: 'failed',
        error: ACTIVE_INPUT_OUTCOME_UNKNOWN_MESSAGE,
        pendingInputRecovery: 'required',
      }),
    );
    expect(records.at(-1)?.errorCode).toBeUndefined();

    await expect(service.submitActiveInput(input)).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      status: 409,
      retryable: false,
      message: ACTIVE_INPUT_OUTCOME_UNKNOWN_MESSAGE,
    });
    records = await readLedgerRecords();
    expect(records.at(-1)?.status).toBe('failed');
    expect(queue.deliverActiveInput).toHaveBeenCalledTimes(1);
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

    expect(result.queue.entries).toEqual([]);
    expect(result.queue.dispatchingEntryId).toBe('s1');
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
    expect(queue.triggerDrain).toHaveBeenCalledWith(SOURCE_CHAT_ID);
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
      nativePath: '/tmp/agent-1.jsonl',
    });
    expect(agents.prepareProjectPathUpdate).toHaveBeenCalledWith(
      'claude',
      expect.objectContaining({
        chatId: SOURCE_CHAT_ID,
        agentSessionId: 'agent-1',
        previousProjectPath: '/repo',
        nextProjectPath: realNextPath,
        nativePath: '/tmp/agent-1.jsonl',
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
    queue.readChatQueue.mockResolvedValueOnce({
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
    queue.readChatQueue.mockResolvedValueOnce(storedQueue([
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
      queue: {
        readChatQueue: mock(() => Promise.resolve(storedQueue([], {
          pause: {
            id: 'pause-recovery',
            kind: 'recovered-unconfirmed-input',
            pausedAt: '2026-07-18T00:00:00.000Z',
          },
        }))),
      },
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
      await entryRemoved.promise;
      expect((await queueService.readChatQueue(SOURCE_CHAT_ID)).entries).toEqual([]);
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

  it('rejects project path updates throughout nonblocking compaction ownership', async () => {
    const pendingInputsService = new PendingUserInputService({
      loadNativeMessages: mock(async () => []),
      getRetainedHistoryMessages: mock(() => []),
    });
    let runtimeRunning = false;
    let compactTurn;
    const compactStarted = deferred();
    const releaseCompact = deferred();
    const queueService = makeRealQueue(pendingInputsService, {
      isChatRunning: mock(() => runtimeRunning),
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

    await service.submitCompact({
      chatId: SOURCE_CHAT_ID,
      clientRequestId: 'req-compact-path-guard',
    });

    try {
      await compactStarted.promise;
      expect(queueService.isChatExecutionReserved(SOURCE_CHAT_ID)).toBe(true);
      await expect(service.updateProjectPath({
        chatId: SOURCE_CHAT_ID,
        projectPath: nextPath,
      })).rejects.toMatchObject({
        code: 'CHAT_NOT_IDLE',
        message: 'Cannot update project path while a turn is being prepared or finalized',
      });
      expect(agents.prepareProjectPathUpdate).not.toHaveBeenCalled();
    } finally {
      releaseCompact.resolve();
      await service.waitForBackgroundTasks();
    }

    expect(queueService.isChatExecutionReserved(SOURCE_CHAT_ID)).toBe(false);
    await expect(service.updateProjectPath({
      chatId: SOURCE_CHAT_ID,
      projectPath: nextPath,
    })).rejects.toMatchObject({
      code: 'CHAT_NOT_IDLE',
      message: 'Cannot update project path while a turn is running',
    });

    runtimeRunning = false;
    queueService.onAgentTurnTerminal(SOURCE_CHAT_ID, compactTurn);
    await expect(service.updateProjectPath({
      chatId: SOURCE_CHAT_ID,
      projectPath: nextPath,
    })).resolves.toMatchObject({ success: true });
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

  it('resolves an artificial native path before changing directories', async () => {
    const resolvedNativePath = '/tmp/resolved-agent-1.jsonl';
    const { service, chats, agents } = makeService({
      session: { nativePath: '!claude:agent-1' },
      agents: {
        resolveNativePath: mock(() => Promise.resolve(resolvedNativePath)),
      },
    });
    const nextPath = path.join(projectBaseDir, 'repo-worktree');
    await fs.mkdir(nextPath, { recursive: true });

    await service.updateProjectPath({
      chatId: SOURCE_CHAT_ID,
      projectPath: nextPath,
    });

    expect(agents.resolveNativePath).toHaveBeenCalledWith(
      expect.objectContaining({
        id: SOURCE_CHAT_ID,
        projectPath: '/repo',
        nativePath: '!claude:agent-1',
      }),
    );
    expect(agents.prepareProjectPathUpdate).toHaveBeenCalledWith(
      'claude',
      expect.objectContaining({
        nativePath: resolvedNativePath,
      }),
    );
    expect(chats.updateProjectPath).toHaveBeenCalledWith(
      SOURCE_CHAT_ID,
      expect.objectContaining({
        nativePath: resolvedNativePath,
        effectiveProjectKey: expect.any(String),
        previousEffectiveProjectKey: '/repo',
      }),
      { flush: true },
    );
  });

  it('rejects Pi project path updates when the native transcript path cannot be resolved', async () => {
    const { service, chats, agents } = makeService({
      session: {
        agentId: 'pi',
        nativePath: '!pi:agent-1',
      },
      agents: {
        resolveNativePath: mock(() => Promise.resolve(null)),
      },
    });
    const nextPath = path.join(projectBaseDir, 'repo-worktree');
    await fs.mkdir(nextPath, { recursive: true });

    await expect(
      service.updateProjectPath({
        chatId: SOURCE_CHAT_ID,
        projectPath: nextPath,
      }),
    ).rejects.toMatchObject({
      code: 'PROJECT_PATH_NATIVE_PATH_UNRESOLVED',
      status: 409,
    });

    expect(agents.prepareProjectPathUpdate).not.toHaveBeenCalled();
    expect(chats.updateChat).not.toHaveBeenCalled();
  });
});
