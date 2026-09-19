import { afterEach, expect, spyOn, test } from 'bun:test';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { ExecutionNodeManager } from '../manager.js';
import { executionNodeConfigGuards } from '../config-guards.js';
import { ChatRegistry } from '../../chats/store.js';
import { AgentOwnershipJournal } from '../../chats/agent-ownership-journal.js';
import { SettingsStore } from '../../settings/store.js';
import { PreambleStore } from '../../preambles/store.js';
import { ScheduledPromptStore } from '../../scheduled-prompts/store.js';
import { ExecutionNodeReferenceWrites } from '../reference-writes.js';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const chatId = '1767225600000000';
const timestamp = '2026-01-01T00:00:00.000Z';
const kinds = ['settings', 'preamble', 'schedule', 'handoff'] as const;
type Kind = typeof kinds[number];
const filenames: Record<Kind, string> = {
  settings: 'project-settings.json', preamble: 'preambles.json',
  schedule: 'scheduled-prompts.json', handoff: 'agent-ownership-journal.json',
};

async function fixture() {
  const root = await fs.mkdtemp(join(tmpdir(), 'node-reference-publication-'));
  cleanup.push(() => fs.rm(root, { recursive: true, force: true }));
  const manager = await ExecutionNodeManager.create({
    id: 'local', workspaceDir: root, projectBasePath: root, integrations: [], resolveCredential: async () => null,
  });
  cleanup.push(() => manager.dispose());
  const node = await manager.create({ label: 'Synthetic worker', direction: 'node-connects' });
  const retainNodeReferences = manager.retainReferences;
  const chats = new ChatRegistry(root, { retainNodeReferences, saveDelayMs: 60_000 });
  const settings = new SettingsStore(root, { retainNodeReferences });
  const preambles = new PreambleStore(root, retainNodeReferences);
  const schedules = new ScheduledPromptStore(root, retainNodeReferences);
  await chats.init();
  await settings.init();
  await preambles.init();
  await schedules.init();
  cleanup.push(() => chats.flush());
  chats.addChat({ id: chatId, agentId: 'test', model: 'synthetic-model', projectPath: root, parentChat: null });
  await chats.flush();
  const ownership = new AgentOwnershipJournal({
    workspaceDir: root, registry: chats, retainNodeReferences,
    integrations: { get: () => null, require: () => { throw new Error('No provider needed'); } },
    ledger: { deleteChat: () => {} },
  });
  await ownership.initialize();
  manager.setGuards(executionNodeConfigGuards({
    chats, settings, schedules, preambles, ownership, execution: { ownsExecution: () => false },
  }));
  const publish = (kind: Kind, nodeId = node.id): Promise<unknown> => {
    switch (kind) {
      case 'settings': return settings.setUiSettings({ promptRefinement: {
        nodeId, agentId: 'test', model: 'synthetic-model',
      } });
      case 'preamble': return preambles.create({
        id: '22222222-2222-4222-8222-222222222222', title: 'Synthetic preamble', content: 'Synthetic content',
        enabled: true, agentIds: [], tagFilter: { mode: 'any', tags: [] },
        scope: { type: 'project-paths', rules: [{ nodeId, projectPath: '/workspace/project', includeNested: false }] },
        createdAt: timestamp, updatedAt: timestamp,
      }, preambles.snapshot().revision);
      case 'schedule': return schedules.create({
        id: '33333333-3333-4333-8333-333333333333', prompt: 'Synthetic prompt',
        schedule: { type: 'once', nextRunAt: '2099-01-01T00:00:00.000Z' },
        target: {
          type: 'new-chat', nodeId, agentId: 'test', model: 'synthetic-model', projectPath: root,
          apiProviderId: null, modelEndpointId: null, modelProtocol: null,
          permissionMode: 'default', thinkingMode: 'none', agentSettingsById: {}, tags: [],
          preambleChoice: { mode: 'defaults' },
        }, createdAt: timestamp, updatedAt: timestamp,
      }, schedules.revision);
      case 'handoff': return ownership.decideHandoff({
        operationId: 'synthetic-operation', clientRequestId: 'synthetic-request', submittedTargetHash: 'a'.repeat(64),
        chatId, source: chats.getChat(chatId)!, targetAgentOwnershipEpoch: 'synthetic-destination',
        watermark: { viewId: 'synthetic-view', ordinal: 0 },
        target: {
          nodeId, agentId: 'test', model: 'synthetic-model', projectPath: root,
          apiProviderId: null, modelEndpointId: null, modelProtocol: null,
          permissionMode: 'default', thinkingMode: 'none',
          agentSettings: { ownerId: 'test', schemaVersion: 1, values: {} },
        },
      });
    }
  };
  return { root, manager, node, chats, settings, preambles, schedules, ownership, publish };
}

