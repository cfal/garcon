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
    transcript: { release },
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
      agentSessionId: null,
      nativeSession: null,
      nativeSeedReceipt: null,
      carryOverSegments: [],
    });
    expect(release).not.toHaveBeenCalled();
    expect(await readJournal(workspaceDir)).toEqual(emptyOwnershipJournalV5());
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
    await new Promise((resolve) => setTimeout(resolve, 0));

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
