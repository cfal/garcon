import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AgentOwnershipJournal,
  emptyOwnershipJournalV5,
} from '../agent-ownership-journal.js';

const timestamp = '2026-01-01T00:00:00.000Z';

function envelope(ownerId) {
  return { ownerId, schemaVersion: 1, values: {} };
}

function chat(agentId = 'source-agent', overrides = {}) {
  return {
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
    installAgentOwnership: mock(async (chatId, { nodeId, projectPath, patch }) => {
      const current = entries.get(chatId);
      if (!current) return null;
      Object.assign(current, patch, { nodeId: nodeId === 'local' ? undefined : nodeId, projectPath });
      return { id: chatId, ...current };
    }),
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

  it('reloads and applies node/path ownership without live integration discovery', async () => {
    const nodeId = '22222222-2222-4222-8222-222222222222';
    const registry = createRegistry({ chat: chat() });
    const integrations = { get: () => null, require: () => { throw new Error('offline'); } };
    const options = { workspaceDir, registry, integrations, ledger: { deleteChat: mock(() => {}) } };
    const journal = new AgentOwnershipJournal(options);
    await journal.initialize();
    const intent = await journal.decideHandoff(decisionInput(registry, {
      target: { ...target(), nodeId, projectPath: '/worker/project' },
    }));
    expect(journal.referencesNode(nodeId)).toBe(true);
    expect(journal.blocksNodeRemoval(nodeId)).toBe(true);
    const restarted = new AgentOwnershipJournal(options);
    await restarted.initialize();
    await restarted.applyHandoffDecision(intent.operationId);
    expect(registry.installAgentOwnership).toHaveBeenCalledTimes(1);
    expect(registry.getChat('chat')).toMatchObject({ nodeId, projectPath: '/worker/project', agentSessionId: null });
    await restarted.completeHandoff(intent.operationId);
    expect(restarted.referencesNode(nodeId)).toBe(false);
    expect(restarted.blocksNodeRemoval(nodeId)).toBe(false);
  });

  it('persists the complete handoff decision and accepts an identical retry', async () => {
    const registry = createRegistry({ chat: chat() });
    const journal = new AgentOwnershipJournal({
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
      version: 5,
      phase: 'commit-decided',
      source: { agentId: 'source-agent', agentOwnershipEpoch: 'source-agent-epoch' },
      target: { execution: target(), agentOwnershipEpoch: 'target-epoch' },
      watermark: { viewId: 'view-1', ordinal: 7 },
    });
    expect(journal.pendingHandoffs()).toEqual([first]);
    expect(await readJournal(workspaceDir)).toEqual({
      version: 5,
      ownershipIntents: [first],
    });
  });

  it('rejects a conflicting retry without changing the durable decision', async () => {
    const registry = createRegistry({ chat: chat() });
    const journal = new AgentOwnershipJournal({
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

  it('rolls registry ownership forward without deleting the source transcript', async () => {
    const registry = createRegistry({ chat: chat() });
    const release = mock(async () => {});
    const journal = new AgentOwnershipJournal({
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
    expect(await readJournal(workspaceDir)).toEqual(emptyOwnershipJournalV5());
  });

  it('preserves the chat preamble selection and revision across the roll-forward', async () => {
    const selectedId = '3502b645-222b-49d2-ac39-1c91f9fb1174';
    const registry = createRegistry({
      chat: chat('source-agent', {
        preambleSelection: { revision: 3, orderedPreambleIds: [selectedId] },
      }),
    });
    const journal = new AgentOwnershipJournal({
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
      version: 5,
      ownershipIntents: [persisted],
    });
    const journal = new AgentOwnershipJournal({
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
      version: 5,
      ownershipIntents: [{ ...persistedHandoff(), watermark: { viewId: '', ordinal: -1 } }],
    });
    const journal = new AgentOwnershipJournal({
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
    const journal = new AgentOwnershipJournal({
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
    const journal = new AgentOwnershipJournal({
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
    const journal = new AgentOwnershipJournal({
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

  it('does not let blocked cleanup A delay delete B', async () => {
    const registry = createRegistry({ chatA: chat(), chatB: chat('target-agent') });
    let releaseA;
    const release = mock((request) => {
      if (request.chat.chatId === 'chatA') return new Promise((resolve) => { releaseA = resolve; });
      return Promise.resolve();
    });
    const journal = new AgentOwnershipJournal({
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
    const journal = new AgentOwnershipJournal({
      workspaceDir,
      registry,
      integrations: createIntegrations(release),
      ledger,
    });
    await journal.initialize();

    await journal.delete('chat');
    registry.setChat('chat', replacement);
    releaseProvider();
    await journal.waitForProviderCleanup();

    expect(ledger.deleteChat).toHaveBeenCalledTimes(1);
    expect(registry.getChat('chat')).toBe(replacement);
    expect((await readJournal(workspaceDir)).ownershipIntents).toEqual([]);
  });

  it.each(['delete', 'recover-prepared', 'recover-removed'])('retains failed controller-ledger cleanup during node retirement (%s)', async (mode) => {
    const nodeId = '22222222-2222-4222-8222-222222222222';
    const registry = createRegistry({ chat: chat('source-agent', { nodeId }) });
    const ledger = { deleteChat: mock(() => {}) };
    ledger.deleteChat.mockImplementationOnce(() => { throw new Error('Synthetic ledger deletion failure'); });
    const release = mock(async () => {});
    let configured = true;
    const options = { workspaceDir, registry, ledger, integrations: createIntegrations(release), isNodeConfigured: () => configured };
    const journal = new AgentOwnershipJournal(options);
    if (mode !== 'delete') {
      registry.removeChat('chat');
      await writeJournal(workspaceDir, { version: 5, ownershipIntents: [{
        version: 2, operationId: 'delete:chat', kind: 'delete', chatId: 'chat',
        phase: mode === 'recover-prepared' ? 'prepared' : 'registry-removed',
        sourceEpoch: 'source-agent-epoch', createdAt: timestamp,
        releaseReferences: [{ ...referenceFor('source-agent'), nodeId }],
      }] });
    }
    await journal.initialize();
    if (mode === 'delete') await expect(journal.delete('chat')).rejects.toThrow('Synthetic ledger deletion failure');
    expect(journal.blocksNodeRemoval(nodeId)).toBe(true);
    configured = false;
    await journal.retireRemovedNode(nodeId);
    expect((await readJournal(workspaceDir)).ownershipIntents).toHaveLength(1);
    expect(release).not.toHaveBeenCalled();
    const restarted = new AgentOwnershipJournal(options);
    await restarted.initialize();
    await restarted.waitForProviderCleanup();
    expect(ledger.deleteChat).toHaveBeenCalledTimes(2);
    expect(await readJournal(workspaceDir)).toEqual(emptyOwnershipJournalV5());
    expect(release).not.toHaveBeenCalled();
  });

  it('retains offline cleanup without blocking node removal, then retires it when the node is forgotten', async () => {
    const nodeId = '22222222-2222-4222-8222-222222222222';
    const registry = createRegistry({ chat: chat('source-agent', { nodeId }) });
    let configured = true;
    const journal = new AgentOwnershipJournal({
      workspaceDir, registry, integrations: { get: () => null },
      ledger: { deleteChat: mock(() => {}) },
      isNodeConfigured: () => configured,
    });
    await journal.initialize();
    const flushed = Promise.withResolvers();
    const finishFlush = Promise.withResolvers();
    registry.flush.mockImplementationOnce(async () => { flushed.resolve(); await finishFlush.promise; });
    const deleting = journal.delete('chat');
    await flushed.promise;
    expect(journal.blocksNodeRemoval(nodeId)).toBe(true);
    finishFlush.resolve();
    await deleting;
    await journal.waitForProviderCleanup();
    expect(journal.referencesNode(nodeId)).toBe(true);
    expect(journal.blocksNodeRemoval(nodeId)).toBe(false);
    await journal.retireRemovedNode(nodeId);
    expect(journal.hasPending('chat')).toBe(true);
    configured = false;
    await journal.retireRemovedNode(nodeId);
    expect(await readJournal(workspaceDir)).toEqual(emptyOwnershipJournalV5());
  });

  it('retires removed-node cleanup on restart without releasing artifacts on another node', async () => {
    const nodeId = '22222222-2222-4222-8222-222222222222';
    const registry = createRegistry({ chat: chat('source-agent', { nodeId }) });
    const options = { workspaceDir, registry, ledger: { deleteChat: mock(() => {}) } };
    const journal = new AgentOwnershipJournal({ ...options, integrations: { get: () => null } });
    await journal.initialize();
    await journal.delete('chat');
    await journal.waitForProviderCleanup();
    const release = mock(async () => {});
    const restarted = new AgentOwnershipJournal({
      ...options, integrations: createIntegrations(release), isNodeConfigured: (id) => id === 'local',
    });
    await restarted.initialize();
    await restarted.waitForProviderCleanup();
    expect(release).not.toHaveBeenCalled();
    expect(await readJournal(workspaceDir)).toEqual(emptyOwnershipJournalV5());
  });

  it.each([false, true])('retries only the ready node native cleanup (restart=%s)', async (restart) => {
    const nodeId = '22222222-2222-4222-8222-222222222222';
    const otherNodeId = '33333333-3333-4333-8333-333333333333';
    const registry = createRegistry({
      chat: chat('source-agent', { nodeId }),
      other: chat('source-agent', { nodeId: otherNodeId }),
    });
    const release = mock(async () => {});
    const available = new Set();
    const native = createIntegrations(release);
    const options = {
      workspaceDir, registry, ledger: { deleteChat: mock(() => {}) },
      integrations: { get: (agentId, node) => available.has(node) ? native.get(agentId) : null },
    };
    let journal = new AgentOwnershipJournal(options);
    await journal.initialize();
    await journal.delete('chat');
    await journal.delete('other');
    await journal.waitForProviderCleanup();
    if (restart) {
      journal = new AgentOwnershipJournal(options);
      await journal.initialize();
      await journal.waitForProviderCleanup();
    }
    expect(release).not.toHaveBeenCalled();
    expect((await readJournal(workspaceDir)).ownershipIntents).toHaveLength(2);
    const ledgerDeletes = options.ledger.deleteChat.mock.calls.length;
    available.add(nodeId);
    await Promise.all([journal.retryProviderCleanup(nodeId), journal.retryProviderCleanup(nodeId)]);
    expect(release).toHaveBeenCalledTimes(1);
    expect(release.mock.calls[0][0].chat.chatId).toBe('chat');
    expect(journal.referencesNode(nodeId)).toBe(false);
    expect(journal.referencesNode(otherNodeId)).toBe(true);
    expect(options.ledger.deleteChat).toHaveBeenCalledTimes(ledgerDeletes);
  });

  it('retains a failed readiness cleanup and retries on the next readiness edge', async () => {
    const nodeId = '22222222-2222-4222-8222-222222222222';
    const release = mock(async () => { throw new Error('Synthetic release failure'); });
    const journal = new AgentOwnershipJournal({
      workspaceDir, registry: createRegistry({ chat: chat('source-agent', { nodeId }) }),
      integrations: createIntegrations(release), ledger: { deleteChat: mock(() => {}) },
    });
    await journal.initialize();
    await journal.delete('chat');
    await journal.waitForProviderCleanup();
    await journal.retryProviderCleanup(nodeId);
    expect(release).toHaveBeenCalledTimes(2);
    expect(journal.hasPending('chat')).toBe(true);
    release.mockImplementation(async () => {});
    await journal.retryProviderCleanup(nodeId);
    expect(release).toHaveBeenCalledTimes(3);
    expect(await readJournal(workspaceDir)).toEqual(emptyOwnershipJournalV5());
  });

  it('retires cleanup queued behind an in-flight release without resurrecting the intent', async () => {
    const nodeId = '22222222-2222-4222-8222-222222222222';
    const registry = createRegistry({ chat: chat('source-agent', { nodeId }) });
    const pending = Promise.withResolvers();
    const started = Promise.withResolvers();
    const release = mock(async () => { started.resolve(); await pending.promise; });
    let configured = true;
    const journal = new AgentOwnershipJournal({
      workspaceDir, registry, integrations: createIntegrations(release),
      ledger: { deleteChat: mock(() => {}) }, isNodeConfigured: () => configured,
    });
    await journal.initialize();
    await journal.delete('chat');
    await started.promise;
    configured = false;
    const retiring = journal.retireRemovedNode(nodeId);
    pending.reject(new Error('Node removed'));
    await retiring;
    expect(release).toHaveBeenCalledTimes(1);
    expect(await readJournal(workspaceDir)).toEqual(emptyOwnershipJournalV5());
  });

  it('retains delete cleanup when provider release fails', async () => {
    const reference = referenceFor('source-agent');
    await writeJournal(workspaceDir, {
      version: 5,
      ownershipIntents: [{
        version: 2,
        operationId: 'delete:chat',
        kind: 'delete',
        chatId: 'chat',
        phase: 'registry-removed',
        sourceEpoch: 'source-agent-epoch',
        releaseReferences: [reference],
        createdAt: timestamp,
      }],
    });
    const release = mock(async () => { throw new Error('provider unavailable'); });
    const ledger = { deleteChat: mock(() => {}) };
    const journal = new AgentOwnershipJournal({
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
});

function persistedHandoff() {
  return {
    version: 5,
    operationId: 'handoff:request-1',
    clientRequestId: 'request-1',
    submittedTargetHash: 'a'.repeat(64),
    kind: 'handoff',
    chatId: 'chat',
    phase: 'commit-decided',
    source: { agentId: 'source-agent', agentOwnershipEpoch: 'source-agent-epoch' },
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
