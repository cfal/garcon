import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { testExecutionLocation } from '../../execution-nodes/testing/placement.js';
import { LocalProviderNativeSessionService } from '../../execution-node/local-provider-native-sessions.js';
import { AtomicJsonWriteError, writeJsonFileAtomic } from '../../lib/json-file-store.js';
import {
  AgentOwnershipJournal,
  emptyOwnershipJournal,
} from '../agent-ownership-journal.js';

const timestamp = '2026-01-01T00:00:00.000Z';

function createJournal(options) {
  return new AgentOwnershipJournal({
    resolveNativeSessions: ({ executionLocation, chat }) => {
      const integration = executionLocation.nodeId === 'test-local-node' && executionLocation.instanceId === `test-${chat.agentId}`
        ? options.integrations.get(chat.agentId) : null;
      return integration ? new LocalProviderNativeSessionService(integration) : null;
    },
    ...options,
  });
}

function envelope(ownerId) {
  return { ownerId, schemaVersion: 1, values: {} };
}

function chat(agentId = 'source-agent', overrides = {}) {
  return {
    executionLocation: testExecutionLocation(agentId, '/workspace/project'),
    agentId,
    agentSessionId: `${agentId}-session`,
    nativeSession: null,
    nativeSeedReceipt: null,
    carryOverSegments: [],
    carryOverMigrationQuarantine: null,
    pendingPreambleBoundary: null,
    preambleSelection: { revision: 0, orderedPreambleIds: [] },
    agentOwnershipEpoch: `${agentId}-epoch`,
    agentSettingsById: { [agentId]: envelope(agentId) },
    projectPath: '/workspace/project',
    tags: [],
    model: `${agentId}-model`,
    apiProviderId: null,
    modelEndpointId: null,
    modelProtocol: null,
    permissionMode: 'default',
    thinkingMode: 'none',
    ...overrides,
  };
}

function target() {
  return {
    executionLocation: testExecutionLocation('target-agent', '/workspace/project'),
    projectPath: '/workspace/project',
    agentId: 'target-agent',
    model: 'target-agent-model',
    apiProviderId: null,
    modelEndpointId: null,
    modelProtocol: null,
    permissionMode: 'default',
    thinkingMode: 'none',
    agentSettings: envelope('target-agent'),
  };
}

function createRegistry(initialEntries) {
  const entries = new Map(Object.entries(initialEntries));
  return {
    getChat: (chatId) => entries.get(chatId) ?? null,
    setChat: (chatId, value) => entries.set(chatId, value),
    listAllChats: () => Object.fromEntries(entries),
    updateChat: mock(async (chatId, patch) => {
      const current = entries.get(chatId);
      if (!current) return null;
      Object.assign(current, patch);
      return { id: chatId, ...current };
    }),
    removeChat: mock((chatId) => entries.delete(chatId)),
    flush: mock(async () => {}),
  };
}

function createIntegrations(release = mock(async () => {})) {
  const integration = (agentId) => ({
    descriptor: { id: agentId },
    settings: {
      defaults: () => envelope(agentId),
      parse: (input) => input,
    },
    nativeSessions: { release },
  });
  const byId = new Map([
    ['source-agent', integration('source-agent')],
    ['target-agent', integration('target-agent')],
  ]);
  return {
    get: (agentId) => byId.get(agentId),
    require(agentId) {
      const value = byId.get(agentId);
      if (!value) throw new Error(`missing integration ${agentId}`);
      return value;
    },
  };
}

function decisionInput(registry, overrides = {}) {
  return {
    operationId: 'handoff:request-1',
    clientRequestId: 'request-1',
    submittedTargetHash: 'a'.repeat(64),
    chatId: 'chat',
    source: registry.getChat('chat'),
    target: target(),
    targetAgentOwnershipEpoch: 'target-epoch',
    watermark: { viewId: 'view-1', ordinal: 7 },
    ...overrides,
  };
}

