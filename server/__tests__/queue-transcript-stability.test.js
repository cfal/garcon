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
import {
  CommandLedger,
  SERVER_RESTART_INTERRUPTED_ERROR_CODE,
} from '../commands/command-ledger.js';

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('queue and transcript stability', () => {
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
      expect((await queue.readChatQueue(chatId)).entries).toEqual([]);
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
        },
        {
          register: mock(async () => undefined),
          discard: mock(() => true),
          markFailed: mock(() => true),
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
      await restartedQueue.recoverStaleChatQueues();
      const recoveredQueue = await restartedQueue.readChatQueue(chatId);
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
