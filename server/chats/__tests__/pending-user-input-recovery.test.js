import { describe, expect, it, mock } from 'bun:test';

import { UserMessage } from '../../../common/chat-types.js';
import { ChatViewStore } from '../chat-view-store.js';
import { PendingUserInputRecoveryCoordinator } from '../pending-user-input-recovery.js';
import { PendingUserInputService } from '../pending-user-input-service.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function recoveredRecord(clientRequestId, chatId = 'chat-1') {
  return {
    key: `agent-run:${chatId}:${clientRequestId}`,
    commandType: 'agent-run',
    chatId,
    clientRequestId,
    payloadHash: `hash-${clientRequestId}`,
    payload: { command: `content-${clientRequestId}` },
    status: 'failed',
    acceptedAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:01.000Z',
    pendingInputRecovery: 'required',
  };
}

describe('PendingUserInputRecoveryCoordinator', () => {
  it('settles a restart-interrupted active input already committed to the durable queue', async () => {
    const record = {
      ...recoveredRecord('req-queued'),
      key: 'active-input:chat-1:req-queued',
      commandType: 'active-input',
      entryId: 'entry-queued',
    };
    const ledger = {
      listPendingInputRecoveries: mock(async () => [record]),
      settlePendingInputRecovery: mock(async () => true),
      settleQueuedInputHandoff: mock(async () => true),
    };
    const pendingInputs = new PendingUserInputService({
      loadNativeMessages: mock(async () => []),
      getRetainedHistoryMessages: mock(() => []),
    });
    const coordinator = new PendingUserInputRecoveryCoordinator({
      ledger,
      pendingInputs,
      queuedInputHandoffs: {
        hasAppliedQueueCreateCommand: mock(async () => true),
      },
      chatExists: () => true,
      onRecoveredChatSettled: mock(async () => undefined),
    });

    const result = await coordinator.restore();

    expect(result).toEqual({ restored: 0, discardedMissingChat: 0, restoredChatIds: [] });
    expect(ledger.settleQueuedInputHandoff).toHaveBeenCalledWith(record.key, 'entry-queued');
    expect(pendingInputs.listForChat('chat-1')).toEqual([]);
  });

  it('fails closed when an applied queue receipt cannot settle the matching ledger record', async () => {
    const record = {
      ...recoveredRecord('req-queued'),
      key: 'active-input:chat-1:req-queued',
      commandType: 'active-input',
      entryId: 'entry-queued',
    };
    const pendingInputs = new PendingUserInputService({
      loadNativeMessages: mock(async () => []),
      getRetainedHistoryMessages: mock(() => []),
    });
    const coordinator = new PendingUserInputRecoveryCoordinator({
      ledger: {
        listPendingInputRecoveries: mock(async () => [record]),
        settlePendingInputRecovery: mock(async () => true),
        settleQueuedInputHandoff: mock(async () => false),
      },
      pendingInputs,
      queuedInputHandoffs: {
        hasAppliedQueueCreateCommand: mock(async () => true),
      },
      chatExists: () => true,
      onRecoveredChatSettled: mock(async () => undefined),
    });

    await expect(coordinator.restore()).rejects.toThrow(
      'Could not settle queued active-input handoff for chat-1',
    );
    expect(pendingInputs.listForChat('chat-1')).toEqual([]);
  });

  it('buffers final recovered-cohort settlement until the sink is activated', async () => {
    const onRecoveredChatSettled = mock(async () => undefined);
    const ledger = {
      listPendingInputRecoveries: mock(async () => [recoveredRecord('req-1')]),
      settlePendingInputRecovery: mock(async () => true),
    };
    const pendingInputs = new PendingUserInputService({
      loadNativeMessages: mock(async () => []),
      getRetainedHistoryMessages: mock(() => []),
    });
    const coordinator = new PendingUserInputRecoveryCoordinator({
      ledger,
      pendingInputs,
      chatExists: () => true,
      onRecoveredChatSettled,
    });
    coordinator.start();
    await coordinator.restore();

    pendingInputs.store.clear('chat-1', 'req-1', 'persisted');
    await coordinator.waitForSettlements('chat-1');
    expect(onRecoveredChatSettled).not.toHaveBeenCalled();

    await coordinator.activateRecoveredChatSettlement();
    expect(onRecoveredChatSettled).toHaveBeenCalledTimes(1);
    expect(onRecoveredChatSettled).toHaveBeenCalledWith('chat-1');
  });

  it('notifies only after the final request in a restored chat cohort settles', async () => {
    const onRecoveredChatSettled = mock(async () => undefined);
    const ledger = {
      listPendingInputRecoveries: mock(async () => [
        recoveredRecord('req-1'),
        recoveredRecord('req-2'),
      ]),
      settlePendingInputRecovery: mock(async () => true),
    };
    const pendingInputs = new PendingUserInputService({
      loadNativeMessages: mock(async () => []),
      getRetainedHistoryMessages: mock(() => []),
    });
    const coordinator = new PendingUserInputRecoveryCoordinator({
      ledger,
      pendingInputs,
      chatExists: () => true,
      onRecoveredChatSettled,
    });
    coordinator.start();
    await coordinator.restore();
    await coordinator.activateRecoveredChatSettlement();

    pendingInputs.store.clear('chat-1', 'req-1', 'persisted');
    await coordinator.waitForSettlements('chat-1');
    expect(onRecoveredChatSettled).not.toHaveBeenCalled();

    pendingInputs.store.clear('chat-1', 'req-2', 'persisted');
    await coordinator.waitForSettlements('chat-1');
    expect(onRecoveredChatSettled).toHaveBeenCalledTimes(1);
  });

  it('does not notify recovery settlement when the ledger write fails', async () => {
    const onRecoveredChatSettled = mock(async () => undefined);
    const ledger = {
      listPendingInputRecoveries: mock(async () => [recoveredRecord('req-1')]),
      settlePendingInputRecovery: mock(async () => {
        throw new Error('ledger unavailable');
      }),
    };
    const pendingInputs = new PendingUserInputService({
      loadNativeMessages: mock(async () => []),
      getRetainedHistoryMessages: mock(() => []),
    });
    const coordinator = new PendingUserInputRecoveryCoordinator({
      ledger,
      pendingInputs,
      chatExists: () => true,
      onRecoveredChatSettled,
    });
    coordinator.start();
    await coordinator.restore();
    await coordinator.activateRecoveredChatSettlement();

    pendingInputs.store.clear('chat-1', 'req-1', 'persisted');
    await expect(coordinator.waitForSettlements('chat-1')).rejects.toThrow('ledger unavailable');
    expect(onRecoveredChatSettled).not.toHaveBeenCalled();
  });

  it('keeps reconciliation and shutdown waiting for durable ledger settlement', async () => {
    const settlement = deferred();
    const ledger = {
      listPendingInputRecoveries: mock(async () => [{
        key: 'agent-run:chat-1:req-1',
        commandType: 'agent-run',
        chatId: 'chat-1',
        clientRequestId: 'req-1',
        payloadHash: 'hash',
        payload: { command: 'persisted before restart' },
        status: 'failed',
        acceptedAt: '2026-06-01T00:00:00.000Z',
        updatedAt: '2026-06-01T00:00:01.000Z',
        pendingInputRecovery: 'required',
      }]),
      settlePendingInputRecovery: mock(() => settlement.promise),
    };
    const pendingInputs = new PendingUserInputService({
      loadNativeMessages: mock(async () => [new UserMessage(
        '2026-06-01T00:00:00.100Z',
        'persisted before restart',
        undefined,
        { clientRequestId: 'req-1' },
      )]),
      getRetainedHistoryMessages: mock(() => []),
    });
    const coordinator = new PendingUserInputRecoveryCoordinator({
      ledger,
      pendingInputs,
      chatExists: () => true,
      onRecoveredChatSettled: () => Promise.resolve(),
    });
    coordinator.start();
    await coordinator.restore();

    let reconciliationFinished = false;
    const reconciliation = coordinator.reconcileChat('chat-1').then(() => {
      reconciliationFinished = true;
    });
    const shutdownWait = coordinator.waitForBackgroundTasks();
    while (ledger.settlePendingInputRecovery.mock.calls.length === 0) {
      await Promise.resolve();
    }

    expect(reconciliationFinished).toBe(false);
    settlement.resolve(true);
    await Promise.all([reconciliation, shutdownWait]);

    expect(reconciliationFinished).toBe(true);
    expect(ledger.settlePendingInputRecovery).toHaveBeenCalledWith('chat-1', 'req-1');
  });

  it('keeps failed ledger settlement retryable on the next reconciliation', async () => {
    const firstSettlement = deferred();
    const settlementErrors = mock(() => undefined);
    const ledger = {
      listPendingInputRecoveries: mock(async () => [{
        key: 'agent-run:chat-1:req-1',
        commandType: 'agent-run',
        chatId: 'chat-1',
        clientRequestId: 'req-1',
        payloadHash: 'hash',
        payload: { command: 'persisted before restart' },
        status: 'failed',
        acceptedAt: '2026-06-01T00:00:00.000Z',
        updatedAt: '2026-06-01T00:00:01.000Z',
        pendingInputRecovery: 'required',
      }]),
      settlePendingInputRecovery: mock(() => firstSettlement.promise),
    };
    const pendingInputs = new PendingUserInputService({
      loadNativeMessages: mock(async () => [new UserMessage(
        '2026-06-01T00:00:00.100Z',
        'persisted before restart',
        undefined,
        { clientRequestId: 'req-1' },
      )]),
      getRetainedHistoryMessages: mock(() => []),
    });
    const coordinator = new PendingUserInputRecoveryCoordinator({
      ledger,
      pendingInputs,
      chatExists: () => true,
      onRecoveredChatSettled: () => Promise.resolve(),
    }, settlementErrors);
    coordinator.start();
    await coordinator.restore();

    const firstReconciliation = coordinator.reconcileChat('chat-1');
    while (ledger.settlePendingInputRecovery.mock.calls.length === 0) {
      await Promise.resolve();
    }
    firstSettlement.reject(new Error('temporary ledger write failure'));
    await expect(firstReconciliation).rejects.toThrow(
      'temporary ledger write failure',
    );
    const callsAfterFailure = ledger.settlePendingInputRecovery.mock.calls.length;
    ledger.settlePendingInputRecovery.mockImplementation(async () => true);
    await coordinator.reconcileChat('chat-1');

    expect(ledger.settlePendingInputRecovery).toHaveBeenCalledTimes(callsAfterFailure + 1);
    expect(settlementErrors).toHaveBeenCalledTimes(1);
    await expect(coordinator.waitForBackgroundTasks()).resolves.toBeUndefined();
  });

  it('installs a strict native snapshot before clearing restored delivery state', async () => {
    const record = {
      key: 'agent-run:chat-1:req-1',
      commandType: 'agent-run',
      chatId: 'chat-1',
      clientRequestId: 'req-1',
      payloadHash: 'hash',
      payload: { command: 'persisted before restart' },
      status: 'failed',
      acceptedAt: '2026-06-01T00:00:00.000Z',
      updatedAt: '2026-06-01T00:00:01.000Z',
      pendingInputRecovery: 'required',
    };
    const ledger = {
      listPendingInputRecoveries: mock(async () => [record]),
      settlePendingInputRecovery: mock(async () => true),
    };
    const pendingInputs = new PendingUserInputService({
      loadNativeMessages: mock(async () => [new UserMessage(
        '2026-06-01T00:00:00.100Z',
        'persisted before restart',
        undefined,
        { clientRequestId: 'req-1' },
      )]),
      getRetainedHistoryMessages: mock(() => []),
    });
    const installSnapshot = mock()
      .mockRejectedValueOnce(new Error('view unavailable'))
      .mockResolvedValueOnce(undefined);
    const coordinator = new PendingUserInputRecoveryCoordinator({
      ledger,
      pendingInputs,
      nativeSnapshots: { reconcileNativeSnapshot: installSnapshot },
      chatExists: () => true,
      onRecoveredChatSettled: () => Promise.resolve(),
    });
    coordinator.start();
    await coordinator.restore();

    await expect(coordinator.reconcileChat('chat-1')).rejects.toThrow('view unavailable');
    expect(pendingInputs.listForChat('chat-1')).toHaveLength(1);
    expect(ledger.settlePendingInputRecovery).not.toHaveBeenCalled();

    await expect(coordinator.reconcileChat('chat-1')).resolves.toEqual({
      nativeSnapshotApplied: true,
    });
    expect(pendingInputs.listForChat('chat-1')).toEqual([]);
    expect(ledger.settlePendingInputRecovery).toHaveBeenCalledWith('chat-1', 'req-1');
  });

  it('keeps restored delivery state when execution starts during the native read', async () => {
    const nativeLoad = deferred();
    const nativeMessage = new UserMessage(
      '2026-06-01T00:00:00.100Z',
      'persisted before restart',
      undefined,
      { clientRequestId: 'req-1' },
    );
    const loadNativeMessages = mock()
      .mockImplementationOnce(() => nativeLoad.promise)
      .mockResolvedValueOnce([nativeMessage]);
    const ledger = {
      listPendingInputRecoveries: mock(async () => [{
        key: 'agent-run:chat-1:req-1',
        commandType: 'agent-run',
        chatId: 'chat-1',
        clientRequestId: 'req-1',
        payloadHash: 'hash',
        payload: { command: 'persisted before restart' },
        status: 'failed',
        acceptedAt: '2026-06-01T00:00:00.000Z',
        updatedAt: '2026-06-01T00:00:01.000Z',
        pendingInputRecovery: 'required',
      }]),
      settlePendingInputRecovery: mock(async () => true),
    };
    const pendingInputs = new PendingUserInputService({
      loadNativeMessages,
      getRetainedHistoryMessages: mock(() => []),
    });
    let active = false;
    const chatViews = new ChatViewStore(() => active);
    const coordinator = new PendingUserInputRecoveryCoordinator({
      ledger,
      pendingInputs,
      nativeSnapshots: chatViews,
      chatExists: () => true,
      onRecoveredChatSettled: () => Promise.resolve(),
    });
    coordinator.start();
    await coordinator.restore();

    const reconciliation = coordinator.reconcileChat('chat-1');
    while (loadNativeMessages.mock.calls.length === 0) await Promise.resolve();
    active = true;
    nativeLoad.resolve([nativeMessage]);

    await expect(reconciliation).rejects.toMatchObject({ code: 'CHAT_RUNNING' });
    expect(pendingInputs.listForChat('chat-1')).toHaveLength(1);
    expect(ledger.settlePendingInputRecovery).not.toHaveBeenCalled();
    expect(chatViews.readPage('chat-1', 20)).toBeNull();

    active = false;
    await expect(coordinator.reconcileChat('chat-1')).resolves.toEqual({
      nativeSnapshotApplied: true,
    });
    expect(pendingInputs.listForChat('chat-1')).toEqual([]);
    expect(chatViews.readPage('chat-1', 20)?.messages.map((entry) => entry.message.content))
      .toEqual(['persisted before restart']);
  });

  it('does not make restored reconciliation wait for an unrelated live settlement', async () => {
    const liveSettlement = deferred();
    const ledger = {
      listPendingInputRecoveries: mock(async () => [{
        key: 'agent-run:chat-1:req-restored',
        commandType: 'agent-run',
        chatId: 'chat-1',
        clientRequestId: 'req-restored',
        payloadHash: 'hash',
        payload: { command: 'persisted before restart' },
        status: 'failed',
        acceptedAt: '2026-06-01T00:00:00.000Z',
        updatedAt: '2026-06-01T00:00:01.000Z',
        pendingInputRecovery: 'required',
      }]),
      settlePendingInputRecovery: mock(async (_chatId, clientRequestId) => {
        if (clientRequestId === 'req-live') return liveSettlement.promise;
        return true;
      }),
    };
    const pendingInputs = new PendingUserInputService({
      loadNativeMessages: mock(async () => [new UserMessage(
        '2026-06-01T00:00:00.100Z',
        'persisted before restart',
        undefined,
        { clientRequestId: 'req-restored' },
      )]),
      getRetainedHistoryMessages: mock(() => []),
    });
    const coordinator = new PendingUserInputRecoveryCoordinator({
      ledger,
      pendingInputs,
      chatExists: () => true,
      onRecoveredChatSettled: () => Promise.resolve(),
    });
    coordinator.start();
    await coordinator.restore();
    await pendingInputs.register('chat-1', 'live input', { clientRequestId: 'req-live' });
    pendingInputs.store.clear('chat-1', 'req-live', 'persisted');

    await expect(coordinator.reconcileChat('chat-1')).resolves.toEqual({
      nativeSnapshotApplied: false,
    });
    let backgroundFinished = false;
    const backgroundWait = coordinator.waitForBackgroundTasks().then(() => {
      backgroundFinished = true;
    });
    await Promise.resolve();

    expect(backgroundFinished).toBe(false);
    liveSettlement.resolve(true);
    await backgroundWait;
  });

  it('waits for one chat settlement without blocking on another chat', async () => {
    const firstSettlement = deferred();
    const secondSettlement = deferred();
    const ledger = {
      listPendingInputRecoveries: mock(async () => []),
      settlePendingInputRecovery: mock((_chatId, clientRequestId) => (
        clientRequestId === 'req-first' ? firstSettlement.promise : secondSettlement.promise
      )),
    };
    const pendingInputs = new PendingUserInputService({
      loadNativeMessages: mock(async () => []),
      getRetainedHistoryMessages: mock(() => []),
    });
    const coordinator = new PendingUserInputRecoveryCoordinator({
      ledger,
      pendingInputs,
      chatExists: () => true,
      onRecoveredChatSettled: () => Promise.resolve(),
    });
    coordinator.start();
    await pendingInputs.register('chat-1', 'first', { clientRequestId: 'req-first' });
    await pendingInputs.register('chat-2', 'second', { clientRequestId: 'req-second' });
    pendingInputs.store.clear('chat-1', 'req-first', 'persisted');
    pendingInputs.store.clear('chat-2', 'req-second', 'persisted');

    let firstFinished = false;
    const firstWait = coordinator.waitForSettlements('chat-1').then(() => {
      firstFinished = true;
    });
    await Promise.resolve();
    expect(firstFinished).toBe(false);

    firstSettlement.resolve(true);
    await firstWait;
    expect(firstFinished).toBe(true);

    let secondFinished = false;
    const secondWait = coordinator.waitForSettlements('chat-2').then(() => {
      secondFinished = true;
    });
    await Promise.resolve();
    expect(secondFinished).toBe(false);
    secondSettlement.resolve(true);
    await secondWait;
  });

  it('keeps a terminal settlement retryable after a transient failure', async () => {
    const settlementError = new Error('ledger unavailable');
    const ledger = {
      listPendingInputRecoveries: mock(async () => []),
      settlePendingInputRecovery: mock()
        .mockRejectedValueOnce(settlementError)
        .mockResolvedValueOnce(true),
    };
    const pendingInputs = new PendingUserInputService({
      loadNativeMessages: mock(async () => []),
      getRetainedHistoryMessages: mock(() => []),
    });
    const coordinator = new PendingUserInputRecoveryCoordinator({
      ledger,
      pendingInputs,
      chatExists: () => true,
      onRecoveredChatSettled: () => Promise.resolve(),
    });
    coordinator.start();
    await pendingInputs.register('chat-1', 'retry', { clientRequestId: 'req-retry' });
    pendingInputs.store.clear('chat-1', 'req-retry', 'persisted');

    await expect(coordinator.waitForSettlements('chat-1')).rejects.toBe(settlementError);
    await expect(coordinator.waitForSettlements('chat-1')).resolves.toBeUndefined();
    expect(ledger.settlePendingInputRecovery).toHaveBeenCalledTimes(2);
  });

  it('waits for every settlement before reporting a settlement failure', async () => {
    const heldSettlement = deferred();
    const ledger = {
      listPendingInputRecoveries: mock(async () => []),
      settlePendingInputRecovery: mock(async (_chatId, clientRequestId) => {
        if (clientRequestId === 'req-failed') throw new Error('ledger unavailable');
        return heldSettlement.promise;
      }),
    };
    const pendingInputs = new PendingUserInputService({
      loadNativeMessages: mock(async () => []),
      getRetainedHistoryMessages: mock(() => []),
    });
    const coordinator = new PendingUserInputRecoveryCoordinator({
      ledger,
      pendingInputs,
      chatExists: () => true,
      onRecoveredChatSettled: () => Promise.resolve(),
    });
    coordinator.start();
    await pendingInputs.register('chat-1', 'failed', { clientRequestId: 'req-failed' });
    await pendingInputs.register('chat-1', 'held', { clientRequestId: 'req-held' });
    pendingInputs.store.clear('chat-1', 'req-failed', 'persisted');
    pendingInputs.store.clear('chat-1', 'req-held', 'persisted');

    let waitFinished = false;
    const wait = coordinator.waitForBackgroundTasks().then(
      () => {
        waitFinished = true;
        return null;
      },
      (error) => {
        waitFinished = true;
        return error;
      },
    );
    await Promise.resolve();
    expect(waitFinished).toBe(false);

    heldSettlement.resolve(true);
    await expect(wait).resolves.toMatchObject({ message: 'ledger unavailable' });
    expect(waitFinished).toBe(true);
  });

  it('drains a settlement added while background draining is in progress', async () => {
    const firstSettlement = deferred();
    const secondSettlement = deferred();
    const ledger = {
      listPendingInputRecoveries: mock(async () => []),
      settlePendingInputRecovery: mock((_chatId, clientRequestId) => (
        clientRequestId === 'req-first' ? firstSettlement.promise : secondSettlement.promise
      )),
    };
    const pendingInputs = new PendingUserInputService({
      loadNativeMessages: mock(async () => []),
      getRetainedHistoryMessages: mock(() => []),
    });
    const coordinator = new PendingUserInputRecoveryCoordinator({
      ledger,
      pendingInputs,
      chatExists: () => true,
      onRecoveredChatSettled: () => Promise.resolve(),
    });
    coordinator.start();
    await pendingInputs.register('chat-1', 'first', { clientRequestId: 'req-first' });
    await pendingInputs.register('chat-1', 'second', { clientRequestId: 'req-second' });
    pendingInputs.store.clear('chat-1', 'req-first', 'persisted');

    let waitFinished = false;
    const wait = coordinator.waitForBackgroundTasks().then(() => {
      waitFinished = true;
    });
    while (ledger.settlePendingInputRecovery.mock.calls.length === 0) await Promise.resolve();
    pendingInputs.store.clear('chat-1', 'req-second', 'persisted');
    firstSettlement.resolve(true);
    while (ledger.settlePendingInputRecovery.mock.calls.length < 2) await Promise.resolve();

    expect(waitFinished).toBe(false);
    secondSettlement.resolve(true);
    await wait;
    expect(waitFinished).toBe(true);
    expect(ledger.settlePendingInputRecovery.mock.calls.map((call) => call[1])).toEqual([
      'req-first',
      'req-second',
    ]);
  });

  it('rejects reconciliation producers after shutdown draining begins', async () => {
    const heldSettlement = deferred();
    const ledger = {
      listPendingInputRecoveries: mock(async () => []),
      settlePendingInputRecovery: mock(() => heldSettlement.promise),
    };
    const pendingInputs = new PendingUserInputService({
      loadNativeMessages: mock(async () => []),
      getRetainedHistoryMessages: mock(() => []),
    });
    const coordinator = new PendingUserInputRecoveryCoordinator({
      ledger,
      pendingInputs,
      chatExists: () => true,
      onRecoveredChatSettled: () => Promise.resolve(),
    });
    coordinator.start();
    await pendingInputs.register('chat-1', 'held', { clientRequestId: 'req-held' });
    pendingInputs.store.clear('chat-1', 'req-held', 'persisted');

    const wait = coordinator.waitForBackgroundTasks();
    await expect(coordinator.reconcileChat('chat-2')).rejects.toThrow(
      'Pending-input recovery is shutting down',
    );

    heldSettlement.resolve(true);
    await expect(wait).resolves.toBeUndefined();
  });
});
