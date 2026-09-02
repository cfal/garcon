import { describe, expect, it, mock } from 'bun:test';
import crypto from 'node:crypto';
import { AgentHandoffService } from '../agent-handoff-service.ts';
import { LedgerFencedError } from '../../ledger/errors.ts';

function envelope(ownerId) {
  return { ownerId, schemaVersion: 1, values: {} };
}

function sourceChat() {
  return {
    agentId: 'source-agent',
    agentSessionId: 'source-session',
    nativeSession: null,
    nativeSeedReceipt: null,
    carryOverSegments: [],
    carryOverMigrationQuarantine: null,
    agentOwnershipEpoch: 'source-epoch',
    agentSettingsById: { 'source-agent': envelope('source-agent') },
    projectPath: '/workspace/project',
    tags: [],
    model: 'source-model',
    apiProviderId: null,
    modelEndpointId: null,
    modelProtocol: null,
    permissionMode: 'default',
    thinkingMode: 'none',
  };
}

function target() {
  return {
    agentId: 'target-agent',
    model: 'target-model',
    apiProviderId: null,
    modelEndpointId: null,
    modelProtocol: null,
    permissionMode: 'default',
    thinkingMode: 'none',
    agentSettings: envelope('target-agent'),
  };
}

function handoff(agentId = 'target-agent') {
  return {
    target: {
      agentId,
      model: agentId === 'target-agent' ? 'target-model' : `${agentId}-model`,
      permissionMode: 'default',
      thinkingMode: 'none',
      agentSettings: envelope(agentId),
    },
    expectedAgentOwnershipEpoch: 'source-epoch',
  };
}

function context() {
  return {
    signal: new AbortController().signal,
    assertAdmissionActive: mock(() => {}),
  };
}

function installFakeTimers() {
  const timers = [];
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = mock((callback, delay) => {
    const timer = {
      callback,
      delay,
      fired: false,
      cleared: false,
      unref: mock(() => undefined),
    };
    timers.push(timer);
    return timer;
  });
  globalThis.clearTimeout = mock((timer) => {
    timer.cleared = true;
  });
  return {
    timers,
    restore() {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    },
  };
}

