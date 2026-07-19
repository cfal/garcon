import { describe, expect, it, mock } from 'bun:test';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { UserMessage } from '../../common/chat-types.js';
import { QueueManager } from '../queue.js';
import { ChatExecutionActivity } from '../chats/chat-execution-activity.js';
import { ChatNativeReloader } from '../chats/chat-native-reload.js';
import { ChatRunningError } from '../chats/errors.js';
import { ChatViewStore } from '../chats/chat-view-store.js';
import { PendingUserInputService } from '../chats/pending-user-input-service.js';
import { UserAbortLifecycleCoordinator } from '../chats/user-abort-lifecycle-coordinator.js';
import { DirectChatRuntimeBase } from '../../server-agents/common/src/direct/direct-chat-runtime-base.ts';
import {
  CommandLedger,
  SERVER_RESTART_INTERRUPTED_ERROR_CODE,
} from '../commands/command-ledger.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('queue and transcript stability', () => {

  it('settles an aborted nonblocking direct start before admitting its successor', async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'queue-direct-abort-'));
    const streamResult = deferred();
    class HeldDirectRuntime extends DirectChatRuntimeBase {
      constructor() {
        super({
          runtimeId: 'held-direct',
          runtimeLabel: 'Held Direct',
          defaultModel: 'test-model',
          fallbackModels: [],
          getSessionDir: () => path.join(workspaceDir, 'direct'),
          getSessionFilePath: (sessionId) => path.join(workspaceDir, 'direct', `${sessionId}.jsonl`),
        });
      }

      buildUserTurn(command) {
        return { message: { role: 'user', content: command }, persistedContent: command };
      }

      buildAssistantMessage(content) {
        return { role: 'assistant', content };
      }

      persistedToMessage(message) {
        return message;
      }

      async streamSession(session) {
        session.abortController = new AbortController();
        try {
          return await streamResult.promise;
        } finally {
          session.abortController = null;
        }
      }
    }

    const runtime = new HeldDirectRuntime();
    let agentSessionId = null;
    try {
      const queue = new QueueManager(
        workspaceDir,
        {
          runAgentTurn: mock(async () => undefined),
          abortSession: mock(async () => (
            agentSessionId ? runtime.abort(agentSessionId) : false
          )),
          isChatRunning: mock(() => (
            agentSessionId ? runtime.isRunning(agentSessionId) : false
          )),
          waitUntilTurnAbortable: mock(() => Promise.resolve(true)),
        },
        {
          register: mock(async () => undefined),
          discard: mock(() => true),
          markFailed: mock(() => true),
          markUnconfirmed: mock(() => true),
        },
        { appendMessages: mock(async () => ({ generationId: 'generation-1', messages: [] })) },
        () => ({}),
        () => true,
      );
      const settled = deferred();
      queue.onTurnSettled((chatId, turn) => settled.resolve({ chatId, turn }));
      runtime.onFinished((chatId, _exitCode, metadata) => {
        queue.onAgentTurnTerminal(chatId, metadata);
      });

      const reservation = queue.reserveDirectTurn('chat-direct', {
        clientRequestId: 'req-a',
        turnId: 'turn-a',
      });
      const started = await runtime.startSession({
        chatId: 'chat-direct',
        command: 'first',
        projectPath: workspaceDir,
        model: 'test-model',
        permissionMode: 'default',
        thinkingMode: 'none',
        clientRequestId: 'req-a',
        turnId: 'turn-a',
      });
      agentSessionId = started.agentSessionId;
      await queue.completeDirectTurn(reservation);

      expect(() => queue.reserveDirectTurn('chat-direct', {
        clientRequestId: 'req-b',
        turnId: 'turn-b',
      })).toThrow('Another chat turn already owns execution');

      await expect(queue.interruptActiveTurn('chat-direct')).resolves.toBe(true);
      streamResult.reject(new Error('request aborted'));
      await expect(settled.promise).resolves.toEqual({
        chatId: 'chat-direct',
        turn: { clientRequestId: 'req-a', turnId: 'turn-a' },
      });

      const successor = queue.reserveDirectTurn('chat-direct', {
        clientRequestId: 'req-b',
        turnId: 'turn-b',
      });
      await queue.releaseDirectTurn(successor);
    } finally {
      runtime.shutdown();
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it('does not assign interrupted-turn settlement to the next queued message', async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'queue-stop-settlement-'));
    try {
      const chatId = 'chat-1';
      const firstTurnStarted = deferred();
      const firstTurnResult = deferred();
      const secondTurnStarted = deferred();
      const secondTurnResult = deferred();
      const nativeLoadStarted = deferred();
      const nativeLoadResult = deferred();
      const interruptedSettled = deferred();
      const views = new ChatViewStore(() => false);
      const pendingInputs = new PendingUserInputService({
        loadNativeMessages: mock(async () => {
          nativeLoadStarted.resolve();
          return nativeLoadResult.promise;
        }),
        getRetainedHistoryMessages: (requestedChatId) => (
          views.getRetainedHistoryMessages(requestedChatId)
        ),
      });
      let interruptedRequestId;
      pendingInputs.store.onStatusUpdated((_chatId, clientRequestId, deliveryStatus) => {
        if (clientRequestId === interruptedRequestId && deliveryStatus === 'unconfirmed') {
          interruptedSettled.resolve();
        }
      });
      let activeTurn;
      const coordinator = new UserAbortLifecycleCoordinator(pendingInputs, {
        terminalTimeoutMs: 60_000,
      });
      const queue = new QueueManager(
        workspaceDir,
        {
          runAgentTurn: mock(async (_chatId, content, options) => {
            activeTurn = options;
            if (content === 'interrupted') {
              interruptedRequestId = options.clientRequestId;
              firstTurnStarted.resolve();
              await firstTurnResult.promise;
              return;
            }
            secondTurnStarted.resolve();
            await secondTurnResult.promise;
          }),
          abortSession: mock(async () => true),
          isChatRunning: mock(() => false),
          waitUntilTurnAbortable: mock(() => Promise.resolve(true)),
        },
        pendingInputs,
        {
          appendMessages: (requestedChatId, messages) => views.appendAfterEnsuringGeneration(
            requestedChatId,
            async () => [],
            messages,
          ),
        },
        () => ({}),
        () => true,
      );
      queue.onSessionStopRequested((requestedChatId, stopId, turn) => {
        coordinator.onStopRequested(requestedChatId, stopId, turn);
      });
      queue.onSessionStopped((requestedChatId, success, _intent, stopId) => {
        coordinator.onSessionStopped(requestedChatId, stopId, success);
      });
      queue.onTurnSettled((requestedChatId, turn) => {
        coordinator.onTurnSettled(requestedChatId, turn);
      });

      await queue.createChatQueueEntry(chatId, 'interrupted');
      await queue.createChatQueueEntry(chatId, 'sent next');
      const drain = queue.triggerDrain(chatId);
      await firstTurnStarted.promise;

      await queue.interruptActiveTurn(chatId);
      coordinator.onTurnTerminal(chatId, activeTurn);
      firstTurnResult.reject(new Error('interrupted by user'));
      await Promise.all([nativeLoadStarted.promise, secondTurnStarted.promise]);
      nativeLoadResult.resolve([]);
      await interruptedSettled.promise;

      expect(pendingInputs.listForChat(chatId)).toMatchObject([
        { content: 'interrupted', deliveryStatus: 'unconfirmed' },
        { content: 'sent next', deliveryStatus: 'accepted' },
      ]);

      secondTurnResult.resolve();
      await drain;
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it('captures a queued input registered while Stop waits for an abortable runtime', async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'queue-stop-preparation-'));
    try {
      const chatId = 'chat-preparing';
      const registrationStarted = deferred();
      const releaseRegistration = deferred();
      const inputSettled = deferred();
      const runtimeAbortable = deferred();
      const turnResult = deferred();
      const views = new ChatViewStore(() => false);
      const pendingInputs = new PendingUserInputService({
        loadNativeMessages: mock(async () => []),
        getRetainedHistoryMessages: (requestedChatId) => (
          views.getRetainedHistoryMessages(requestedChatId)
        ),
      });
      const pendingPort = {
        register: mock(async (...args) => {
          registrationStarted.resolve();
          await releaseRegistration.promise;
          return pendingInputs.register(...args);
        }),
        discard: pendingInputs.discard.bind(pendingInputs),
        markFailed: pendingInputs.markFailed.bind(pendingInputs),
        markUnconfirmed: pendingInputs.markUnconfirmed.bind(pendingInputs),
      };
      const coordinator = new UserAbortLifecycleCoordinator(pendingInputs, {
        terminalTimeoutMs: 0,
      });
      pendingInputs.store.onStatusUpdated((_chatId, _clientRequestId, deliveryStatus) => {
        if (deliveryStatus === 'unconfirmed') inputSettled.resolve();
      });
      const turnRunner = {
        runAgentTurn: mock(async () => {
          await turnResult.promise;
        }),
        abortSession: mock(async () => {
          turnResult.reject(new Error('runtime rejects aborted turns'));
          return true;
        }),
        isChatRunning: mock(() => false),
        waitUntilTurnAbortable: mock(() => runtimeAbortable.promise),
      };
      const queue = new QueueManager(
        workspaceDir,
        turnRunner,
        pendingPort,
        {
          appendMessages: (requestedChatId, messages) => views.appendAfterEnsuringGeneration(
            requestedChatId,
            async () => [],
            messages,
          ),
        },
        () => ({}),
        () => true,
      );
      queue.onSessionStopRequested((requestedChatId, stopId, turn) => {
        coordinator.onStopRequested(requestedChatId, stopId, turn);
      });
      queue.onSessionStopped((requestedChatId, success, _intent, stopId) => {
        coordinator.onSessionStopped(requestedChatId, stopId, success);
      });
      queue.onTurnSettled((requestedChatId, turn) => {
        coordinator.onTurnSettled(requestedChatId, turn);
      });

      await queue.createChatQueueEntry(chatId, 'preparing');
      await queue.createChatQueueEntry(chatId, 'tail');
      const drain = queue.triggerDrain(chatId);
      await registrationStarted.promise;
      const stop = queue.stopActiveTurn(chatId);

      releaseRegistration.resolve();
      runtimeAbortable.resolve(true);
      await expect(stop).resolves.toMatchObject({ stopped: true });
      await drain;
      await inputSettled.promise;

      expect(turnRunner.runAgentTurn).toHaveBeenCalledTimes(1);
      expect(turnRunner.abortSession).toHaveBeenCalledTimes(1);
      expect(pendingInputs.listForChat(chatId)).toMatchObject([{
        content: 'preparing',
        deliveryStatus: 'unconfirmed',
      }]);
      expect(await queue.readChatExecutionControl(chatId)).toMatchObject({
        entries: [{ content: 'tail', status: 'queued' }],
        pause: { kind: 'manual' },
      });
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it('preserves FIFO user rows across drain, native reconciliation, and generation replacement', async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'queue-transcript-stability-'));
    try {
      const chatId = 'chat-1';
      const nativeMessages = [];
      const firstTurnStarted = deferred();
      const releaseFirstTurn = deferred();
      const activity = new ChatExecutionActivity({ isChatRunning: () => false });
      const views = new ChatViewStore(activity.isActive);
      const loadNativeMessages = mock(async () => [...nativeMessages]);
      const pendingInputs = new PendingUserInputService({
        loadNativeMessages,
        getRetainedHistoryMessages: (requestedChatId) => (
          views.getRetainedHistoryMessages(requestedChatId)
        ),
      });
      let turnCount = 0;
      const queue = new QueueManager(
        workspaceDir,
        {
          runAgentTurn: mock(async (_chatId, content, options) => {
            turnCount += 1;
            if (turnCount === 1) {
              firstTurnStarted.resolve();
              await releaseFirstTurn.promise;
            }
            nativeMessages.push(new UserMessage(
              new Date().toISOString(),
              content,
              undefined,
              {
                clientRequestId: options.clientRequestId,
                turnId: options.turnId,
              },
            ));
            await pendingInputs.reconcileNativeHistory(chatId);
          }),
          abortSession: mock(async () => false),
          isChatRunning: mock(() => false),
          waitUntilTurnAbortable: mock(() => Promise.resolve(true)),
        },
        pendingInputs,
        {
          appendMessages: (requestedChatId, messages) => views.appendAfterEnsuringGeneration(
            requestedChatId,
            async () => [...nativeMessages],
            messages,
          ),
        },
        () => ({}),
        () => true,
      );
      activity.attachReservedExecutions(queue);
      const reloader = new ChatNativeReloader(
        views,
        { loadNativeMessages },
        activity.isActive,
      );

      await Promise.all([
        queue.createChatQueueEntry(chatId, 'first'),
        queue.createChatQueueEntry(chatId, 'second'),
        queue.createChatQueueEntry(chatId, 'third'),
      ]);
      const drain = queue.triggerDrain(chatId);
      await firstTurnStarted.promise;

      expect(activity.isActive(chatId)).toBe(true);
      await expect(reloader.reloadFromNative(chatId, 'manual-reload')).rejects.toBeInstanceOf(
        ChatRunningError,
      );

      releaseFirstTurn.resolve();
      await drain;

      expect(activity.isActive(chatId)).toBe(false);
      expect((await queue.readChatExecutionControl(chatId)).entries).toEqual([]);
      expect(pendingInputs.listForChat(chatId)).toEqual([]);
      expect(views.readPage(chatId, 20).messages.map((entry) => entry.message.content)).toEqual([
        'first',
        'second',
        'third',
      ]);

      const beforeReloadCalls = loadNativeMessages.mock.calls.length;
      await reloader.reloadFromNative(chatId, 'manual-reload');
      expect(loadNativeMessages.mock.calls.length).toBe(beforeReloadCalls + 1);
      expect(views.readPage(chatId, 20).messages.map((entry) => entry.message.content)).toEqual([
        'first',
        'second',
        'third',
      ]);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it('recovers sending queue work and its accepted command as interrupted after restart', async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'queue-restart-stability-'));
    try {
      const chatId = 'chat-restart';
      const queueDeps = [
        {
          runAgentTurn: mock(async () => undefined),
          abortSession: mock(async () => false),
          isChatRunning: mock(() => false),
          waitUntilTurnAbortable: mock(() => Promise.resolve(true)),
        },
        {
          register: mock(async () => undefined),
          discard: mock(() => true),
          markFailed: mock(() => true),
          markUnconfirmed: mock(() => true),
        },
        {
          appendMessages: mock(async () => ({ generationId: 'generation-1', messages: [] })),
        },
        () => ({}),
        () => true,
      ];
      const queue = new QueueManager(workspaceDir, ...queueDeps);
      const created = await queue.createChatQueueEntry(chatId, 'survive restart');
      await queue.popNextChat(chatId);

      const ledgerInput = {
        commandType: 'agent-run',
        chatId,
        clientRequestId: 'request-restart',
        payload: { chatId, command: 'survive restart' },
      };
      const ledger = new CommandLedger(workspaceDir);
      const accepted = await ledger.accept(ledgerInput);
      expect(accepted.kind).toBe('accepted');
      await ledger.update(accepted.record.key, { status: 'scheduled' });

      const restartedQueue = new QueueManager(workspaceDir, ...queueDeps);
      await restartedQueue.recoverChatExecutionControls();
      const recoveredQueue = await restartedQueue.readChatExecutionControl(chatId);
      expect(recoveredQueue.entries).toMatchObject([{
        id: created.entry.id,
        content: 'survive restart',
        status: 'queued',
      }]);
      expect(recoveredQueue.pause).toMatchObject({
        kind: 'recovered-inflight',
        entryId: created.entry.id,
      });

      const restartedLedger = new CommandLedger(workspaceDir);
      const duplicate = await restartedLedger.accept(ledgerInput);
      expect(duplicate).toMatchObject({
        kind: 'duplicate',
        record: {
          status: 'failed',
          errorCode: SERVER_RESTART_INTERRUPTED_ERROR_CODE,
        },
      });
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });
});