describe('AgentOwnershipJournal', () => {
  let workspaceDir;

  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-ownership-journal-'));
  });

  afterEach(async () => {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it('persists the complete handoff decision and accepts an identical retry', async () => {
    const registry = createRegistry({ chat: chat() });
    const journal = createJournal({
      workspaceDir,
      registry,
      integrations: createIntegrations(),
      ledger: { deleteChat: mock(() => {}) },
    });
    await journal.initialize();

    const input = decisionInput(registry);
    const first = await journal.decideHandoff(input);
    const retry = await journal.decideHandoff(input);

    expect(retry).toEqual(first);
    expect(first).toMatchObject({
      version: 6,
      phase: 'commit-decided',
      source: { agentId: 'source-agent', agentOwnershipEpoch: 'source-agent-epoch' },
      target: { execution: target(), agentOwnershipEpoch: 'target-epoch' },
      watermark: { viewId: 'view-1', ordinal: 7 },
    });
    expect(journal.pendingHandoffs()).toEqual([first]);
    expect(await readJournal(workspaceDir)).toEqual({
      version: 6,
      ownershipIntents: [first],
    });
  });

  it('rejects a conflicting retry without changing the durable decision', async () => {
    const registry = createRegistry({ chat: chat() });
    const journal = createJournal({
      workspaceDir,
      registry,
      integrations: createIntegrations(),
      ledger: { deleteChat: mock(() => {}) },
    });
    await journal.initialize();
    const input = decisionInput(registry);
    await journal.decideHandoff(input);

    await expect(journal.decideHandoff({
      ...input,
      watermark: { viewId: 'view-1', ordinal: 8 },
    })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });

    expect((await readJournal(workspaceDir)).ownershipIntents[0].watermark.ordinal).toBe(7);
  });

  it('retains a renamed decision and confirms the exact replacement before any later mutation', async () => {
    const registry = createRegistry({ chat: chat(), other: chat() });
    const writes = [];
    let fault = 'after-rename';
    const journal = createJournal({
      workspaceDir, registry, integrations: createIntegrations(), ledger: { deleteChat: mock(() => {}) },
      write: async (filePath, candidate, options) => {
        writes.push(structuredClone(candidate));
        if (fault === 'before-rename') throw new AtomicJsonWriteError('synthetic write failure', false);
        await writeJsonFileAtomic(filePath, candidate, options);
        if (fault === 'after-rename') throw new AtomicJsonWriteError('synthetic directory sync failure', true);
      },
    });
    await journal.initialize();
    const input = decisionInput(registry);
    await expect(journal.decideHandoff(input)).rejects.toMatchObject({ renamed: true });
    const persisted = await readJournal(workspaceDir);
    expect(journal.hasPending('chat')).toBeTrue();
    expect(journal.findHandoff('chat', input.clientRequestId)).toEqual(persisted.ownershipIntents[0]);

    // Read-back and a failed pre-rename retry cannot certify the earlier rename.
    fault = 'before-rename';
    await expect(journal.applyHandoffDecision(input.operationId)).rejects.toMatchObject({ renamed: false });
    await expect(journal.decideHandoff(decisionInput(registry, {
      operationId: 'handoff:other', clientRequestId: 'other', chatId: 'other', source: registry.getChat('other'),
    }))).rejects.toMatchObject({ renamed: false });
    expect(registry.updateChat).not.toHaveBeenCalled();
    expect(journal.hasPending('other')).toBeFalse();
    expect(writes).toEqual([persisted, persisted, persisted]);

    fault = null;
    expect(await journal.decideHandoff(input)).toEqual(persisted.ownershipIntents[0]);
    expect(writes).toEqual([persisted, persisted, persisted, persisted]);
    await journal.applyHandoffDecision(input.operationId);
    await journal.completeHandoff(input.operationId);
    expect(journal.hasPending('chat')).toBeFalse();
  });

  it('keeps the fence after an ambiguous removal until that removal is durably confirmed', async () => {
    const registry = createRegistry({ chat: chat() });
    let fault = false;
    const writes = [];
    const journal = createJournal({
      workspaceDir, registry, integrations: createIntegrations(), ledger: { deleteChat: mock(() => {}) },
      write: async (filePath, candidate, options) => {
        writes.push(structuredClone(candidate));
        await writeJsonFileAtomic(filePath, candidate, options);
        if (fault) throw new AtomicJsonWriteError('synthetic directory sync failure', true);
      },
    });
    await journal.initialize();
    const intent = await journal.decideHandoff(decisionInput(registry));
    await journal.applyHandoffDecision(intent.operationId);
    fault = true;
    await expect(journal.completeHandoff(intent.operationId)).rejects.toMatchObject({ renamed: true });
    expect(await readJournal(workspaceDir)).toEqual(emptyOwnershipJournal());
    expect(journal.hasPending('chat')).toBeTrue();
    expect(journal.pendingKind('chat')).toBe('handoff');
    expect(journal.pendingHandoffs()).toHaveLength(1);
    await expect(journal.reconcileDurability()).rejects.toMatchObject({ renamed: true });
    expect(journal.hasPending('chat')).toBeTrue();
    fault = false;
    await journal.reconcileDurability();
    expect(journal.hasPending('chat')).toBeFalse();
    expect(journal.pendingKind('chat')).toBeNull();
    expect(writes.slice(-3)).toEqual(Array(3).fill(emptyOwnershipJournal()));
  });

  it('does not fence a decision that definitively failed before rename', async () => {
    const registry = createRegistry({ chat: chat() });
    const journal = createJournal({
      workspaceDir, registry, integrations: createIntegrations(), ledger: { deleteChat: mock(() => {}) },
      write: async () => { throw new AtomicJsonWriteError('synthetic write failure', false); },
    });
    await journal.initialize();
    await expect(journal.decideHandoff(decisionInput(registry))).rejects.toMatchObject({ renamed: false });
    expect(journal.hasPending('chat')).toBeFalse();
    expect(journal.pendingHandoffs()).toEqual([]);
  });

  it('does not expose mutable decision snapshots to a caller while durability is unknown', async () => {
    const registry = createRegistry({ chat: chat() });
    let fault = true;
    const journal = createJournal({
      workspaceDir, registry, integrations: createIntegrations(), ledger: { deleteChat: mock(() => {}) },
      write: async (filePath, candidate, options) => {
        await writeJsonFileAtomic(filePath, candidate, options);
        if (fault) throw new AtomicJsonWriteError('synthetic directory sync failure', true);
      },
    });
    await journal.initialize();
    const input = decisionInput(registry);
    await expect(journal.decideHandoff(input)).rejects.toMatchObject({ renamed: true });
    const persisted = await readJournal(workspaceDir);
    journal.findHandoff('chat', input.clientRequestId).target.execution.model = 'mutated';
    journal.pendingHandoffs()[0].source.executionLocation.nodeId = 'mutated';
    fault = false;
    await journal.reconcileDurability();
    expect(await readJournal(workspaceDir)).toEqual(persisted);
    const decision = await journal.decideHandoff(input);
    decision.watermark.ordinal = 99;
    expect(journal.findHandoff('chat', input.clientRequestId).watermark.ordinal).toBe(input.watermark.ordinal);
  });

  it('rolls registry ownership forward without deleting the source transcript', async () => {
    const registry = createRegistry({ chat: chat() });
    const release = mock(async () => {});
    const journal = createJournal({
      workspaceDir,
      registry,
      integrations: createIntegrations(release),
      ledger: { deleteChat: mock(() => {}) },
    });
    await journal.initialize();
    const intent = await journal.decideHandoff(decisionInput(registry));

    const updated = await journal.applyHandoffDecision(intent.operationId);
    await journal.completeHandoff(intent.operationId);

    expect(updated).toMatchObject({
      agentId: 'target-agent',
      agentOwnershipEpoch: 'target-epoch',
      pendingPreambleBoundary: {
        kind: 'agent-switch',
        ownershipEpoch: 'target-epoch',
      },
      agentSessionId: null,
      nativeSession: null,
      nativeSeedReceipt: null,
      carryOverSegments: [],
    });
    expect(release).not.toHaveBeenCalled();
    expect(await readJournal(workspaceDir)).toEqual(emptyOwnershipJournal());
  });

  it('preserves the chat preamble selection and revision across the roll-forward', async () => {
    const selectedId = '3502b645-222b-49d2-ac39-1c91f9fb1174';
    const registry = createRegistry({
      chat: chat('source-agent', {
        preambleSelection: { revision: 3, orderedPreambleIds: [selectedId] },
      }),
    });
    const journal = createJournal({
      workspaceDir,
      registry,
      integrations: createIntegrations(mock(async () => {})),
      ledger: { deleteChat: mock(() => {}) },
    });
    await journal.initialize();
    const intent = await journal.decideHandoff(decisionInput(registry));

    const updated = await journal.applyHandoffDecision(intent.operationId);
    await journal.completeHandoff(intent.operationId);

    expect(updated).toMatchObject({
      preambleSelection: { revision: 3, orderedPreambleIds: [selectedId] },
      pendingPreambleBoundary: {
        kind: 'agent-switch',
        ownershipEpoch: 'target-epoch',
      },
    });
  });

  it('keeps durable handoffs pending at startup for ledger-aware recovery', async () => {
    const registry = createRegistry({ chat: chat() });
    const persisted = persistedHandoff();
    await writeJournal(workspaceDir, {
      version: 6,
      ownershipIntents: [persisted],
    });
    const journal = createJournal({
      workspaceDir,
      registry,
      integrations: createIntegrations(),
      ledger: { deleteChat: mock(() => {}) },
    });

    await journal.initialize();

    expect(registry.getChat('chat').agentId).toBe('source-agent');
    expect(journal.pendingHandoffs()).toEqual([persisted]);
    expect(journal.hasPending('chat')).toBeTrue();
  });

  it('rejects malformed durable handoff decisions', async () => {
    await writeJournal(workspaceDir, {
      version: 6,
      ownershipIntents: [{ ...persistedHandoff(), watermark: { viewId: '', ordinal: -1 } }],
    });
    const journal = createJournal({
      workspaceDir,
      registry: createRegistry({}),
      integrations: createIntegrations(),
      ledger: { deleteChat: mock(() => {}) },
    });

    await expect(journal.initialize()).rejects.toThrow('Invalid agent ownership journal');
  });

  it('adopts an empty journal left at an earlier format version', async () => {
    await writeJournal(workspaceDir, {
      version: 3,
      ownershipIntents: [],
      transferCleanup: [],
    });
    const journal = createJournal({
      workspaceDir,
      registry: createRegistry({}),
      integrations: createIntegrations(),
      ledger: { deleteChat: mock(() => {}) },
    });

    await journal.initialize();

    expect(journal.pendingHandoffs()).toEqual([]);
    expect(journal.hasPending('chat')).toBeFalse();
  });

  it('rejects an earlier journal that still records a decision', async () => {
    await writeJournal(workspaceDir, {
      version: 3,
      ownershipIntents: [{ kind: 'handoff', chatId: 'chat', operationId: 'legacy' }],
    });
    const journal = createJournal({
      workspaceDir,
      registry: createRegistry({}),
      integrations: createIntegrations(),
      ledger: { deleteChat: mock(() => {}) },
    });

    await expect(journal.initialize()).rejects.toThrow('Invalid agent ownership journal');
  });

  it('removes registry ownership without waiting for provider release', async () => {
    const registry = createRegistry({ chat: chat() });
    let releaseStarted;
    let releaseProvider;
    const release = mock(() => new Promise((resolve) => {
      releaseProvider = resolve;
      releaseStarted?.();
    }));
    const ledger = { deleteChat: mock(() => {}) };
    const journal = createJournal({
      workspaceDir,
      registry,
      integrations: createIntegrations(release),
      ledger,
    });
    await journal.initialize();

    const started = new Promise((resolve) => { releaseStarted = resolve; });
    await journal.delete('chat');

    expect(registry.getChat('chat')).toBeNull();
    expect(ledger.deleteChat).toHaveBeenCalledWith('chat');
    expect((await readJournal(workspaceDir)).ownershipIntents[0]).toMatchObject({
      chatId: 'chat',
      phase: 'registry-removed',
    });
    await started;
    expect(release).toHaveBeenCalledTimes(1);
    releaseProvider();
    await journal.waitForProviderCleanup();
    expect((await readJournal(workspaceDir)).ownershipIntents).toEqual([]);
  });

  it.each(['retry', 'restart'])('recovers an ambiguous delete decision by %s without overwriting it', async (recovery) => {
    const registry = createRegistry({ chat: chat(), other: chat('target-agent') });
    const release = mock(async () => {});
    const integrations = createIntegrations(release);
    const ledger = { deleteChat: mock(() => {}) };
    const writes = [];
    let fault = true;
    const journal = createJournal({
      workspaceDir, registry, integrations, ledger,
      write: async (filePath, candidate, options) => {
        writes.push(structuredClone(candidate));
        await writeJsonFileAtomic(filePath, candidate, options);
        if (fault) throw new AtomicJsonWriteError('synthetic directory sync failure', true);
      },
    });
    await journal.initialize();
    await expect(journal.delete('chat')).rejects.toMatchObject({ renamed: true });
    const persisted = await readJournal(workspaceDir);
    expect(persisted.ownershipIntents[0]).toMatchObject({ kind: 'delete', phase: 'prepared', chatId: 'chat' });
    expect(journal.hasPending('chat')).toBeTrue();
    expect(journal.pendingKind('chat')).toBe('delete');
    await expect(journal.delete('other')).rejects.toMatchObject({ renamed: true });
    expect(writes).toEqual([persisted, persisted]);
    expect(registry.removeChat).not.toHaveBeenCalled();
    expect(ledger.deleteChat).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();

    fault = false;
    const recovered = recovery === 'retry' ? journal : createJournal({ workspaceDir, registry, integrations, ledger });
    if (recovery === 'retry') {
      await recovered.delete('chat');
      expect(writes.slice(0, 3)).toEqual([persisted, persisted, persisted]);
    } else {
      await recovered.initialize();
    }
    await recovered.waitForProviderCleanup();
    expect(registry.getChat('chat')).toBeNull();
    expect(registry.getChat('other')).not.toBeNull();
    expect(ledger.deleteChat).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(recovered.hasPending('chat')).toBeFalse();
    expect(recovered.pendingKind('chat')).toBeNull();
  });

  it('does not let blocked cleanup A delay delete B', async () => {
    const registry = createRegistry({ chatA: chat(), chatB: chat('target-agent') });
    let releaseA;
    const release = mock((request) => {
      if (request.chat.chatId === 'chatA') return new Promise((resolve) => { releaseA = resolve; });
      return Promise.resolve();
    });
    const journal = createJournal({
      workspaceDir,
      registry,
      integrations: createIntegrations(release),
      ledger: { deleteChat: mock(() => {}) },
    });
    await journal.initialize();

    await journal.delete('chatA');
    const deleteB = journal.delete('chatB');
    await Promise.race([
      deleteB,
      new Promise((_, reject) => setTimeout(() => reject(new Error('delete B blocked')), 100)),
    ]);
    expect(registry.getChat('chatB')).toBeNull();
    releaseA();
    await journal.waitForProviderCleanup();
    expect((await readJournal(workspaceDir)).ownershipIntents).toEqual([]);
  });

  it('does not delete a recreated same-id ledger during old provider cleanup', async () => {
    const original = chat();
    const replacement = chat('target-agent');
    const registry = createRegistry({ chat: original });
    let releaseProvider;
    const release = mock(() => new Promise((resolve) => { releaseProvider = resolve; }));
    const ledger = { deleteChat: mock(() => {}) };
    const journal = createJournal({
      workspaceDir,
      registry,
      integrations: createIntegrations(release),
      ledger,
    });
    await journal.initialize();

    await journal.delete('chat');
    await journal.delete('chat');
    expect(ledger.deleteChat).toHaveBeenCalledTimes(1);
    registry.setChat('chat', replacement);
    await expect(journal.delete('chat')).rejects.toMatchObject({ code: 'SESSION_BUSY' });
    releaseProvider();
    await journal.waitForProviderCleanup();

    expect(ledger.deleteChat).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(registry.getChat('chat')).toBe(replacement);
    expect((await readJournal(workspaceDir)).ownershipIntents).toEqual([]);
  });

  it('confirms an ambiguous registry-removed replacement before retrying ledger cleanup', async () => {
    const registry = createRegistry({ chat: chat() });
    const release = mock(async () => {});
    const ledger = { deleteChat: mock(() => {}) };
    const writes = [];
    let fault = true;
    const journal = createJournal({
      workspaceDir, registry, integrations: createIntegrations(release), ledger,
      write: async (filePath, candidate, options) => {
        writes.push(structuredClone(candidate));
        await writeJsonFileAtomic(filePath, candidate, options);
        if (fault && candidate.ownershipIntents[0]?.phase === 'registry-removed') {
          throw new AtomicJsonWriteError('synthetic directory sync failure', true);
        }
      },
    });
    await journal.initialize();
    await expect(journal.delete('chat')).rejects.toMatchObject({ renamed: true });
    const removed = await readJournal(workspaceDir);
    await expect(journal.delete('chat')).rejects.toMatchObject({ renamed: true });
    expect(registry.removeChat).toHaveBeenCalledTimes(1);
    expect(ledger.deleteChat).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    fault = false;
    await journal.delete('chat');
    await journal.waitForProviderCleanup();

    expect(writes.slice(1, 4)).toEqual([removed, removed, removed]);
    expect(ledger.deleteChat).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(journal.hasPending('chat')).toBeFalse();
  });

  it('retries ledger cleanup after registry removal without creating another decision', async () => {
    const registry = createRegistry({ chat: chat() });
    const release = mock(async () => {});
    const ledger = { deleteChat: mock(() => {}).mockImplementationOnce(() => { throw new Error('synthetic ledger cleanup failure'); }) };
    const journal = createJournal({ workspaceDir, registry, integrations: createIntegrations(release), ledger });
    await journal.initialize();

    await expect(journal.delete('chat')).rejects.toThrow('synthetic ledger cleanup failure');
    const decided = await readJournal(workspaceDir);
    expect(decided.ownershipIntents[0].phase).toBe('registry-removed');
    expect(registry.getChat('chat')).toBeNull();
    expect(release).not.toHaveBeenCalled();
    await journal.delete('chat');
    await journal.waitForProviderCleanup();

    expect(registry.removeChat).toHaveBeenCalledTimes(1);
    expect(ledger.deleteChat).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledTimes(1);
    expect(journal.hasPending('chat')).toBeFalse();
  });

  it('retries the registry flush after in-memory removal before deleting the ledger', async () => {
    const registry = createRegistry({ chat: chat() });
    registry.flush.mockRejectedValueOnce(new Error('synthetic registry flush failure'));
    const release = mock(async () => {});
    const ledger = { deleteChat: mock(() => {}) };
    const journal = createJournal({ workspaceDir, registry, integrations: createIntegrations(release), ledger });
    await journal.initialize();

    await expect(journal.delete('chat')).rejects.toThrow('synthetic registry flush failure');
    const prepared = await readJournal(workspaceDir);
    expect(prepared.ownershipIntents).toHaveLength(1);
    expect(prepared.ownershipIntents[0].phase).toBe('prepared');
    expect(registry.getChat('chat')).toBeNull();
    expect(ledger.deleteChat).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();

    await expect(journal.delete('chat')).resolves.toEqual({ kind: 'ledger-removed' });
    await journal.waitForProviderCleanup();
    expect(registry.flush).toHaveBeenCalledTimes(2);
    expect(registry.removeChat).toHaveBeenCalledTimes(1);
    expect(ledger.deleteChat).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(journal.hasPending('chat')).toBeFalse();
  });

  it('retains delete cleanup when provider release fails', async () => {
    const reference = referenceFor('source-agent');
    await writeJournal(workspaceDir, {
      version: 6,
      ownershipIntents: [{
        version: 3,
        operationId: 'delete:chat',
        kind: 'delete',
        chatId: 'chat',
        phase: 'registry-removed',
        sourceEpoch: 'source-agent-epoch',
        releaseReferences: [{ executionLocation: testExecutionLocation('source-agent', reference.projectPath), chat: reference }],
        createdAt: timestamp,
      }],
    });
    const release = mock(async () => { throw new Error('provider unavailable'); });
    const ledger = { deleteChat: mock(() => {}) };
    const journal = createJournal({
      workspaceDir,
      registry: createRegistry({}),
      integrations: createIntegrations(release),
      ledger,
    });

    await journal.initialize();
    await journal.waitForProviderCleanup();

    expect(release).toHaveBeenCalledTimes(1);
    expect(ledger.deleteChat).toHaveBeenCalledWith('chat');
    expect((await readJournal(workspaceDir)).ownershipIntents).toHaveLength(1);
  });

  it('retains unavailable-instance cleanup without invoking the same provider on another instance', async () => {
    const release = mock(async () => {});
    const current = chat();
    current.executionLocation.instanceId = 'unavailable-instance';
    const registry = createRegistry({ chat: current });
    const journal = createJournal({ workspaceDir, registry, integrations: createIntegrations(release), ledger: { deleteChat: mock(() => {}) } });
    await journal.initialize();
    const warning = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await journal.delete('chat');
      await journal.waitForProviderCleanup();
      expect(warning).toHaveBeenCalledWith('[chats:ownership-journal]', 'Native cleanup owner unavailable', {
        chatId: 'chat', agentId: current.agentId, ...current.executionLocation,
      });
    } finally {
      warning.mockRestore();
    }
    expect(registry.getChat('chat')).toBeNull();
    expect(release).not.toHaveBeenCalled();
    const intent = (await readJournal(workspaceDir)).ownershipIntents[0];
    expect(intent.releaseReferences[0].executionLocation).toEqual(current.executionLocation);
  });

  it('retries failed provider release in the same process without removing the ledger again', async () => {
    const registry = createRegistry({ chat: chat() });
    const release = mock(async () => {}).mockRejectedValueOnce(new Error('synthetic release failure'));
    const ledger = { deleteChat: mock(() => {}) };
    const journal = createJournal({ workspaceDir, registry, integrations: createIntegrations(release), ledger });
    await journal.initialize();
    await expect(journal.delete('chat')).resolves.toEqual({ kind: 'ledger-removed' });
    await journal.waitForProviderCleanup();
    expect(journal.pendingKind('chat')).toBe('delete');

    await expect(journal.delete('chat')).resolves.toEqual({ kind: 'ledger-removed' });
    await journal.waitForProviderCleanup();
    expect(release).toHaveBeenCalledTimes(2);
    expect(ledger.deleteChat).toHaveBeenCalledTimes(1);
    expect(journal.hasPending('chat')).toBeFalse();
    expect(await readJournal(workspaceDir)).toEqual(emptyOwnershipJournal());
  });

  it('retains the delete fence while the empty journal is visible but its writer has not settled', async () => {
    const registry = createRegistry({ chat: chat() });
    const written = Promise.withResolvers();
    const release = Promise.withResolvers();
    const journal = createJournal({
      workspaceDir, registry, integrations: createIntegrations(), ledger: { deleteChat: mock(() => {}) },
      write: async (filePath, candidate, options) => {
        await writeJsonFileAtomic(filePath, candidate, options);
        if (candidate.ownershipIntents.length === 0) {
          written.resolve();
          await release.promise;
        }
      },
    });
    await journal.initialize();
    try {
      await journal.delete('chat');
      await written.promise;
      expect(await readJournal(workspaceDir)).toEqual(emptyOwnershipJournal());
      expect(registry.getChat('chat')).toBeNull();
      expect(journal.hasPending('chat')).toBeTrue();
      expect(journal.pendingKind('chat')).toBe('delete');
    } finally {
      release.resolve();
      await journal.waitForProviderCleanup();
    }
    expect(journal.hasPending('chat')).toBeFalse();
    expect(journal.pendingKind('chat')).toBeNull();
  });

  it.each([false, true])('retries journal completion after a write failure (renamed: %s)', async (renamed) => {
    const registry = createRegistry({ chat: chat() });
    const release = mock(async () => {});
    const ledger = { deleteChat: mock(() => {}) };
    let fault = true;
    const journal = createJournal({
      workspaceDir, registry, integrations: createIntegrations(release), ledger,
      write: async (filePath, candidate, options) => {
        if (fault && candidate.ownershipIntents.length === 0) {
          if (renamed) await writeJsonFileAtomic(filePath, candidate, options);
          throw new AtomicJsonWriteError('synthetic completion failure', renamed);
        }
        await writeJsonFileAtomic(filePath, candidate, options);
      },
    });
    await journal.initialize();
    await journal.delete('chat');
    await journal.waitForProviderCleanup();
    expect(journal.pendingKind('chat')).toBe('delete');
    fault = false;
    await expect(journal.delete('chat')).resolves.toEqual({ kind: renamed ? 'not-found' : 'ledger-removed' });
    await journal.waitForProviderCleanup();
    expect(release).toHaveBeenCalledTimes(renamed ? 1 : 2);
    expect(ledger.deleteChat).toHaveBeenCalledTimes(1);
    expect(journal.hasPending('chat')).toBeFalse();
    expect(await readJournal(workspaceDir)).toEqual(emptyOwnershipJournal());
  });

  it.each([true, false])('keeps raw profile settings until the exact release owner is available (stored: %s)', async (stored) => {
    const originalSettings = { ...envelope('source-agent'), values: { profileOnly: 'synthetic-value' } };
    const original = chat('source-agent', {
      agentSettingsById: stored ? { 'source-agent': originalSettings } : {},
    });
    original.executionLocation.instanceId = 'secondary-profile';
    const registry = createRegistry({ chat: original });
    const integrations = createIntegrations();
    const defaultParse = mock(() => { throw new Error('default parser must not receive secondary settings'); });
    integrations.require('source-agent').settings.parse = defaultParse;
    const release = mock(async () => {});
    const defaults = { ...envelope('source-agent'), values: { profileOnly: 'secondary-default' } };
    const parse = mock((input) => ({ ...input, values: { ...input.values, parsedBy: 'secondary' } }));
    const secondary = {
      ...integrations.require('source-agent'),
      settings: { defaults: () => defaults, parse },
      nativeSessions: { release },
    };
    let available = false;
    const options = {
      workspaceDir, registry, integrations, ledger: { deleteChat: mock(() => {}) },
      resolveNativeSessions: () => available ? new LocalProviderNativeSessionService(secondary) : null,
    };
    const journal = createJournal(options);
    await journal.initialize();
    await journal.delete('chat');
    await journal.waitForProviderCleanup();
    expect((await readJournal(workspaceDir)).ownershipIntents[0].releaseReferences[0].chat.settings)
      .toEqual(stored ? originalSettings : null);
    expect(defaultParse).not.toHaveBeenCalled();
    expect(parse).not.toHaveBeenCalled();

    available = true;
    const restarted = createJournal(options);
    await restarted.initialize();
    await restarted.waitForProviderCleanup();
    expect(parse).toHaveBeenCalledWith(stored ? originalSettings : defaults);
    expect(release.mock.calls[0][0].chat.settings.values).toEqual({
      ...(stored ? originalSettings.values : defaults.values), parsedBy: 'secondary',
    });
    expect(restarted.hasPending('chat')).toBeFalse();
  });
});

