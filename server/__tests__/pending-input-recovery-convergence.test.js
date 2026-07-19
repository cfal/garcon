import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';

import { UserMessage } from '../../common/chat-types.js';
import { PendingUserInputRecoveryCoordinator } from '../chats/pending-user-input-recovery.js';
import { PendingUserInputService } from '../chats/pending-user-input-service.js';
import { CommandLedger } from '../commands/command-ledger.js';
import { ChatExecutionCoordinator } from '../chat-execution/chat-execution-coordinator.js';

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

async function restorePendingInputs(ledger, pendingInputs, onRecoveredChatSettled) {
  const coordinator = new PendingUserInputRecoveryCoordinator({
    ledger,
    pendingInputs,
    chatExists: () => true,
    onRecoveredChatSettled,
  });
  coordinator.start();
  const result = await coordinator.restore();
  return { coordinator, result };
}

function createQueue(pendingInputs) {
  return new ChatExecutionCoordinator(
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
    const firstQueue = createQueue(pendingInputs);
    const firstRecovery = await restorePendingInputs(
      new CommandLedger(workspaceDir),
      pendingInputs,
      async (settledChatId) => {
        await firstQueue.dropRecoveredInputContinuation(settledChatId);
      },
    );
    await firstQueue.recoverChatExecutionControls(new Set(firstRecovery.result.restoredChatIds));
    await firstRecovery.coordinator.activateRecoveredChatSettlement();
    expect((await firstQueue.readChatExecutionControl(chatId)).recoveredInputContinuation)
      .toMatchObject({ id: expect.any(String) });

    await firstRecovery.coordinator.reconcileChat(chatId);

    expect(pendingInputs.listForChat(chatId)).toEqual([]);
    expect((await firstQueue.readChatExecutionControl(chatId)).recoveredInputContinuation).toBeNull();
    await expect(
      new CommandLedger(workspaceDir).listPendingInputRecoveries(),
    ).resolves.toEqual([]);

    const restartedPendingInputs = createPendingInputs(nativeMessages);
    const secondRecovery = await restorePendingInputs(
      new CommandLedger(workspaceDir),
      restartedPendingInputs,
      () => Promise.resolve(),
    );
    const secondQueue = createQueue(restartedPendingInputs);
    await secondQueue.recoverChatExecutionControls(new Set(secondRecovery.result.restoredChatIds));

    expect(secondRecovery.result.restored).toBe(0);
    expect((await secondQueue.readChatExecutionControl(chatId)).recoveredInputContinuation).toBeNull();
  });

  it('reinstalls continuation after process-local consume when native persistence remains unproven', async () => {
    const chatId = 'chat-unmatched';
    await createLegacyFailedInput(chatId, 'req-unmatched', 'not persisted before restart');
    const pendingInputs = createPendingInputs([]);
    const firstQueue = createQueue(pendingInputs);
    const firstRecovery = await restorePendingInputs(
      new CommandLedger(workspaceDir),
      pendingInputs,
      () => Promise.resolve(),
    );
    await firstQueue.recoverChatExecutionControls(new Set(firstRecovery.result.restoredChatIds));
    const firstContinuation = (await firstQueue.readChatExecutionControl(chatId))
      .recoveredInputContinuation;

    await firstRecovery.coordinator.reconcileChat(chatId);
    const reservation = firstQueue.reserveDirectTurn(chatId);
    await firstQueue.consumeRecoveredInputContinuationForDirectTurn(reservation);
    await firstQueue.releaseDirectTurn(reservation);

    const restartedPendingInputs = createPendingInputs([]);
    const secondRecovery = await restorePendingInputs(
      new CommandLedger(workspaceDir),
      restartedPendingInputs,
      () => Promise.resolve(),
    );
    const secondQueue = createQueue(restartedPendingInputs);
    await secondQueue.recoverChatExecutionControls(new Set(secondRecovery.result.restoredChatIds));

    expect(secondRecovery.result.restored).toBe(1);
    expect(restartedPendingInputs.listForChat(chatId)).toMatchObject([
      { clientRequestId: 'req-unmatched', deliveryStatus: 'unconfirmed' },
    ]);
    const secondContinuation = (await secondQueue.readChatExecutionControl(chatId))
      .recoveredInputContinuation;
    expect(secondContinuation).toMatchObject({ id: expect.any(String) });
    expect(secondContinuation.id).not.toBe(firstContinuation.id);
  });
});
