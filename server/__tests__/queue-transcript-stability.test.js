import { describe, expect, it, mock } from 'bun:test';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { UserMessage } from '../../common/chat-types.js';
import { ChatExecutionCoordinator } from '../chat-execution/chat-execution-coordinator.js';
import { InMemoryChatExecutionControlRepository } from '../chat-execution/chat-execution-control-repository.ts';
import { ChatNativeReloader } from '../chats/chat-native-reload.js';
import { ChatRunningError } from '../chats/errors.js';
import { ChatViewStore } from '../chats/chat-view-store.js';
import { PendingUserInputService } from '../chats/pending-user-input-service.js';
import { UserAbortLifecycleCoordinator } from '../chats/user-abort-lifecycle-coordinator.js';
import { DirectChatRuntimeBase } from '../../server-agents/common/src/direct/direct-chat-runtime-base.ts';
import {
  CommandLedger,
} from '../commands/command-ledger.js';
import {
  snapshotLoader,
  transcriptLoader,
} from '../chats/__tests__/chat-transcript-test-helpers.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function controlRepository(serverInstanceId = 'server-instance-test') {
  return new InMemoryChatExecutionControlRepository(serverInstanceId);
}

describe('queue and transcript stability', () => {

  it('keeps definitely rejected queued steering visibly failed while retaining its source', async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'queue-steer-rejected-'));
    try {
      const chatId = 'chat-rejected-steer';
      const views = new ChatViewStore(() => true);
      const pendingInputs = new PendingUserInputService({
        loadNativeMessages: mock(async () => []),
        getRetainedHistoryMessages: (requestedChatId) => (
          views.getRetainedHistoryMessages(requestedChatId)
        ),
      });
      const queue = new ChatExecutionCoordinator(
        workspaceDir,
        {
          runAgentTurn: mock(async () => undefined),
          captureSteerTarget: mock(() => ({ provider: 'target' })),
          steerInput: mock(async (_chatId, _content, _options, _target, prepareDelivery) => {
            await prepareDelivery();
            return { kind: 'rejected', reason: 'turn-not-steerable' };
          }),
          abortSession: mock(async () => false),
          isChatRunning: mock(() => false),
          waitUntilTurnAbortable: mock(() => Promise.resolve(true)),
        },
        pendingInputs,
        {
          appendMessages: (requestedChatId, messages) => views.appendAfterEnsuringGeneration(
            requestedChatId,
            transcriptLoader(async () => []),
            messages,
          ),
        },
        () => ({}),
        () => true,
        controlRepository(),
      );
      const reservation = queue.reserveDirectTurn(chatId, {
        clientRequestId: 'request-active',
        turnId: 'turn-active',
      });
      const source = await queue.createChatQueueEntry(chatId, 'rejected guidance');
      const target = queue.captureSteerTarget(chatId);
      const settlement = {
        markScheduled: mock(async () => undefined),
        settleSteerSuccess: mock(async () => undefined),
        settleSteerFailure: mock(async () => undefined),
      };

      await expect(queue.deliverAcceptedQueueEntrySteer({
        command: {
          key: 'queue-steer-command',
          chatId,
          clientRequestId: 'request-steer',
          entryId: source.entryId,
        },
        content: 'rejected guidance',
        providerContent: 'rejected guidance',
        clientMessageId: 'message-steer',
        target,
        expectedRevision: 1,
        expectedReorderRevision: 0,
        settlement,
      })).rejects.toMatchObject({
        code: 'STEER_TURN_NOT_STEERABLE',
        deliveryOutcome: 'not-sent',
      });

      expect((await queue.readChatExecutionControl(chatId)).entries).toEqual([
        expect.objectContaining({ id: source.entryId, content: 'rejected guidance', status: 'queued' }),
      ]);
      expect(pendingInputs.listForChat(chatId)).toEqual([
        expect.objectContaining({
          clientRequestId: 'request-steer',
          content: 'rejected guidance',
          deliveryStatus: 'failed',
        }),
      ]);
      expect(views.readPage(chatId, 20).messages).toEqual([
        expect.objectContaining({ message: expect.objectContaining({ content: 'rejected guidance' }) }),
      ]);
      await queue.releaseDirectTurn(reservation);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it('keeps unknown queued steering consumed when a status listener throws a non-error', async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'queue-steer-unknown-listener-'));
    try {
      const chatId = 'chat-unknown-steer-listener';
      const views = new ChatViewStore(() => true);
      const pendingInputs = new PendingUserInputService({
        loadNativeMessages: mock(async () => []),
        getRetainedHistoryMessages: (requestedChatId) => (
          views.getRetainedHistoryMessages(requestedChatId)
        ),
      });
      pendingInputs.store.onStatusUpdated(() => { throw null; });
      const steerInput = mock(async (_chatId, _content, _options, _target, prepareDelivery) => {
        await prepareDelivery();
        throw new Error('provider acknowledgement lost');
      });
      const queue = new ChatExecutionCoordinator(
        workspaceDir,
        {
          runAgentTurn: mock(async () => undefined),
          captureSteerTarget: mock(() => ({ provider: 'target' })),
          steerInput,
          abortSession: mock(async () => false),
          isChatRunning: mock(() => false),
          waitUntilTurnAbortable: mock(() => Promise.resolve(true)),
        },
        pendingInputs,
        {
          appendMessages: (requestedChatId, messages) => views.appendAfterEnsuringGeneration(
            requestedChatId,
            transcriptLoader(async () => []),
            messages,
          ),
        },
        () => ({}),
        () => true,
        controlRepository(),
      );
      const reservation = queue.reserveDirectTurn(chatId, {
        clientRequestId: 'request-active',
        turnId: 'turn-active',
      });
      const source = await queue.createChatQueueEntry(chatId, 'possibly delivered guidance');
      const target = queue.captureSteerTarget(chatId);
      const settlement = {
        markScheduled: mock(async () => undefined),
        settleSteerSuccess: mock(async () => undefined),
        settleSteerFailure: mock(async () => undefined),
      };

      await expect(queue.deliverAcceptedQueueEntrySteer({
        command: {
          key: 'queue-steer-command',
          chatId,
          clientRequestId: 'request-steer',
          entryId: source.entryId,
        },
        content: 'possibly delivered guidance',
        providerContent: 'possibly delivered guidance',
        clientMessageId: 'message-steer',
        target,
        expectedRevision: 1,
        expectedReorderRevision: 0,
        settlement,
      })).rejects.toMatchObject({
        code: 'STEER_OUTCOME_UNKNOWN',
        deliveryOutcome: 'unknown',
      });

      expect(steerInput).toHaveBeenCalledOnce();
      expect((await queue.readChatExecutionControl(chatId)).entries).toEqual([]);
      expect(pendingInputs.listForChat(chatId)).toEqual([
        expect.objectContaining({
          clientRequestId: 'request-steer',
          content: 'possibly delivered guidance',
          deliveryStatus: 'unconfirmed',
        }),
      ]);
      await queue.releaseDirectTurn(reservation);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it('settles an aborted nonblocking direct start before admitting its successor', async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'queue-direct-abort-'));
    const streamResult = deferred();
    const abortStarted = deferred();
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
      const queue = new ChatExecutionCoordinator(
        workspaceDir,
        {
          runAgentTurn: mock(async () => undefined),
          abortSession: mock(async () => {
            abortStarted.resolve();
            return agentSessionId ? runtime.abort(agentSessionId) : false;
          }),
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
        controlRepository(),
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

      const interrupt = queue.interruptActiveTurn('chat-direct');
      await abortStarted.promise;
      streamResult.reject(new Error('request aborted'));
      await expect(interrupt).resolves.toBe('interrupt-requested');
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
      const stopRequested = deferred();
      const coordinator = new UserAbortLifecycleCoordinator(pendingInputs, {
        terminalTimeoutMs: 60_000,
      });
      const queue = new ChatExecutionCoordinator(
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
            transcriptLoader(async () => []),
            messages,
          ),
        },
        () => ({}),
        () => true,
        controlRepository(),
      );
      queue.onSessionStopRequested((requestedChatId, stopId, turn) => {
        coordinator.onStopRequested(requestedChatId, stopId, turn);
        stopRequested.resolve();
      });
      queue.onSessionStopped((requestedChatId, outcome, _intent, stopId) => {
        coordinator.onSessionStopped(
          requestedChatId,
          stopId,
          outcome === 'interrupt-requested',
        );
      });
      queue.onTurnSettled((requestedChatId, turn) => {
        coordinator.onTurnSettled(requestedChatId, turn);
      });

      await queue.createChatQueueEntry(chatId, 'interrupted');
      await queue.createChatQueueEntry(chatId, 'sent next');
      const drain = queue.triggerDrain(chatId);
      await firstTurnStarted.promise;

      const interrupt = queue.interruptActiveTurn(chatId);
      await stopRequested.promise;
      coordinator.onTurnTerminal(chatId, activeTurn);
      firstTurnResult.reject(new Error('interrupted by user'));
      await expect(interrupt).resolves.toBe('interrupt-requested');
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
      const queue = new ChatExecutionCoordinator(
        workspaceDir,
        turnRunner,
        pendingPort,
        {
          appendMessages: (requestedChatId, messages) => views.appendAfterEnsuringGeneration(
            requestedChatId,
            transcriptLoader(async () => []),
            messages,
          ),
        },
        () => ({}),
        () => true,
        controlRepository(),
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
      await expect(stop).resolves.toMatchObject({ outcome: 'interrupt-requested' });
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
      let executionCoordinator = null;
      const ownsExecution = (id) => executionCoordinator?.ownsExecution(id) ?? false;
      const views = new ChatViewStore(ownsExecution);
      const loadNativeMessages = mock(async () => [...nativeMessages]);
      const pendingInputs = new PendingUserInputService({
        loadNativeMessages,
        getRetainedHistoryMessages: (requestedChatId) => (
          views.getRetainedHistoryMessages(requestedChatId)
        ),
      });
      let turnCount = 0;
      const queue = new ChatExecutionCoordinator(
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
            transcriptLoader(async () => [...nativeMessages]),
            messages,
          ),
        },
        () => ({}),
        () => true,
        controlRepository(),
      );
      executionCoordinator = queue;
      const reloader = new ChatNativeReloader(
        views,
        { loadSnapshot: snapshotLoader(loadNativeMessages) },
        ownsExecution,
      );

      await Promise.all([
        queue.createChatQueueEntry(chatId, 'first'),
        queue.createChatQueueEntry(chatId, 'second'),
        queue.createChatQueueEntry(chatId, 'third'),
      ]);
      const drain = queue.triggerDrain(chatId);
      await firstTurnStarted.promise;

      expect(ownsExecution(chatId)).toBe(true);
      await expect(reloader.reloadFromNative(chatId, 'manual-reload')).rejects.toBeInstanceOf(
        ChatRunningError,
      );

      releaseFirstTurn.resolve();
      await drain;

      expect(ownsExecution(chatId)).toBe(false);
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

  it('drops queue work and command receipts after restart', async () => {
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
      const queue = new ChatExecutionCoordinator(
        workspaceDir,
        ...queueDeps,
        controlRepository('server-instance-a'),
      );
      await queue.createChatQueueEntry(chatId, 'discard on restart');
      await queue.popNextChat(chatId);

      const ledgerInput = {
        commandType: 'agent-run',
        chatId,
        clientRequestId: 'request-restart',
        payload: { chatId, command: 'discard on restart' },
      };
      const ledger = new CommandLedger(workspaceDir);
      const accepted = await ledger.accept(ledgerInput);
      expect(accepted.kind).toBe('accepted');
      await ledger.update(accepted.record.key, { status: 'scheduled' });

      const restartedQueue = new ChatExecutionCoordinator(
        workspaceDir,
        ...queueDeps,
        controlRepository('server-instance-b'),
      );
      const restartedControl = await restartedQueue.readChatExecutionControl(chatId);
      expect(restartedControl.serverInstanceId).toBe('server-instance-b');
      expect(restartedControl.entries).toEqual([]);

      const restartedLedger = new CommandLedger(workspaceDir);
      const duplicate = await restartedLedger.accept(ledgerInput);
      expect(duplicate).toMatchObject({ kind: 'accepted', record: { status: 'accepted' } });
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });
});
