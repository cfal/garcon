import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';

import { UserMessage } from '../../common/chat-types.js';
import { PendingUserInputRecoveryCoordinator } from '../chats/pending-user-input-recovery.js';
import { PendingUserInputService } from '../chats/pending-user-input-service.js';
import { CommandLedger } from '../commands/command-ledger.js';
import { QueueManager } from '../queue.js';

let workspaceDir;

beforeEach(async () => {
  workspaceDir = path.join(os.tmpdir(), `garcon-pending-convergence-${randomUUID()}`);
  await fs.mkdir(workspaceDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(workspaceDir, { recursive: true, force: true });
});

async function createLegacyFailedInput(chatId, clientRequestId, content) {
  const ledger = new CommandLedger(workspaceDir);
  const accepted = await ledger.accept({
    commandType: 'agent-run',
    chatId,
    clientRequestId,
    payload: { chatId, clientRequestId, command: content, images: [] },
  });
  expect(accepted.kind).toBe('accepted');
  await ledger.update(accepted.record.key, {
    status: 'failed',
    error: 'legacy provider failure',
  });
}

function createPendingInputs(nativeMessages) {
  return new PendingUserInputService({
    loadNativeMessages: mock(async () => nativeMessages),
    getRetainedHistoryMessages: mock(() => []),
  });
}

async function restorePendingInputs(ledger, pendingInputs) {
  const coordinator = new PendingUserInputRecoveryCoordinator({
    ledger,
    pendingInputs,
    chatExists: () => true,
  });
  coordinator.start();
  const result = await coordinator.restore();
  return { coordinator, result };
}

function createQueue(pendingInputs) {
  return new QueueManager(
    workspaceDir,
    {
      runAgentTurn: mock(async () => undefined),
      abortSession: mock(async () => false),
      isChatRunning: mock(() => false),
      waitUntilTurnAbortable: mock(async () => true),
    },
    pendingInputs,
    {
      appendMessages: mock(async () => ({ generationId: 'generation-1', messages: [] })),
    },
    () => ({}),
    () => true,
  );
}

describe('pending input restart recovery convergence', () => {
  it('does not reinstall a resumed pause after native evidence settles the recovery', async () => {
    const chatId = 'chat-persisted';
    const clientRequestId = 'req-persisted';
    const content = 'persisted before restart';
    await createLegacyFailedInput(chatId, clientRequestId, content);
    const nativeMessages = [new UserMessage(
      new Date().toISOString(),
      content,
      undefined,
      { clientRequestId },
    )];
    const pendingInputs = createPendingInputs(nativeMessages);
    const firstRecovery = await restorePendingInputs(new CommandLedger(workspaceDir), pendingInputs);
    const firstQueue = createQueue(pendingInputs);
    await firstQueue.recoverStaleChatQueues(new Set(firstRecovery.result.restoredChatIds));
    const firstPause = (await firstQueue.readChatQueue(chatId)).pause;
    expect(firstPause).toMatchObject({ kind: 'recovered-unconfirmed-input' });

    await firstRecovery.coordinator.reconcileChat(chatId);
    await firstQueue.resumeChatQueue(chatId, firstPause.id);

    expect(pendingInputs.listForChat(chatId)).toEqual([]);
    await expect(
      new CommandLedger(workspaceDir).listPendingInputRecoveries(),
    ).resolves.toEqual([]);

    const restartedPendingInputs = createPendingInputs(nativeMessages);
    const secondRecovery = await restorePendingInputs(
      new CommandLedger(workspaceDir),
      restartedPendingInputs,
    );
    const secondQueue = createQueue(restartedPendingInputs);
    await secondQueue.recoverStaleChatQueues(new Set(secondRecovery.result.restoredChatIds));

    expect(secondRecovery.result.restored).toBe(0);
    expect((await secondQueue.readChatQueue(chatId)).pause).toBeNull();
  });

  it('reinstalls the gate after Resume when native persistence remains unproven', async () => {
    const chatId = 'chat-unmatched';
    await createLegacyFailedInput(chatId, 'req-unmatched', 'not persisted before restart');
    const pendingInputs = createPendingInputs([]);
    const firstRecovery = await restorePendingInputs(new CommandLedger(workspaceDir), pendingInputs);
    const firstQueue = createQueue(pendingInputs);
    await firstQueue.recoverStaleChatQueues(new Set(firstRecovery.result.restoredChatIds));
    const firstPause = (await firstQueue.readChatQueue(chatId)).pause;

    await firstRecovery.coordinator.reconcileChat(chatId);
    await firstQueue.resumeChatQueue(chatId, firstPause.id);

    const restartedPendingInputs = createPendingInputs([]);
    const secondRecovery = await restorePendingInputs(
      new CommandLedger(workspaceDir),
      restartedPendingInputs,
    );
    const secondQueue = createQueue(restartedPendingInputs);
    await secondQueue.recoverStaleChatQueues(new Set(secondRecovery.result.restoredChatIds));

    expect(secondRecovery.result.restored).toBe(1);
    expect(restartedPendingInputs.listForChat(chatId)).toMatchObject([
      { clientRequestId: 'req-unmatched', deliveryStatus: 'unconfirmed' },
    ]);
    expect((await secondQueue.readChatQueue(chatId)).pause).toMatchObject({
      kind: 'recovered-unconfirmed-input',
    });
  });
});