function gateRename(filename: string, failure?: Error) {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const rename = fs.rename;
  const spy = spyOn(fs, 'rename').mockImplementation(async (source, target) => {
    if (basename(String(target)) === filename) {
      entered.resolve();
      await release.promise;
      if (failure) throw failure;
    }
    await rename(source, target);
  });
  cleanup.push(async () => { release.resolve(); spy.mockRestore(); });
  return { entered: entered.promise, release: () => release.resolve(), restore: () => spy.mockRestore() };
}

test.each(kinds)('Delete rejects a %s reference before disk publication and after commit', async (kind) => {
  const { manager, node, publish } = await fixture();
  const gate = gateRename(filenames[kind]);
  const writing = publish(kind);
  await gate.entered;
  await expect(manager.remove(node.id)).rejects.toMatchObject({ code: 'EXECUTION_NODE_IN_USE', status: 409 });
  gate.release();
  await writing;
  await expect(manager.remove(node.id)).rejects.toMatchObject({ code: 'EXECUTION_NODE_IN_USE', status: 409 });
});

test.each(kinds)('a rejected %s save releases its reference reservation', async (kind) => {
  const { manager, node, publish } = await fixture();
  const gate = gateRename(filenames[kind], new DOMException('Synthetic cancellation', 'AbortError'));
  const writing = publish(kind).catch((error: unknown) => error);
  await gate.entered;
  await expect(manager.remove(node.id)).rejects.toMatchObject({ status: 409 });
  gate.release();
  expect(await writing).toBeInstanceOf(Error);
  await manager.remove(node.id);
  expect(manager.list().map((entry) => entry.id)).toEqual(['local']);
});

test.each(kinds)('a %s publication cannot start once Delete owns the node', async (kind) => {
  const { manager, node, publish } = await fixture();
  const gate = gateRename('execution-nodes.json');
  const deleting = manager.remove(node.id);
  await gate.entered;
  await expect(publish(kind)).rejects.toMatchObject({ code: 'EXECUTION_NODE_IN_USE', status: 409 });
  gate.release();
  await deleting;
  await expect(publish(kind)).rejects.toMatchObject({ code: 'EXECUTION_NODE_NOT_FOUND', status: 404 });
});

test.each(kinds)('a renamed but unconfirmed %s reference still prevents deletion', async (kind) => {
  const { root, manager, node, publish } = await fixture();
  const open = fs.open;
  const spy = spyOn(fs, 'open').mockImplementation(async (path, flags, mode) => {
    if (path === root && flags === 'r') throw new Error('Synthetic directory sync failure');
    return open(path, flags, mode);
  });
  try {
    await expect(publish(kind)).rejects.toBeInstanceOf(Error);
  } finally {
    spy.mockRestore();
  }
  await expect(manager.remove(node.id)).rejects.toMatchObject({ code: 'EXECUTION_NODE_IN_USE', status: 409 });
});

