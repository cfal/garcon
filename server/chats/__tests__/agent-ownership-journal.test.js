import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AgentOwnershipJournal,
  emptyOwnershipJournalV2,
} from '../agent-ownership-journal.js';

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
    carryOverHeadId: null,
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
    transcript: { release },
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
    targetHistoryHeadId: '7f1bb17c-0cc5-4a0d-b762-2c14b04c5f2e',
    preparedNodeId: '7f1bb17c-0cc5-4a0d-b762-2c14b04c5f2e',
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

    const updated = await journal.commitHandoff(intent.operationId, () => {});
    await journal.drainTransferCleanup();

    expect(updated).toMatchObject({
      agentId: 'target-agent',
      carryOverHeadId: intent.target.historyHeadId,
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
    expect(await readJournal(workspaceDir)).toEqual(emptyOwnershipJournalV2());
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

    await expect(journal.commitHandoff(intent.operationId, () => {}))
      .rejects.toThrow('registry write failed');
    await journal.compensateHandoff(intent.operationId);

    expect(registry.getChat('chat').agentId).toBe('source-agent');
    expect(release).not.toHaveBeenCalled();
    expect(await readJournal(workspaceDir)).toEqual(emptyOwnershipJournalV2());
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
    await journal.commitHandoff(intent.operationId, () => {});
    await started;

    let deletionFinished = false;
    const deleting = journal.delete('chat').then(() => { deletionFinished = true; });
    await Promise.resolve();
    expect(deletionFinished).toBeFalse();
    releaseTransfer();
    await deleting;

    expect(registry.getChat('chat')).toBeNull();
    expect(releases.map((request) => request.reason)).toEqual(['transferred', 'deleted']);
    expect(await readJournal(workspaceDir)).toEqual(emptyOwnershipJournalV2());
  });

  it('retains delete cleanup without blocking startup when release fails', async () => {
    const registry = createRegistry({});
    const reference = referenceFor('source-agent');
    await fs.writeFile(path.join(workspaceDir, 'agent-ownership-journal.json'), JSON.stringify({
      version: 2,
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
      version: 2,
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

  it('retains an inconsistent intent without blocking unrelated startup recovery', async () => {
    const registry = createRegistry({ chat: chat() });
    const inconsistent = persistedHandoff({ phase: 'registry-committed' });
    await writeJournal(workspaceDir, {
      version: 2,
      ownershipIntents: [inconsistent],
      transferCleanup: [],
    });
    const journal = new AgentOwnershipJournal({
      workspaceDir,
      registry,
      integrations: createIntegrations(mock(async () => {})),
    });

    await expect(journal.initialize()).resolves.toBeUndefined();

    expect((await readJournal(workspaceDir)).ownershipIntents).toMatchObject([{
      operationId: inconsistent.operationId,
    }]);
  });

  it('retires a handoff intent superseded by a newer ownership epoch', async () => {
    const registry = createRegistry({
      chat: chat('target-agent', {
        agentOwnershipEpoch: 'newer-epoch',
        carryOverHeadId: 'd5f2380b-6228-49f5-8484-b2d7e16380ab',
      }),
    });
    await writeJournal(workspaceDir, {
      version: 2,
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
      version: 2,
      ownershipIntents: [{
        version: 2,
        operationId: 'handoff:malformed',
        clientRequestId: 'request-malformed',
        submittedTargetHash: 'a'.repeat(64),
        kind: 'handoff',
        chatId: 'chat',
        phase: 'node-prepared',
        source: {},
        target: {},
        preparedNodeId: null,
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
  return {
    version: 2,
    operationId: 'handoff:request-1',
    clientRequestId: 'request-1',
    submittedTargetHash: 'a'.repeat(64),
    kind: 'handoff',
    chatId: 'chat',
    phase: 'node-prepared',
    source: {
      agentId: source.agentId,
      model: source.model,
      sessionId: source.agentSessionId,
      agentOwnershipEpoch: source.agentOwnershipEpoch,
      historyHeadId: source.carryOverHeadId,
      nativeSeedReceipt: source.nativeSeedReceipt,
      reference: referenceFor('source-agent'),
    },
    target: {
      execution: target(),
      agentOwnershipEpoch: 'target-epoch',
      historyHeadId: '7f1bb17c-0cc5-4a0d-b762-2c14b04c5f2e',
    },
    preparedNodeId: '7f1bb17c-0cc5-4a0d-b762-2c14b04c5f2e',
    createdAt: timestamp,
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