describe('AgentHandoffService', () => {
  it('copies a frozen conversational prefix into a target ledger', () => {
    const ledger = {
      currentView: mock(() => null),
      highWatermark: mock(() => ({ viewId: 'view-1', ordinal: 3 })),
      rowsThrough: mock(() => [
        { kind: 'user-input', at: 't1', detail: { message: { type: 'user-message' } } },
        { kind: 'notice', at: 't2', message: 'ignored', detail: {} },
        { kind: 'provider-row', at: 't3', message: { type: 'assistant-message' }, providerMeta: {} },
      ]),
      initializeChat: mock(() => ({})),
      deleteChat: mock(() => {}),
    };
    const service = createService({ ledger });

    const watermark = service.seedContinuationLedger({
      sourceChatId: 'source',
      targetChatId: 'target',
    });

    expect(watermark).toEqual({ viewId: 'view-1', ordinal: 3 });
    expect(ledger.initializeChat).toHaveBeenCalledWith('target', [
      expect.objectContaining({ kind: 'user-input', providerMeta: null }),
      expect.objectContaining({ kind: 'provider-row', providerMeta: null }),
    ], 3);
  });

  it('[TLV5-HANDOFF.01-CORE-UNIT-01] closes, checkpoints, decides, and rolls ownership forward in order', async () => {
    const current = sourceChat();
    const calls = [];
    const state = handoffState(current, calls);
    const ledger = ledgerState(calls);
    const planFor = mock(async () => {
      calls.push('plan');
      return {
        kind: 'compacted',
        context: { prefix: 'prepared context' },
        summary: 'prepared summary',
      };
    });
    const deposit = mock(() => calls.push('deposit'));
    const service = createService({
      registry: { getChat: () => current },
      ownership: state.ownership,
      ledger,
      carryover: { planFor },
      preparedCarryover: { deposit, discard: mock(() => {}) },
      reopenProducer: () => calls.push('reopen'),
      onCommitted: mock(async () => calls.push('notify')),
    });
    const admission = context();

    await service.createPreparation({
      chatId: 'chat',
      clientRequestId: 'request-1',
      handoff: handoff(),
      source: current,
      target: target(),
      command: 'continue the work',
    }).prepare(admission);

    expect(calls).toEqual([
      'close',
      'watermark',
      'checkpoint',
      'messages',
      'plan',
      'decision',
      'close',
      'marker',
      'boundary',
      'registry',
      'complete',
      'reopen',
      'deposit',
      'notify',
    ]);
    expect(admission.assertAdmissionActive).toHaveBeenCalledTimes(2);
    expect(state.decided.watermark).toEqual({ viewId: 'view-1', ordinal: 7 });
    expect(planFor).toHaveBeenCalledWith(expect.objectContaining({
      operation: 'agent-switch',
      chatId: 'chat',
      projectPath: '/workspace/project',
      destination: {
        agentId: 'target-agent',
        model: 'target-model',
        prompt: 'continue the work',
      },
      signal: expect.any(AbortSignal),
    }));
    expect(planFor.mock.calls[0][0].signal.aborted).toBe(false);
    expect(deposit).toHaveBeenCalledWith(expect.objectContaining({
      chatId: 'chat',
      transcriptViewId: 'view-1',
      targetAgentId: 'target-agent',
      clientRequestId: 'request-1',
    }));
    expect(current).toMatchObject({
      agentId: 'target-agent',
      agentOwnershipEpoch: state.decided.target.agentOwnershipEpoch,
      agentSessionId: null,
    });
  });

  it('[TLV5-L11.05-HANDOFF-CORE-UNIT-01] does not persist an ownership decision when the ledger is write-fenced', async () => {
    const current = sourceChat();
    const calls = [];
    const state = handoffState(current, calls);
    const ledger = ledgerState(calls);
    ledger.checkpointForHandoff = mock(() => {
      throw new LedgerFencedError('chat', { cause: new Error('injected write fence') });
    });
    const service = createService({
      registry: { getChat: () => current },
      ownership: state.ownership,
      ledger,
      reopenProducer: () => calls.push('reopen'),
    });

    await expect(service.createPreparation({
      chatId: 'chat',
      clientRequestId: 'request-1',
      handoff: handoff(),
      source: current,
      target: target(),
      command: 'continue',
    }).prepare(context())).rejects.toThrow(LedgerFencedError);

    expect(state.ownership.decideHandoff).not.toHaveBeenCalled();
    expect(calls).toEqual(['close', 'watermark', 'reopen']);
    expect(current).toMatchObject({ agentId: 'source-agent', agentOwnershipEpoch: 'source-epoch' });
  });

  it('reopens the producer and leaves ownership untouched when planning fails', async () => {
    const current = sourceChat();
    const calls = [];
    const state = handoffState(current, calls);
    const deposit = mock(() => {});
    const discard = mock(() => {});
    const service = createService({
      registry: { getChat: () => current },
      ownership: state.ownership,
      ledger: ledgerState(calls),
      carryover: {
        planFor: mock(async () => {
          calls.push('plan');
          throw new Error('compaction failed');
        }),
      },
      preparedCarryover: { deposit, discard },
      reopenProducer: () => calls.push('reopen'),
    });
    const preparation = service.createPreparation({
      chatId: 'chat',
      clientRequestId: 'request-1',
      handoff: handoff(),
      source: current,
      target: target(),
      command: 'continue',
    });

    await expect(preparation.prepare(context())).rejects.toThrow('compaction failed');
    await preparation.compensate();

    expect(calls).toEqual(['close', 'watermark', 'checkpoint', 'messages', 'plan', 'reopen']);
    expect(state.ownership.decideHandoff).not.toHaveBeenCalled();
    expect(deposit).not.toHaveBeenCalled();
    expect(discard).toHaveBeenCalledWith('chat');
    expect(current).toMatchObject({ agentId: 'source-agent', agentOwnershipEpoch: 'source-epoch' });
  });

  it('cancels active carryover planning without deciding ownership', async () => {
    const current = sourceChat();
    const calls = [];
    const state = handoffState(current, calls);
    let markPlanningStarted;
    const planningStarted = new Promise((resolve) => { markPlanningStarted = resolve; });
    let planningSignal;
    const service = createService({
      registry: { getChat: () => current },
      ownership: state.ownership,
      ledger: ledgerState(calls),
      carryover: {
        planFor: mock((input) => {
          planningSignal = input.signal;
          markPlanningStarted();
          return new Promise((_resolve, reject) => {
            input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true });
          });
        }),
      },
      reopenProducer: () => calls.push('reopen'),
    });
    const preparation = service.createPreparation({
      chatId: 'chat',
      clientRequestId: 'request-1',
      handoff: handoff(),
      source: current,
      target: target(),
      command: 'continue',
    });
    const task = preparation.prepare(context());
    await planningStarted;

    service.cancelPreparation('chat');

    await expect(task).rejects.toThrow('Turn interrupted by the user');
    expect(planningSignal.aborted).toBe(true);
    expect(state.ownership.decideHandoff).not.toHaveBeenCalled();
    expect(calls).toEqual(['close', 'watermark', 'checkpoint', 'messages', 'reopen']);
  });

  it('[TLV5-HANDOFF.03-CORE-UNIT-01] rolls a persisted decision forward without recapturing or checkpointing', async () => {
    const current = sourceChat();
    const calls = [];
    const state = handoffState(current, calls);
    state.setIntent(persistedIntent());
    const ledger = ledgerState(calls);
    const planFor = mock(async () => ({ kind: 'no-history' }));
    const deposit = mock(() => {});
    const service = createService({
      registry: { getChat: () => current },
      ownership: state.ownership,
      ledger,
      carryover: { planFor },
      preparedCarryover: { deposit, discard: mock(() => {}) },
      reopenProducer: () => calls.push('reopen'),
    });

    await service.createPreparation({
      chatId: 'chat',
      clientRequestId: 'request-1',
      handoff: handoff(),
      source: current,
      target: target(),
      command: 'continue',
    }).prepare(context());

    expect(calls).toEqual(['close', 'marker', 'boundary', 'registry', 'complete', 'reopen']);
    expect(ledger.highWatermark).not.toHaveBeenCalled();
    expect(ledger.checkpointForHandoff).not.toHaveBeenCalled();
    expect(planFor).not.toHaveBeenCalled();
    expect(deposit).not.toHaveBeenCalled();
  });

  it('bounds request-path roll-forward and leaves the decision for background recovery', async () => {
    const current = sourceChat();
    const calls = [];
    const state = handoffState(current, calls);
    state.setIntent(persistedIntent());
    let registryAttempts = 0;
    state.ownership.applyHandoffDecision = mock(async () => {
      registryAttempts += 1;
      throw new Error('injected persistent registry failure');
    });
    const service = createService({
      registry: { getChat: () => current },
      ownership: state.ownership,
      ledger: ledgerState(calls),
    });
    const preparation = service.createPreparation({
      chatId: 'chat',
      clientRequestId: 'request-1',
      handoff: handoff(),
      source: current,
      target: target(),
      command: 'continue',
    }).prepare(context());

    try {
      await expect(preparation).rejects.toMatchObject({
        code: 'OWNERSHIP_TRANSFER_PENDING',
        status: 409,
        retryable: true,
      });
      service.shutdown();
      expect(registryAttempts).toBe(3);
      expect(state.ownership.findHandoff('chat', 'request-1')).not.toBeNull();
    } finally {
      service.shutdown();
      await preparation.catch(() => undefined);
    }
  });

  it('does not let a disowned in-flight recovery replace the request recovery timer', async () => {
    const current = sourceChat();
    const calls = [];
    const state = handoffState(current, calls);
    state.setIntent(persistedIntent());
    const applyDecision = state.ownership.applyHandoffDecision;
    let applyCalls = 0;
    let markOrphanStarted;
    const orphanStarted = new Promise((resolve) => {
      markOrphanStarted = resolve;
    });
    let rejectOrphan;
    const heldOrphan = new Promise((_, reject) => {
      rejectOrphan = reject;
    });
    state.ownership.applyHandoffDecision = mock(async (...args) => {
      applyCalls += 1;
      if (applyCalls === 1) {
        markOrphanStarted();
        await heldOrphan;
      }
      if (applyCalls <= 4) throw new Error('injected persistent registry failure');
      return applyDecision(...args);
    });
    const fakeTimers = installFakeTimers();
    const { timers } = fakeTimers;
    const service = createService({
      registry: { getChat: () => current },
      ownership: state.ownership,
      ledger: ledgerState(calls),
    });
    const prepare = () => service.createPreparation({
      chatId: 'chat',
      clientRequestId: 'request-1',
      handoff: handoff(),
      source: current,
      target: target(),
      command: 'continue',
    }).prepare(context());
    const startupRecovery = service.recoverPendingHandoffs();
    let request;

    try {
      await orphanStarted;
      request = prepare();
      for (let tick = 0; tick < 20 && timers.length < 1; tick += 1) await Promise.resolve();
      expect(applyCalls).toBe(2);

      rejectOrphan(new Error('injected orphaned recovery failure'));
      await startupRecovery;

      const firstWait = timers[0];
      expect(firstWait).toBeDefined();
      firstWait.fired = true;
      firstWait.callback();
      for (
        let tick = 0;
        tick < 20 && !timers.some((timer) => timer.delay === 50);
        tick += 1
      ) await Promise.resolve();

      const secondWait = timers.find((timer) => timer.delay === 50);
      expect(secondWait).toBeDefined();
      secondWait.fired = true;
      secondWait.callback();
      await expect(request).rejects.toMatchObject({ code: 'OWNERSHIP_TRANSFER_PENDING' });

      const recoveryTimer = timers.find((timer) =>
        timer.delay === 25 && !timer.fired && !timer.cleared);
      expect(recoveryTimer).toBeDefined();
      recoveryTimer.fired = true;
      recoveryTimer.callback();
      for (let tick = 0; tick < 20 && applyCalls < 5; tick += 1) await Promise.resolve();
      expect(applyCalls).toBe(5);
    } finally {
      service.shutdown();
      rejectOrphan(new Error('test cleanup'));
      await request?.catch(() => undefined);
      await startupRecovery.catch(() => undefined);
      fakeTimers.restore();
    }
  });

  it('does not let a disowned producer recovery delete the live recovery', async () => {
    const current = sourceChat();
    const calls = [];
    const state = handoffState(current, calls);
    state.setIntent(persistedIntent());
    let completeCalls = 0;
    state.ownership.completeHandoff = mock(async () => {
      completeCalls += 1;
      calls.push('complete');
      if (completeCalls > 1) state.setIntent(null);
    });
    let markOrphanStarted;
    const orphanStarted = new Promise((resolve) => {
      markOrphanStarted = resolve;
    });
    let resolveOrphan;
    const heldOrphan = new Promise((resolve) => {
      resolveOrphan = resolve;
    });
    let reopenCalls = 0;
    const reopenProducer = mock(async () => {
      reopenCalls += 1;
      if (reopenCalls === 1) {
        markOrphanStarted();
        await heldOrphan;
        return;
      }
      if (reopenCalls <= 4) throw new Error('injected persistent producer failure');
      calls.push('reopen');
    });
    const fakeTimers = installFakeTimers();
    const { timers } = fakeTimers;
    const service = createService({
      registry: { getChat: () => current },
      ownership: state.ownership,
      ledger: ledgerState(calls),
      reopenProducer,
    });
    const startupRecovery = service.recoverPendingHandoffs();
    let request;

    try {
      await orphanStarted;
      request = service.createPreparation({
        chatId: 'chat',
        clientRequestId: 'request-1',
        handoff: handoff(),
        source: current,
        target: target(),
        command: 'continue',
      }).prepare(context());
      for (let tick = 0; tick < 20 && timers.length < 1; tick += 1) await Promise.resolve();
      expect(reopenCalls).toBe(2);

      const firstWait = timers[0];
      expect(firstWait).toBeDefined();
      firstWait.fired = true;
      firstWait.callback();
      for (
        let tick = 0;
        tick < 20 && !timers.some((timer) => timer.delay === 50);
        tick += 1
      ) await Promise.resolve();

      const secondWait = timers.find((timer) => timer.delay === 50);
      expect(secondWait).toBeDefined();
      secondWait.fired = true;
      secondWait.callback();
      await expect(request).rejects.toMatchObject({ code: 'OWNERSHIP_TRANSFER_PENDING' });

      resolveOrphan();
      await startupRecovery;

      const recoveryTimer = timers.find((timer) =>
        timer.delay === 25 && !timer.fired && !timer.cleared);
      expect(recoveryTimer).toBeDefined();
      recoveryTimer.fired = true;
      recoveryTimer.callback();
      for (let tick = 0; tick < 20 && reopenCalls < 5; tick += 1) await Promise.resolve();
      expect(reopenCalls).toBe(5);
    } finally {
      service.shutdown();
      resolveOrphan();
      await request?.catch(() => undefined);
      await startupRecovery.catch(() => undefined);
      fakeTimers.restore();
    }
  });

  it('resumes background recovery at producer reopen after the journal is discharged', async () => {
    const current = sourceChat();
    const calls = [];
    const state = handoffState(current, calls);
    state.setIntent(persistedIntent());
    let reopenAttempts = 0;
    let resolveRecovery;
    const recovered = new Promise((resolve) => {
      resolveRecovery = resolve;
    });
    const service = createService({
      registry: { getChat: () => current },
      ownership: state.ownership,
      ledger: ledgerState(calls),
      reopenProducer: () => {
        reopenAttempts += 1;
        if (reopenAttempts <= 3) throw new Error('injected persistent producer failure');
        calls.push('reopen');
        resolveRecovery();
      },
    });
    const preparation = service.createPreparation({
      chatId: 'chat',
      clientRequestId: 'request-1',
      handoff: handoff(),
      source: current,
      target: target(),
      command: 'continue',
    }).prepare(context());

    try {
      await expect(preparation).rejects.toMatchObject({
        code: 'OWNERSHIP_TRANSFER_PENDING',
        retryable: true,
      });
      expect(state.ownership.findHandoff('chat', 'request-1')).toBeNull();
      await recovered;
      expect(reopenAttempts).toBe(4);
      expect(calls.filter((call) => call === 'complete')).toHaveLength(1);
    } finally {
      service.shutdown();
      await preparation.catch(() => undefined);
    }
  });

  it('treats a retry-dispatched journal intent as complete in armed background recovery', async () => {
    const current = sourceChat();
    const calls = [];
    const state = handoffState(current, calls);
    state.setIntent(persistedIntent());
    let completeAttempts = 0;
    state.ownership.completeHandoff = mock(async () => {
      completeAttempts += 1;
      if (completeAttempts <= 3) throw new Error('injected persistent journal failure');
      if (!state.ownership.findHandoff('chat', 'request-1')) {
        throw new Error('journal intent already removed');
      }
      calls.push('complete');
      state.setIntent(null);
    });
    let reopenAttempts = 0;
    const service = createService({
      registry: { getChat: () => current },
      ownership: state.ownership,
      ledger: ledgerState(calls),
      reopenProducer: () => {
        reopenAttempts += 1;
      },
    });
    const prepare = () => service.createPreparation({
      chatId: 'chat',
      clientRequestId: 'request-1',
      handoff: handoff(),
      source: current,
      target: target(),
      command: 'continue',
    }).prepare(context());
    const first = prepare();

    try {
      await expect(first).rejects.toMatchObject({ code: 'OWNERSHIP_TRANSFER_PENDING' });
      await expect(prepare()).resolves.toBeUndefined();
      await Bun.sleep(75);
      expect(completeAttempts).toBe(4);
      expect(reopenAttempts).toBe(1);
    } finally {
      service.shutdown();
      await first.catch(() => undefined);
    }
  });

  it('skips registry recovery when another actor already applied and discharged the intent', async () => {
    const intent = persistedIntent();
    const current = {
      ...sourceChat(),
      agentId: intent.target.execution.agentId,
      agentOwnershipEpoch: intent.target.agentOwnershipEpoch,
    };
    const ownership = {
      findHandoff: () => null,
      pendingHandoffs: () => [intent],
      applyHandoffDecision: mock(async () => {}),
      completeHandoff: mock(async () => {}),
    };
    const reopenProducer = mock(() => {});
    const service = createService({
      registry: { getChat: () => current },
      ownership,
      ledger: ledgerState([]),
      reopenProducer,
    });

    await service.recoverPendingHandoffs();

    expect(ownership.applyHandoffDecision).not.toHaveBeenCalled();
    expect(ownership.completeHandoff).not.toHaveBeenCalled();
    expect(reopenProducer).toHaveBeenCalledOnce();
  });

  it('stops recovery when the intent disappears without applying target ownership', async () => {
    const intent = persistedIntent();
    const ownership = {
      findHandoff: () => null,
      pendingHandoffs: () => [intent],
      applyHandoffDecision: mock(async () => {}),
      completeHandoff: mock(async () => {}),
    };
    const reopenProducer = mock(() => {});
    const fakeTimers = installFakeTimers();
    const service = createService({ ownership, ledger: ledgerState([]), reopenProducer });

    try {
      await service.recoverPendingHandoffs();

      expect(ownership.applyHandoffDecision).not.toHaveBeenCalled();
      expect(ownership.completeHandoff).not.toHaveBeenCalled();
      expect(reopenProducer).not.toHaveBeenCalled();
      expect(fakeTimers.timers).toHaveLength(0);
    } finally {
      service.shutdown();
      fakeTimers.restore();
    }
  });

  it('recovers every durable handoff through the ledger boundary', async () => {
    const current = sourceChat();
    const calls = [];
    const state = handoffState(current, calls);
    state.setIntent(persistedIntent());
    const service = createService({
      registry: { getChat: () => current },
      ownership: state.ownership,
      ledger: ledgerState(calls),
      reopenProducer: () => calls.push('reopen'),
    });

    await service.recoverPendingHandoffs();

    expect(calls).toEqual(['close', 'marker', 'boundary', 'registry', 'complete', 'reopen']);
    expect(current.agentId).toBe('target-agent');
  });

  it('recovers later chats while an earlier handoff remains blocked', async () => {
    const first = { ...persistedIntent(), chatId: 'chat-a', operationId: 'handoff-a' };
    const second = { ...persistedIntent(), chatId: 'chat-b', operationId: 'handoff-b' };
    let markSecondStarted;
    const secondStarted = new Promise((resolve) => {
      markSecondStarted = resolve;
    });
    let markSecondRecovered;
    const secondRecovered = new Promise((resolve) => {
      markSecondRecovered = resolve;
    });
    const ownership = {
      findHandoff: (chatId, clientRequestId) => [first, second].find((intent) =>
        intent.chatId === chatId && intent.clientRequestId === clientRequestId) ?? null,
      pendingHandoffs: () => [first, second],
      applyHandoffDecision: mock(async (operationId) => {
        if (operationId === first.operationId) await secondStarted;
        if (operationId === second.operationId) markSecondStarted();
      }),
      completeHandoff: mock(async (operationId) => {
        if (operationId === second.operationId) markSecondRecovered();
      }),
    };
    const service = createService({
      ownership,
      ledger: ledgerState([]),
    });

    const recovery = service.recoverPendingHandoffs();
    await secondRecovered;
    await recovery;

    expect(ownership.completeHandoff).toHaveBeenCalledWith(second.operationId);
  });

  it('returns after one failed recovery attempt and retries that operation independently', async () => {
    const first = { ...persistedIntent(), chatId: 'chat-a', operationId: 'handoff-a' };
    const second = { ...persistedIntent(), chatId: 'chat-b', operationId: 'handoff-b' };
    let firstAttempts = 0;
    const completed = [];
    const ownership = {
      findHandoff: (chatId, clientRequestId) => [first, second].find((intent) =>
        intent.chatId === chatId && intent.clientRequestId === clientRequestId) ?? null,
      pendingHandoffs: () => [first, second],
      applyHandoffDecision: mock(async (operationId) => {
        if (operationId !== first.operationId) return;
        firstAttempts += 1;
        if (firstAttempts === 1) throw new Error('injected first recovery failure');
      }),
      completeHandoff: mock(async (operationId) => {
        completed.push(operationId);
      }),
    };
    const service = createService({
      ownership,
      ledger: ledgerState([]),
    });

    await service.recoverPendingHandoffs();

    expect(firstAttempts).toBe(1);
    expect(completed).toEqual([second.operationId]);

    for (let attempt = 0; attempt < 100 && !completed.includes(first.operationId); attempt += 1) {
      await Bun.sleep(5);
    }
    expect(firstAttempts).toBe(2);
    expect(completed).toEqual([second.operationId, first.operationId]);
  });

  it('unrefs the timer for an independently retried handoff recovery', async () => {
    const intent = persistedIntent();
    let attempts = 0;
    const ownership = {
      findHandoff: () => intent,
      pendingHandoffs: () => [intent],
      applyHandoffDecision: mock(async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('injected recovery failure');
      }),
      completeHandoff: mock(async () => {}),
    };
    const timer = { unref: mock(() => undefined) };
    const originalSetTimeout = globalThis.setTimeout;
    let fireRetry = null;
    globalThis.setTimeout = mock((callback) => {
      fireRetry = callback;
      return timer;
    });
    const service = createService({ ownership, ledger: ledgerState([]) });
    const recovery = service.recoverPendingHandoffs();

    try {
      for (let tick = 0; tick < 20 && fireRetry === null; tick += 1) {
        await Promise.resolve();
      }
      expect(fireRetry).toBeFunction();
      expect(timer.unref).toHaveBeenCalledTimes(1);

      fireRetry();
      await recovery;
      for (let tick = 0; tick < 20 && attempts < 2; tick += 1) {
        await Promise.resolve();
      }
      expect(attempts).toBe(2);
    } finally {
      if (attempts < 2) fireRetry?.();
      await recovery.catch(() => undefined);
      globalThis.setTimeout = originalSetTimeout;
    }
  });

  it('cancels scheduled recovery retries during shutdown', async () => {
    const intent = persistedIntent();
    let attempts = 0;
    const ownership = {
      findHandoff: () => intent,
      pendingHandoffs: () => [intent],
      applyHandoffDecision: mock(async () => {
        attempts += 1;
        throw new Error('injected recovery failure');
      }),
      completeHandoff: mock(async () => {}),
    };
    const timer = { unref: mock(() => undefined) };
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    let fireRetry = null;
    globalThis.setTimeout = mock((callback) => {
      fireRetry = callback;
      return timer;
    });
    globalThis.clearTimeout = mock(() => undefined);
    const service = createService({ ownership, ledger: ledgerState([]) });

    try {
      await service.recoverPendingHandoffs();
      expect(fireRetry).toBeFunction();
      expect(timer.unref).toHaveBeenCalledTimes(1);

      service.shutdown();

      expect(globalThis.clearTimeout).toHaveBeenCalledWith(timer);
      fireRetry();
      for (let tick = 0; tick < 20; tick += 1) await Promise.resolve();
      expect(attempts).toBe(1);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    }
  });

  it('does not schedule a retry when an active recovery fails after shutdown', async () => {
    const intent = persistedIntent();
    let attempts = 0;
    let markAttemptStarted;
    const attemptStarted = new Promise((resolve) => {
      markAttemptStarted = resolve;
    });
    let rejectAttempt;
    const heldAttempt = new Promise((_, reject) => {
      rejectAttempt = reject;
    });
    const ownership = {
      findHandoff: () => intent,
      pendingHandoffs: () => [intent],
      applyHandoffDecision: mock(async () => {
        attempts += 1;
        markAttemptStarted();
        await heldAttempt;
      }),
      completeHandoff: mock(async () => {}),
    };
    const timer = { unref: mock(() => undefined) };
    const originalSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = mock(() => timer);
    const service = createService({ ownership, ledger: ledgerState([]) });
    const recovery = service.recoverPendingHandoffs();
    let attemptReleased = false;

    try {
      await attemptStarted;
      service.shutdown();
      rejectAttempt(new Error('injected post-shutdown recovery failure'));
      attemptReleased = true;
      await recovery;

      expect(globalThis.setTimeout).not.toHaveBeenCalled();
      expect(attempts).toBe(1);
    } finally {
      if (!attemptReleased) {
        rejectAttempt(new Error('test cleanup'));
      }
      await recovery.catch(() => undefined);
      globalThis.setTimeout = originalSetTimeout;
    }
  });

  it('stops decided handoff roll-forward retries during shutdown', async () => {
    const current = sourceChat();
    const calls = [];
    const state = handoffState(current, calls);
    let registryAttempts = 0;
    let allowRecovery = false;
    state.ownership.applyHandoffDecision = mock(async () => {
      registryAttempts += 1;
      if (!allowRecovery) throw new Error('injected decided handoff failure');
    });
    const timer = { unref: mock(() => undefined) };
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    let fireRetry = null;
    globalThis.setTimeout = mock((callback) => {
      fireRetry = callback;
      return timer;
    });
    globalThis.clearTimeout = mock(() => undefined);
    const service = createService({
      registry: { getChat: () => current },
      ownership: state.ownership,
      ledger: ledgerState(calls),
    });
    const preparation = service.createPreparation({
      chatId: 'chat',
      clientRequestId: 'request-1',
      handoff: handoff(),
      source: current,
      target: target(),
      command: 'continue',
    }).prepare(context());
    let outcome = null;
    void preparation.then(
      () => { outcome = 'resolved'; },
      () => { outcome = 'rejected'; },
    );

    try {
      for (let tick = 0; tick < 20 && fireRetry === null; tick += 1) {
        await Promise.resolve();
      }
      expect(fireRetry).toBeFunction();

      service.shutdown();

      for (let tick = 0; tick < 20 && outcome === null; tick += 1) {
        await Promise.resolve();
      }
      expect(globalThis.clearTimeout).toHaveBeenCalledWith(timer);
      expect(outcome).toBe('rejected');
      fireRetry();
      for (let tick = 0; tick < 20; tick += 1) await Promise.resolve();
      expect(registryAttempts).toBe(1);
    } finally {
      allowRecovery = true;
      fireRetry?.();
      await preparation.catch(() => undefined);
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    }
  });

  it('[TLV5-HANDOFF.06-CORE-UNIT-01] adopts an existing switch marker after unrelated post-watermark rows', async () => {
    const current = sourceChat();
    const calls = [];
    const state = handoffState(current, calls);
    state.setIntent(persistedIntent());
    const ledger = ledgerState(calls);
    ledger.rowsAfter.mockReturnValue([
      { kind: 'notice', ordinal: 8 },
      {
        kind: 'agent-switch',
        ordinal: 9,
        detail: {
          fromAgentId: 'source-agent',
          toAgentId: 'target-agent',
          toModel: 'target-model',
        },
      },
    ]);
    const service = createService({
      registry: { getChat: () => current },
      ownership: state.ownership,
      ledger,
    });

    await service.recoverPendingHandoffs();

    expect(ledger.appendAgentSwitch).not.toHaveBeenCalled();
    expect(ledger.advanceContentStart).toHaveBeenCalledWith('chat', 'view-1', 10);
  });

  it('fences a persisted switch marker that conflicts with the handoff decision', async () => {
    const current = sourceChat();
    const calls = [];
    const state = handoffState(current, calls);
    state.setIntent(persistedIntent());
    const ledger = ledgerState(calls);
    ledger.rowsAfter.mockReturnValue([{
      kind: 'agent-switch',
      ordinal: 8,
      detail: {
        fromAgentId: 'source-agent',
        toAgentId: 'target-agent',
        toModel: 'different-target-model',
      },
    }]);
    const service = createService({
      registry: { getChat: () => current },
      ownership: state.ownership,
      ledger,
    });

    await service.recoverPendingHandoffs();

    expect(ledger.appendAgentSwitch).not.toHaveBeenCalled();
    expect(ledger.advanceContentStart).not.toHaveBeenCalled();
    expect(state.ownership.applyHandoffDecision).not.toHaveBeenCalled();
    expect(state.ownership.completeHandoff).not.toHaveBeenCalled();
    expect(current).toMatchObject({
      agentId: 'source-agent',
      agentOwnershipEpoch: 'source-epoch',
    });
  });

  it('fences duplicate matching switch markers instead of choosing one', async () => {
    const current = sourceChat();
    const calls = [];
    const state = handoffState(current, calls);
    state.setIntent(persistedIntent());
    const ledger = ledgerState(calls);
    const detail = {
      fromAgentId: 'source-agent',
      toAgentId: 'target-agent',
      toModel: 'target-model',
    };
    ledger.rowsAfter.mockReturnValue([
      { kind: 'agent-switch', ordinal: 8, detail },
      { kind: 'agent-switch', ordinal: 9, detail },
    ]);
    const service = createService({
      registry: { getChat: () => current },
      ownership: state.ownership,
      ledger,
    });

    await service.recoverPendingHandoffs();

    expect(ledger.appendAgentSwitch).not.toHaveBeenCalled();
    expect(ledger.advanceContentStart).not.toHaveBeenCalled();
    expect(state.ownership.applyHandoffDecision).not.toHaveBeenCalled();
    expect(state.ownership.completeHandoff).not.toHaveBeenCalled();
    expect(current).toMatchObject({
      agentId: 'source-agent',
      agentOwnershipEpoch: 'source-epoch',
    });
  });

  it('rejects a resumed request whose target differs from the durable decision', async () => {
    const current = sourceChat();
    const state = handoffState(current, []);
    state.setIntent(persistedIntent());
    const service = createService({
      registry: { getChat: () => current },
      ownership: state.ownership,
      ledger: ledgerState([]),
    });

    await expect(service.createPreparation({
      chatId: 'chat',
      clientRequestId: 'request-1',
      handoff: handoff('other-agent'),
      source: current,
      target: {
        ...target(),
        agentId: 'other-agent',
        model: 'other-agent-model',
        agentSettings: envelope('other-agent'),
      },
      command: 'continue',
    }).prepare(context())).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
      status: 409,
    });
  });

  it('requires an explicit target bypass mode under the CLI fallback policy', async () => {
    const current = sourceChat();
    const service = createService({
      registry: { getChat: () => current },
      ...targetResolutionDeps({ permissionModes: ['bypassPermissions'] }),
    });
    const request = handoff();
    delete request.target.permissionMode;

    await expect(service.resolveTarget({
      chat: current,
      handoff: request,
      permissionFallbackPolicy: 'require-explicit-bypass',
    })).rejects.toMatchObject({ code: 'EXPLICIT_BYPASS_REQUIRED', status: 422 });

    request.target.permissionMode = 'bypassPermissions';
    await expect(service.resolveTarget({
      chat: current,
      handoff: request,
      permissionFallbackPolicy: 'require-explicit-bypass',
    })).resolves.toMatchObject({
      agentId: 'target-agent',
      permissionMode: 'bypassPermissions',
    });
  });

  it('accepts the neutral target thinking value when no thinking mode is configurable', async () => {
    const current = sourceChat();
    const service = createService({
      registry: { getChat: () => current },
      ...targetResolutionDeps({ thinkingModes: [] }),
    });

    await expect(service.resolveTarget({
      chat: current,
      handoff: handoff(),
    })).resolves.toMatchObject({ thinkingMode: 'none' });
  });
});

