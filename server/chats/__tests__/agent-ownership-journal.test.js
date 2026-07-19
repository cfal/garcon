import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UserMessage } from '../../../common/chat-types.js';
import { AgentOwnershipJournal } from '../agent-ownership-journal.js';
import { ChatCarryOverStore } from '../chat-carryover-store.js';

const ts = '2026-01-01T00:00:00.000Z';

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

function createRegistry(initialEntries) {
  const entries = new Map(Object.entries(initialEntries));
  const removedListeners = [];
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
      const next = { ...current, ...patch };
      entries.set(chatId, next);
      return { id: chatId, ...next };
    }),
    removeChat: mock((chatId) => {
      const removed = entries.delete(chatId);
      if (removed) removedListeners.forEach((listener) => listener(chatId));
      return removed;
    }),
    flush: mock(async () => {}),
    onChatRemoved(listener) {
      removedListeners.push(listener);
    },
  };
}

function createIntegrations(releases) {
  const byId = new Map(['source-agent', 'target-agent'].map((agentId) => [agentId, {
    descriptor: { id: agentId },
    settings: {
      defaults: () => envelope(agentId),
      parse: (input) => input,
    },
    transcript: {
      release: mock(async (request) => {
        releases.push(request);
      }),
    },
  }]));
  return {
    require(agentId) {
      const integration = byId.get(agentId);
      if (!integration) throw new Error(`missing integration ${agentId}`);
      return integration;
    },
  };
}

describe('AgentOwnershipJournal', () => {
  let workspaceDir;
  let carryOver;

  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-ownership-journal-'));
    carryOver = new ChatCarryOverStore({
      filePath: path.join(workspaceDir, 'chat-carryover.json'),
      saveDelayMs: 0,
    });
    await carryOver.init();
  });

  afterEach(async () => {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it('rolls back staging and intent when the registry commit fails before ownership changes', async () => {
    const registry = createRegistry({ chat: chat() });
    registry.setFailUpdateBeforeCommit(true);
    carryOver.bindRegistry(registry);
    const releases = [];
    const journal = new AgentOwnershipJournal({
      workspaceDir,
      registry,
      carryOver,
      integrations: createIntegrations(releases),
    });
    await journal.initialize();

    await expect(journal.transfer({
      chatId: 'chat',
      source: registry.getChat('chat'),
      targetAgentId: 'target-agent',
      patch: {
        model: 'target-model',
        agentSettingsById: {
          'source-agent': envelope('source-agent'),
          'target-agent': envelope('target-agent'),
        },
      },
      carryOverSegment: {
        agentId: 'source-agent',
        model: 'source-model',
        messages: [new UserMessage(ts, 'retained')],
      },
    })).rejects.toThrow('registry write failed');

    expect(journal.hasPending('chat')).toBe(false);
    expect(registry.getChat('chat').agentId).toBe('source-agent');
    expect(carryOver.getMessages('chat')).toEqual([]);
    expect(releases).toEqual([]);
    const persisted = JSON.parse(await fs.readFile(
      path.join(workspaceDir, 'agent-ownership-journal.json'),
      'utf8',
    ));
    expect(persisted.intents).toEqual([]);
  });

  it('recovers a committed transfer after unrelated target edits', async () => {
    const target = chat('target-agent', {
      agentSessionId: null,
      nativeSession: null,
      agentOwnershipEpoch: 'target-epoch',
      tags: ['edited-after-transfer'],
      agentSettingsById: {
        'source-agent': envelope('source-agent'),
        'target-agent': envelope('target-agent'),
      },
    });
    const registry = createRegistry({ chat: target });
    carryOver.bindRegistry(registry);
    await carryOver.stageTransfer({
      chatId: 'chat',
      targetEpoch: 'target-epoch',
      ownerId: 'target-agent',
      segment: {
        agentId: 'source-agent',
        model: 'source-model',
        messages: [new UserMessage(ts, 'retained')],
      },
    });
    await fs.writeFile(path.join(workspaceDir, 'agent-ownership-journal.json'), JSON.stringify({
      version: 1,
      intents: [{
        id: 'intent-1',
        kind: 'transfer',
        chatId: 'chat',
        oldReference: {
          chatId: 'chat',
          agentId: 'source-agent',
          agentSessionId: 'source-agent-session',
          projectPath: '/workspace/project',
          model: 'source-agent-model',
          nativeSession: {
            ownerId: 'source-agent',
            schemaVersion: 1,
            value: { id: 'source-agent-session' },
          },
          carryOverRevision: 'carry-v1:0',
          settings: envelope('source-agent'),
        },
        oldEpoch: 'source-agent-epoch',
        targetAgentId: 'target-agent',
        targetEpoch: 'target-epoch',
        createdAt: ts,
      }],
    }));
    const releases = [];

    const journal = new AgentOwnershipJournal({
      workspaceDir,
      registry,
      carryOver,
      integrations: createIntegrations(releases),
    });
    await journal.initialize();

    expect(releases).toHaveLength(1);
    expect(releases[0]).toMatchObject({
      reason: 'transferred',
      chat: { agentId: 'source-agent', agentSessionId: 'source-agent-session' },
    });
    expect(carryOver.getMessages('chat').map((message) => message.content)).toEqual(['retained']);
    expect(registry.getChat('chat').tags).toEqual(['edited-after-transfer']);
    expect(journal.hasPending('chat')).toBe(false);
  });

  it('releases integration-owned transcript data on deletion independently of search state', async () => {
    const registry = createRegistry({ chat: chat() });
    carryOver.bindRegistry(registry);
    carryOver.appendSegment('chat', {
      agentId: 'source-agent',
      model: 'source-model',
      messages: [new UserMessage(ts, 'retained')],
    });
    const releases = [];
    const integrations = createIntegrations(releases);
    const journal = new AgentOwnershipJournal({ workspaceDir, registry, carryOver, integrations });
    await journal.initialize();

    await journal.delete('chat');

    expect(registry.getChat('chat')).toBeNull();
    expect(releases).toHaveLength(1);
    expect(releases[0]).toMatchObject({ reason: 'deleted', chat: { agentId: 'source-agent' } });
    expect(carryOver.getMessages('chat')).toEqual([]);
  });
});