test('chat creation rechecks configuration at synchronous registry publication', async () => {
  const { manager, node, chats, root } = await fixture();
  const gate = gateRename('execution-nodes.json');
  const deleting = manager.remove(node.id);
  await gate.entered;
  const entry = { id: '1767225600000001', nodeId: node.id, agentId: 'test', model: 'synthetic-model', projectPath: root, parentChat: null };
  expect(() => chats.addChat(entry)).toThrow('This execution node is being changed');
  expect(chats.getChat(entry.id)).toBeNull();
  chats.addChat({ ...entry, nodeId: undefined });
  gate.release();
  await deleting;
  expect(chats.getChat(entry.id)?.nodeId).toBeUndefined();
});

async function addRemoteChat(chats: ChatRegistry, root: string, nodeId: string, withSettings = false) {
  const id = '1767225600000001';
  chats.addChat({
    id, nodeId, agentId: 'test', model: 'synthetic-model', projectPath: root, parentChat: null,
    agentSettingsById: withSettings ? { test: { ownerId: 'test', schemaVersion: 1, values: {} } } : {},
  });
  await chats.flush();
  return id;
}

test.each(['confirmed', 'failed', 'uncertain'] as const)(
  'compensating chat removal retains its node until a confirmed removing write (%s)', async (outcome) => {
    const { manager, node, chats, root } = await fixture();
    const id = await addRemoteChat(chats, root, node.id);
    const gate = gateRename('chats.json', outcome === 'failed' ? new Error('Synthetic write failure') : undefined);
    chats.removeChat(id, 'start-compensation');
    await expect(manager.remove(node.id)).rejects.toMatchObject({ code: 'EXECUTION_NODE_IN_USE' });
    expect(JSON.parse(await fs.readFile(join(root, 'chats.json'), 'utf8')).sessions[id].nodeId).toBe(node.id);
    const open = fs.open;
    const syncFailure = spyOn(fs, 'open').mockImplementation(async (path, flags, mode) => {
      if (outcome === 'uncertain' && path === root && flags === 'r') throw new Error('Synthetic sync failure');
      return open(path, flags, mode);
    });
    try {
      const writing = chats.flush().catch((error: unknown) => error);
      await gate.entered;
      await expect(manager.remove(node.id)).rejects.toMatchObject({ code: 'EXECUTION_NODE_IN_USE' });
      gate.release();
      expect(await writing).toEqual(outcome === 'confirmed' ? undefined : expect.any(Error));
    } finally {
      syncFailure.mockRestore();
      gate.restore();
    }
    if (outcome !== 'confirmed') {
      await expect(manager.remove(node.id)).rejects.toMatchObject({ code: 'EXECUTION_NODE_IN_USE' });
      await chats.flush();
    }
    await manager.remove(node.id);
    expect(JSON.parse(await fs.readFile(join(root, 'chats.json'), 'utf8')).sessions[id]).toBeUndefined();
  },
);

test('a write captured before chat removal cannot release the removed node', async () => {
  const { manager, node, chats, root } = await fixture();
  const id = await addRemoteChat(chats, root, node.id);
  const gate = gateRename('chats.json');
  const writing = chats.flush();
  await gate.entered;
  chats.removeChat(id, 'start-compensation');
  gate.release();
  await writing;
  await expect(manager.remove(node.id)).rejects.toMatchObject({ code: 'EXECUTION_NODE_IN_USE' });
  await chats.flush();
  await manager.remove(node.id);
});

