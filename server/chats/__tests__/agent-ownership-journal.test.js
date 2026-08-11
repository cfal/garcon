import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AgentOwnershipJournal,
  emptyOwnershipJournalV4,
} from '../agent-ownership-journal.js';
import { carryOverRevision } from '../carryover-segments.js';
import { ChatRegistry } from '../store.ts';

const timestamp = '2026-01-01T00:00:00.000Z';

function envelope(ownerId) {
  return { ownerId, schemaVersion: 1, values: {} };
}

function chat(agentId = 'source-agent', overrides = {}) {
  return {
    agentId,
    agentSessionId: `${agentId}-session`,
    nativeSession: {
      ownerId: agentId,
      schemaVersion: 1,
      value: { id: `${agentId}-session` },
    },
    nativeSeedReceipt: null,
    carryOverSegments: [],
    carryOverMigrationQuarantine: null,
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
  let failUpdateBeforeCommit = false;
  return {
    entries,
    setFailUpdateBeforeCommit(value) {
      failUpdateBeforeCommit = value;
    },
    getChat: (chatId) => entries.get(chatId) ?? null,
    listAllChats: () => Object.fromEntries(entries),
    updateChat: mock(async (chatId, patch) => {
      if (failUpdateBeforeCommit) throw new Error('registry write failed');
      const current = entries.get(chatId);
      if (!current) return null;
      Object.assign(current, patch);
      return { id: chatId, ...current };
    }),
    removeChat: mock((chatId) => entries.delete(chatId)),
    flush: mock(async () => {}),
  };
}

function createIntegrations(release) {
  const byId = new Map(['source-agent', 'target-agent'].map((agentId) => [agentId, {
    descriptor: { id: agentId },
    settings: {
      defaults: () => envelope(agentId),
      parse: (input) => input,
    },
    transcript: {
      release,
      prepareOwnershipSegment: mock(async ({ chat }) => ({
        kind: 'ready',
        value: {
          checkpoint: checkpoint(chat.agentOwnershipEpoch, 'target-content', 0),
          commitAfterDecision: mock(async () => {}),
          rollbackBeforeDecision: mock(async () => {}),
        },
      })),
    },
  }]));
  return {
    get: (agentId) => byId.get(agentId),
    require(agentId) {
      const integration = byId.get(agentId);
      if (!integration) throw new Error(`missing integration ${agentId}`);
      return integration;
    },
    remove(agentId) {
      byId.delete(agentId);
    },
  };
}

function begin(journal, registry, overrides = {}) {
  return journal.beginHandoff({
    operationId: 'handoff:request-1',
    clientRequestId: 'request-1',
    submittedTargetHash: 'a'.repeat(64),
    chatId: 'chat',
    source: registry.getChat('chat'),
    target: target(),
    targetCarryOverSegments: [segmentRef()],
    ...overrides,
  });
}

describe('AgentOwnershipJournal', () => {
  let workspaceDir;

  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-ownership-journal-'));
  });

  afterEach(async () => {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it('commits ownership before releasing the source transcript', async () => {
    const quarantine = { artifactId: 'legacy-artifact', errorCode: 'INVALID_CARRYOVER_ENTRY' };
    const registry = createRegistry({
      chat: chat('source-agent', { carryOverMigrationQuarantine: quarantine }),
    });
    const releases = [];
    const integrations = createIntegrations(mock(async (request) => releases.push(request)));
    const journal = new AgentOwnershipJournal({ workspaceDir, registry, integrations });
    await journal.initialize();
    const intent = await begin(journal, registry);

    await stageAndDecide(journal, intent);
    const updated = await journal.applyHandoffDecision(intent.operationId);
    await journal.completeHandoff(intent.operationId);
    await journal.drainTransferCleanup();

    expect(updated).toMatchObject({
      agentId: 'target-agent',
      carryOverSegments: intent.target.carryOverSegments,
      agentOwnershipEpoch: intent.target.agentOwnershipEpoch,
      agentSessionId: null,
      nativeSeedReceipt: null,
      carryOverMigrationQuarantine: quarantine,
    });
    expect(releases).toHaveLength(1);
    expect(releases[0]).toMatchObject({
      reason: 'transferred',
      chat: { agentId: 'source-agent', agentSessionId: 'source-agent-session' },
    });
    expect(await readJournal(workspaceDir)).toEqual(emptyOwnershipJournalV4());
  });

  it('keeps source ownership when the registry commit fails', async () => {
    const registry = createRegistry({ chat: chat() });
    registry.setFailUpdateBeforeCommit(true);
    const release = mock(async () => {});
    const journal = new AgentOwnershipJournal({
      workspaceDir,
      registry,
      integrations: createIntegrations(release),
    });
    await journal.initialize();
    const intent = await begin(journal, registry);

    await stageAndDecide(journal, intent);
    await expect(journal.applyHandoffDecision(intent.operationId))
      .rejects.toThrow('registry write failed');
    registry.setFailUpdateBeforeCommit(false);
    await journal.applyHandoffDecision(intent.operationId);
    await journal.completeHandoff(intent.operationId);
    await journal.drainTransferCleanup();

    expect(registry.getChat('chat').agentId).toBe('target-agent');
    expect(await readJournal(workspaceDir)).toMatchObject({ ownershipIntents: [] });
  });

  it('accepts only an identical retry after handoff staging is durable', async () => {
    const registry = createRegistry({ chat: chat() });
    const journal = new AgentOwnershipJournal({
      workspaceDir,
      registry,
      integrations: createIntegrations(mock(async () => {})),
    });
    await journal.initialize();
    const intent = await begin(journal, registry);
    const staged = {
      operationId: intent.operationId,
      targetCarryOverSegments: intent.target.carryOverSegments,
      sourceCheckpoint: checkpoint(intent.source.agentOwnershipEpoch, 'source-content', 1),
      incomingCheckpoint: checkpoint(intent.target.agentOwnershipEpoch, 'target-content', 0),
    };

    await expect(journal.stageHandoff(staged)).resolves.toMatchObject({ phase: 'staged' });
    await expect(journal.stageHandoff(staged)).resolves.toMatchObject({ phase: 'staged' });
    await expect(journal.stageHandoff({
      ...staged,
      incomingCheckpoint: checkpoint(intent.target.agentOwnershipEpoch, 'changed-content', 0),
    })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('compensates a real registry flush failure without releasing the source', async () => {
    const chatId = '1786000000000001';
    const registry = new ChatRegistry(workspaceDir);
    await registry.init();
    registry.addChat({ id: chatId, ...chat() });
    await registry.flush();
    const release = mock(async () => {});
    const journal = new AgentOwnershipJournal({
      workspaceDir,
      registry,
      integrations: createIntegrations(release),
    });
    await journal.initialize();
    const intent = await begin(journal, registry, {
      chatId,
      source: registry.getChat(chatId),
    });
    const saveRegistry = registry.saveRegistry.bind(registry);
    registry.saveRegistry = mock(() => Promise.reject(new Error('registry write failed')));

    await stageAndDecide(journal, intent);
    await expect(journal.applyHandoffDecision(intent.operationId))
      .rejects.toThrow('registry write failed');
    registry.saveRegistry = saveRegistry;
    await journal.applyHandoffDecision(intent.operationId);
    await journal.completeHandoff(intent.operationId);
    await journal.drainTransferCleanup();

    expect(registry.getChat(chatId)).toMatchObject({
      agentId: 'target-agent',
      agentSessionId: null,
    });
    const restarted = new ChatRegistry(workspaceDir);
    await restarted.init();
    expect(restarted.getChat(chatId)).toMatchObject({
      agentId: 'target-agent',
      agentSessionId: null,
    });
  });

  it('serializes deletion behind an in-flight transfer release', async () => {
    const registry = createRegistry({ chat: chat() });
    let releaseTransfer;
    let transferStarted;
    const started = new Promise((resolve) => { transferStarted = resolve; });
    const releases = [];
    const release = mock(async (request) => {
      releases.push(request);
      if (request.reason === 'transferred') {
        transferStarted();
        await new Promise((resolve) => { releaseTransfer = resolve; });
      }
    });
    const journal = new AgentOwnershipJournal({
      workspaceDir,
      registry,
      integrations: createIntegrations(release),
    });
    await journal.initialize();
    const intent = await begin(journal, registry);
    await stageAndDecide(journal, intent);
    await journal.applyHandoffDecision(intent.operationId);
    await journal.completeHandoff(intent.operationId);
    await started;

    let deletionFinished = false;
    const deleting = journal.delete('chat').then(() => { deletionFinished = true; });
    await Promise.resolve();
    expect(deletionFinished).toBeFalse();
    releaseTransfer();
    await deleting;

    expect(registry.getChat('chat')).toBeNull();
    expect(releases.map((request) => request.reason)).toEqual(['transferred', 'deleted']);
    expect(await readJournal(workspaceDir)).toEqual(emptyOwnershipJournalV4());
  });

  it('retains delete cleanup without blocking startup when release fails', async () => {
    const registry = createRegistry({});
    const reference = referenceFor('source-agent');
    await fs.writeFile(path.join(workspaceDir, 'agent-ownership-journal.json'), JSON.stringify({
      version: 4,
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
      transferCleanup: [],
    }));
    const release = mock(async () => { throw new Error('provider unavailable'); });
    const journal = new AgentOwnershipJournal({
      workspaceDir,
      registry,
      integrations: createIntegrations(release),
    });

    await expect(journal.initialize()).resolves.toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(release).toHaveBeenCalledTimes(1);
    expect((await readJournal(workspaceDir)).ownershipIntents).toMatchObject([{
      operationId: 'delete:chat',
      releaseReferences: [reference],
    }]);
  });

  it('retains delete cleanup when its integration is missing', async () => {
    const registry = createRegistry({});
    const reference = referenceFor('removed-agent');
    await fs.writeFile(path.join(workspaceDir, 'agent-ownership-journal.json'), JSON.stringify({
      version: 4,
      ownershipIntents: [{
        version: 2,
        operationId: 'delete:chat',
        kind: 'delete',
        chatId: 'chat',
        phase: 'registry-removed',
        sourceEpoch: null,
        releaseReferences: [reference],
        createdAt: timestamp,
      }],
      transferCleanup: [],
    }));
    const journal = new AgentOwnershipJournal({
      workspaceDir,
      registry,
      integrations: createIntegrations(mock(async () => {})),
    });

    await expect(journal.initialize()).resolves.toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect((await readJournal(workspaceDir)).ownershipIntents).toHaveLength(1);
  });

  it('rolls a durable decision forward when the registry still names the source', async () => {
    const registry = createRegistry({ chat: chat() });
    const inconsistent = persistedHandoff({ phase: 'commit-decided' });
    await writeJournal(workspaceDir, {
      version: 4,
      ownershipIntents: [inconsistent],
      transferCleanup: [],
    });
    const journal = new AgentOwnershipJournal({
      workspaceDir,
      registry,
      integrations: createIntegrations(mock(async () => {})),
    });

    await expect(journal.initialize()).resolves.toBeUndefined();

    expect(registry.getChat('chat')).toMatchObject({
      agentId: 'target-agent',
      agentOwnershipEpoch: 'target-epoch',
      transcriptContentEpoch: 'target-content',
    });
    expect((await readJournal(workspaceDir)).ownershipIntents).toEqual([]);
    await journal.drainTransferCleanup();
  });

  it('abandons a transfer release after three provider failures and retries it through maintenance', async () => {
    const registry = createRegistry({ chat: chat() });
    let failing = true;
    const release = mock(async () => {
      if (failing) throw new Error('provider unavailable');
    });
    const journal = new AgentOwnershipJournal({
      workspaceDir,
      registry,
      integrations: createIntegrations(release),
    });
    await journal.initialize();
    const intent = await begin(journal, registry);
    await stageAndDecide(journal, intent);
    await journal.applyHandoffDecision(intent.operationId);
    await journal.completeHandoff(intent.operationId);

    // One implicit drain from the commit plus explicit drains: three provider
    // failures spend the attempt budget and abandon the record durably.
    for (let drain = 0; drain < 3; drain += 1) {
      await journal.drainTransferCleanup();
    }
    expect(journal.abandonedTransferCleanups()).toMatchObject([{
      chatId: 'chat',
      status: 'abandoned',
      attempts: 3,
      lastErrorCode: 'Error',
    }]);
    expect((await readJournal(workspaceDir)).transferCleanup).toMatchObject([{
      status: 'abandoned',
    }]);

    // A failed maintenance retry keeps the reference rather than discarding
    // it, and reports the record as unresolved even though it is only pending:
    // the provider residue is still out there.
    const failedRetry = await journal.retryRetainedTransferCleanups();
    expect(failedRetry.retried).toHaveLength(1);
    expect(failedRetry.unresolved).toMatchObject([{ status: 'pending', attempts: 1 }]);
    expect(journal.abandonedTransferCleanups()).toHaveLength(0);
    expect((await readJournal(workspaceDir)).transferCleanup).toMatchObject([{
      status: 'pending',
      attempts: 1,
    }]);

    // The same command stays usable after the provider is repaired: it selects
    // the pending record the first call left behind and releases it.
    failing = false;
    const retry = await journal.retryRetainedTransferCleanups();
    expect(retry.retried).toHaveLength(1);
    expect(retry.unresolved).toHaveLength(0);
    expect(release).toHaveBeenCalledTimes(5);

    expect(await readJournal(workspaceDir)).toEqual(emptyOwnershipJournalV4());
  });

  it('retires a handoff intent superseded by a newer ownership epoch', async () => {
    const registry = createRegistry({
      chat: chat('target-agent', {
        agentOwnershipEpoch: 'newer-epoch',
        carryOverSegments: [segmentRef({ id: 'd5f2380b-6228-49f5-8484-b2d7e16380ab' })],
      }),
    });
    await writeJournal(workspaceDir, {
      version: 4,
      ownershipIntents: [persistedHandoff()],
      transferCleanup: [],
    });
    const journal = new AgentOwnershipJournal({
      workspaceDir,
      registry,
      integrations: createIntegrations(mock(async () => {})),
    });

    await expect(journal.initialize()).resolves.toBeUndefined();

    expect((await readJournal(workspaceDir)).ownershipIntents).toEqual([]);
  });

  it('rejects malformed handoff records before recovery dereferences them', async () => {
    await writeJournal(workspaceDir, {
      version: 4,
      ownershipIntents: [{
        version: 4,
        operationId: 'handoff:malformed',
        clientRequestId: 'request-malformed',
        submittedTargetHash: 'a'.repeat(64),
        kind: 'handoff',
        chatId: 'chat',
        phase: 'intent',
        source: {},
        target: {},
        staging: null,
        createdAt: timestamp,
      }],
      transferCleanup: [],
    });
    const journal = new AgentOwnershipJournal({
      workspaceDir,
      registry: createRegistry({}),
      integrations: createIntegrations(mock(async () => {})),
    });

    await expect(journal.initialize()).rejects.toThrow('Invalid agent ownership journal');
  });
});

function persistedHandoff(overrides = {}) {
  const source = chat();
  const staging = {
    sourceCheckpoint: checkpoint('source-agent-epoch', 'source-content', 1),
    incomingCheckpoint: checkpoint('target-epoch', 'target-content', 0),
  };
  return {
    version: 4,
    operationId: 'handoff:request-1',
    clientRequestId: 'request-1',
    submittedTargetHash: 'a'.repeat(64),
    kind: 'handoff',
    chatId: 'chat',
    phase: 'staged',
    source: {
      agentId: source.agentId,
      model: source.model,
      sessionId: source.agentSessionId,
      agentOwnershipEpoch: source.agentOwnershipEpoch,
      carryOverRevision: carryOverRevision(
        source.carryOverSegments,
        source.carryOverMigrationQuarantine,
      ),
      nativeSeedReceipt: source.nativeSeedReceipt,
      reference: referenceFor('source-agent'),
    },
    target: {
      execution: target(),
      agentOwnershipEpoch: 'target-epoch',
      carryOverSegments: [segmentRef()],
    },
    staging,
    createdAt: timestamp,
    ...overrides,
  };
}

function segmentRef(overrides = {}) {
  return {
    id: '7f1bb17c-0cc5-4a0d-b762-2c14b04c5f2e',
    agentId: 'source-agent',
    model: 'source-agent-model',
    capturedAt: timestamp,
    storedMessageCount: 1,
    visibleMessageCount: 1,
    trailingHandoff: { agentId: 'target-agent', model: 'target-agent-model' },
    ...overrides,
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

async function stageAndDecide(journal, intent) {
  await journal.stageHandoff({
    operationId: intent.operationId,
    targetCarryOverSegments: intent.target.carryOverSegments,
    sourceCheckpoint: checkpoint(intent.source.agentOwnershipEpoch, 'source-content', 1, intent.chatId),
    incomingCheckpoint: checkpoint(intent.target.agentOwnershipEpoch, 'target-content', 0, intent.chatId),
  });
  return journal.decideHandoff(intent.operationId);
}

function checkpoint(agentOwnershipEpoch, contentEpoch, total, chatId = 'chat') {
  return {
    chatId,
    agentOwnershipEpoch,
    offset: '0',
    projection: {
      epoch: `${agentOwnershipEpoch}-stream`,
      contentEpoch,
      total,
      durableCount: total,
      durableRevision: `revision-${total}`,
      stateRevision: `state-${total}`,
    },
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