function createService(overrides = {}) {
  const integrations = new Map([
    ['source-agent', integration('source-agent')],
    ['target-agent', integration('target-agent')],
  ]);
  return new AgentHandoffService({
    registry: overrides.registry ?? { getChat: () => sourceChat() },
    ownership: overrides.ownership ?? handoffState(sourceChat(), []).ownership,
    ledger: overrides.ledger ?? ledgerState([]),
    carryover: overrides.carryover ?? {
      planFor: mock(async () => ({ kind: 'no-history' })),
    },
    preparedCarryover: overrides.preparedCarryover ?? {
      deposit: mock(() => {}),
      discard: mock(() => {}),
    },
    integrations: overrides.integrations ?? {
      get: (agentId) => integrations.get(agentId),
      require: (agentId) => integrations.get(agentId),
    },
    endpointResolver: overrides.endpointResolver ?? {},
    catalog: overrides.catalog ?? {},
    reopenProducer: overrides.reopenProducer ?? (() => {}),
    onCommitted: overrides.onCommitted,
  });
}

function handoffState(current, calls) {
  let intent = null;
  let decided = null;
  const ownership = {
    findHandoff: () => intent,
    pendingHandoffs: () => intent ? [intent] : [],
    decideHandoff: mock(async (input) => {
      calls.push('decision');
      intent = {
        version: 5,
        operationId: input.operationId,
        clientRequestId: input.clientRequestId,
        submittedTargetHash: input.submittedTargetHash,
        kind: 'handoff',
        chatId: input.chatId,
        phase: 'commit-decided',
        source: {
          agentId: input.source.agentId,
          agentOwnershipEpoch: input.source.agentOwnershipEpoch,
        },
        target: {
          execution: input.target,
          agentOwnershipEpoch: input.targetAgentOwnershipEpoch,
        },
        watermark: input.watermark,
        createdAt: '2026-01-01T00:00:00.000Z',
      };
      decided = intent;
      return intent;
    }),
    applyHandoffDecision: mock(async () => {
      calls.push('registry');
      Object.assign(current, {
        agentId: intent.target.execution.agentId,
        agentOwnershipEpoch: intent.target.agentOwnershipEpoch,
        agentSessionId: null,
        nativeSession: null,
        nativeSeedReceipt: null,
      });
      return { id: 'chat', ...current };
    }),
    completeHandoff: mock(async () => {
      calls.push('complete');
      intent = null;
    }),
  };
  return {
    ownership,
    get decided() { return decided; },
    setIntent(value) { intent = value; },
  };
}