test.each([false, true])('deletion inherits an unknown persisted chat node (provider reference: %s)', async (withSettings) => {
  const { manager, root } = await fixture();
  const nodeId = '44444444-4444-4444-8444-444444444444';
  const persisted = new ChatRegistry(root);
  await persisted.init();
  const id = await addRemoteChat(persisted, root, nodeId, withSettings);
  const chats = new ChatRegistry(root, { retainNodeReferences: manager.retainReferences, saveDelayMs: 60_000 });
  await chats.init();
  const ownership = new AgentOwnershipJournal({
    workspaceDir: root, registry: chats, retainNodeReferences: manager.retainReferences,
    integrations: { get: () => null, require: () => { throw new Error('No provider needed'); } },
    ledger: { deleteChat: () => {} },
  });
  await ownership.initialize();
  await ownership.delete(id);
  await ownership.waitForProviderCleanup();
  expect(chats.getChat(id)).toBeNull();
  expect(JSON.parse(await fs.readFile(join(root, 'chats.json'), 'utf8')).sessions[id]).toBeUndefined();
});

test('deletion without a provider reference retains the source during registry removal', async () => {
  const { manager, node, chats, root, ownership } = await fixture();
  const id = await addRemoteChat(chats, root, node.id);
  const gate = gateRename('chats.json');
  const deleting = ownership.delete(id);
  await gate.entered;
  expect(chats.getChat(id)).toBeNull();
  expect(ownership.referencesNode(node.id)).toBe(false);
  await expect(manager.remove(node.id)).rejects.toMatchObject({ code: 'EXECUTION_NODE_IN_USE' });
  gate.release();
  await deleting;
  await ownership.waitForProviderCleanup();
  await manager.remove(node.id);
});

test('handoff inherits the persisted source node but validates the new target', async () => {
  const { root, manager, node } = await fixture();
  const unknown = '44444444-4444-4444-8444-444444444444';
  const persisted = new ChatRegistry(root);
  await persisted.init();
  const id = await addRemoteChat(persisted, root, unknown);
  const chats = new ChatRegistry(root, { retainNodeReferences: manager.retainReferences });
  await chats.init();
  const ownership = new AgentOwnershipJournal({
    workspaceDir: root, registry: chats, retainNodeReferences: manager.retainReferences,
    integrations: { get: () => null, require: () => { throw new Error('No provider needed'); } },
    ledger: { deleteChat: () => {} },
  });
  await ownership.initialize();
  const request = {
    operationId: 'synthetic-handoff', clientRequestId: 'synthetic-request', submittedTargetHash: 'b'.repeat(64),
    chatId: id, source: chats.getChat(id)!, targetAgentOwnershipEpoch: 'synthetic-destination',
    watermark: { viewId: 'synthetic-view', ordinal: 0 },
    target: {
      nodeId: '55555555-5555-4555-8555-555555555555', agentId: 'test', model: 'synthetic-model', projectPath: root,
      apiProviderId: null, modelEndpointId: null, modelProtocol: null,
      permissionMode: 'default' as const, thinkingMode: 'none' as const,
      agentSettings: { ownerId: 'test', schemaVersion: 1, values: {} },
    },
  };
  await expect(ownership.decideHandoff(request)).rejects.toMatchObject({ code: 'EXECUTION_NODE_NOT_FOUND' });
  await ownership.decideHandoff({ ...request, target: { ...request.target, nodeId: node.id } });
  expect(ownership.referencesNode(unknown)).toBe(true);
  expect(ownership.referencesNode(node.id)).toBe(true);
});

test('reference reservations are node-scoped, counted, and acquired all-or-nothing', () => {
  const guard = new ExecutionNodeReferenceWrites((id) => { if (id === 'missing') throw new Error('Missing node'); });
  const releaseFirst = guard.retain(['first', 'first', 'local']);
  const releaseSecond = guard.retain(['first']);
  expect(() => guard.retain(['second', 'missing'])).toThrow('Missing node');
  guard.assertNoWrites('second');
  guard.assertNoWrites('local');
  releaseFirst();
  releaseFirst();
  expect(() => guard.assertNoWrites('first')).toThrow('A reference to this node is being saved');
  releaseSecond();
  guard.assertNoWrites('first');
  const releaseExisting = guard.retain([], ['missing']);
  expect(() => guard.assertNoWrites('missing')).toThrow();
  releaseExisting();
  guard.assertNoWrites('missing');
});
