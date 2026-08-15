import { describe, expect, it, mock } from 'bun:test';
import crypto from 'node:crypto';
import { AgentHandoffService } from '../agent-handoff-service.ts';

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

  it('closes, checkpoints, decides, and rolls ownership forward in order', async () => {
    const current = sourceChat();
    const calls = [];
    const state = handoffState(current, calls);
    const ledger = ledgerState(calls);
    const service = createService({
      registry: { getChat: () => current },
      ownership: state.ownership,
      ledger,
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
    }).prepare(admission);

    expect(calls).toEqual([
      'close',
      'watermark',
      'checkpoint',
      'decision',
      'close',
      'marker',
      'boundary',
      'registry',
      'complete',
      'reopen',
      'notify',
    ]);
    expect(admission.assertAdmissionActive).toHaveBeenCalledTimes(2);
    expect(state.decided.watermark).toEqual({ viewId: 'view-1', ordinal: 7 });
    expect(current).toMatchObject({
      agentId: 'target-agent',
      agentOwnershipEpoch: state.decided.target.agentOwnershipEpoch,
      agentSessionId: null,
    });
  });

  it('leaves the source authoritative when checkpoint verification fails', async () => {
    const current = sourceChat();
    const calls = [];
    const state = handoffState(current, calls);
    const ledger = ledgerState(calls);
    ledger.checkpointForHandoff = mock(() => { throw new Error('checkpoint busy'); });
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
    }).prepare(context())).rejects.toThrow('checkpoint busy');

    expect(state.ownership.decideHandoff).not.toHaveBeenCalled();
    expect(calls).toEqual(['close', 'watermark', 'reopen']);
    expect(current).toMatchObject({ agentId: 'source-agent', agentOwnershipEpoch: 'source-epoch' });
  });

  it('rolls a persisted decision forward without recapturing or checkpointing', async () => {
    const current = sourceChat();
    const calls = [];
    const state = handoffState(current, calls);
    state.setIntent(persistedIntent());
    const ledger = ledgerState(calls);
    const service = createService({
      registry: { getChat: () => current },
      ownership: state.ownership,
      ledger,
      reopenProducer: () => calls.push('reopen'),
    });

    await service.createPreparation({
      chatId: 'chat',
      clientRequestId: 'request-1',
      handoff: handoff(),
      source: current,
      target: target(),
    }).prepare(context());

    expect(calls).toEqual(['close', 'marker', 'boundary', 'registry', 'complete', 'reopen']);
    expect(ledger.highWatermark).not.toHaveBeenCalled();
    expect(ledger.checkpointForHandoff).not.toHaveBeenCalled();
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

  it('adopts an existing switch marker after unrelated post-watermark rows', async () => {
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
    carryOver: overrides.carryOver ?? {},
    capture: overrides.capture ?? {},
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

function targetResolutionDeps({ permissionModes = ['default'] } = {}) {
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
        supportedThinkingModes: ['none'],
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