function ledgerState(calls) {
  return {
    closeProducer: mock(() => calls.push('close')),
    highWatermark: mock(() => {
      calls.push('watermark');
      return { viewId: 'view-1', ordinal: 7 };
    }),
    checkpointForHandoff: mock(() => {
      calls.push('checkpoint');
      return { viewId: 'view-1', ordinal: 7 };
    }),
    conversationMessages: mock(() => {
      calls.push('messages');
      return [];
    }),
    rowsAfter: mock(() => []),
    appendAgentSwitch: mock(() => {
      calls.push('marker');
      return { kind: 'agent-switch', ordinal: 8 };
    }),
    advanceContentStart: mock(() => {
      calls.push('boundary');
      return {};
    }),
  };
}

function persistedIntent() {
  return {
    version: 5,
    operationId: 'agent-handoff:existing',
    clientRequestId: 'request-1',
    submittedTargetHash: hashTarget(handoff()),
    kind: 'handoff',
    chatId: 'chat',
    phase: 'commit-decided',
    source: { agentId: 'source-agent', agentOwnershipEpoch: 'source-epoch' },
    target: { execution: target(), agentOwnershipEpoch: 'target-epoch' },
    watermark: { viewId: 'view-1', ordinal: 7 },
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

function integration(agentId) {
  return {
    descriptor: { id: agentId },
    settings: {
      defaults: () => envelope(agentId),
      parse: (value) => value,
    },
  };
}

function targetResolutionDeps({
  permissionModes = ['default'],
  thinkingModes = ['none'],
} = {}) {
  const integrations = new Map([
    ['source-agent', integration('source-agent')],
    ['target-agent', integration('target-agent')],
  ]);
  return {
    integrations: { get: (agentId) => integrations.get(agentId) },
    endpointResolver: {
      resolveSelection: ({ model }) => ({
        model,
        apiProviderId: null,
        endpointId: null,
        protocol: null,
        isLocal: false,
      }),
      resolveEndpointReference: () => null,
    },
    catalog: {
      getAgentCatalogEntry: async () => ({
        supportedPermissionModes: permissionModes,
        supportedThinkingModes: thinkingModes,
      }),
    },
  };
}

function hashTarget(request) {
  return crypto.createHash('sha256').update(stableStringify(request.target)).digest('hex');
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(',')}}`;
}