function persistedHandoff() {
  return {
    version: 6,
    operationId: 'handoff:request-1',
    clientRequestId: 'request-1',
    submittedTargetHash: 'a'.repeat(64),
    kind: 'handoff',
    chatId: 'chat',
    phase: 'commit-decided',
    source: { agentId: 'source-agent', agentOwnershipEpoch: 'source-agent-epoch', executionLocation: testExecutionLocation('source-agent', '/workspace/project') },
    target: { execution: target(), agentOwnershipEpoch: 'target-epoch' },
    watermark: { viewId: 'view-1', ordinal: 7 },
    createdAt: timestamp,
  };
}

function referenceFor(agentId) {
  return {
    chatId: 'chat',
    agentId,
    agentSessionId: `${agentId}-session`,
    projectPath: '/workspace/project',
    model: `${agentId}-model`,
    nativeSession: null,
    carryOverRevision: 'carry-v1:0',
    nativeSeedReceipt: null,
    settings: envelope(agentId),
    agentOwnershipEpoch: `${agentId}-epoch`,
  };
}

async function readJournal(workspaceDir) {
  return JSON.parse(await fs.readFile(
    path.join(workspaceDir, 'agent-ownership-journal.json'),
    'utf8',
  ));
}

function writeJournal(workspaceDir, journal) {
  return fs.writeFile(
    path.join(workspaceDir, 'agent-ownership-journal.json'),
    JSON.stringify(journal),
  );
}
