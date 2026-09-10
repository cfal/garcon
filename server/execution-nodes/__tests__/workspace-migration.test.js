import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { writeJsonFileAtomic } from '../../lib/json-file-store.js';
import { ChatRegistry } from '../../chats/store.js';
import { ExecutionNodesStore } from '../store.js';
import { migrateWorkspaceExecutionLocations } from '../workspace-migration.js';

const chatId = '1780000000000001';
const projectPath = '/synthetic/missing-project';
const envelope = (ownerId) => ({ ownerId, schemaVersion: 1, values: {} });
const directories = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

function legacyChat() {
  return {
    agentId: 'source', projectPath, model: 'synthetic-model', agentOwnershipEpoch: 'source-epoch',
    agentSettingsById: { source: envelope('source') }, agentSessionId: 'native-session',
    nativeSession: { ownerId: 'source', schemaVersion: 1, value: { path: '/synthetic/native-history' } },
    nativeSeedReceipt: null, carryOverSegments: [], carryOverMigrationQuarantine: null,
    preambleSelection: { revision: 2, orderedPreambleIds: [] }, parentChat: null,
  };
}

function legacyHandoff() {
  return {
    version: 5, kind: 'handoff', operationId: 'handoff-operation', clientRequestId: 'request',
    submittedTargetHash: 'a'.repeat(64), chatId, phase: 'commit-decided',
    source: { agentId: 'source', agentOwnershipEpoch: 'source-epoch' },
    target: {
      execution: {
        agentId: 'target', model: 'synthetic-model', apiProviderId: null, modelEndpointId: null,
        modelProtocol: null, permissionMode: 'default', thinkingMode: 'none', agentSettings: envelope('target'),
      },
      agentOwnershipEpoch: 'target-epoch',
    },
    watermark: { viewId: 'synthetic-view', ordinal: 7 }, createdAt: '2026-01-01T00:00:00.000Z',
  };
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'garcon-placed-workspace-'));
  directories.push(directory);
  const nodes = new ExecutionNodesStore(directory);
  await nodes.init();
  const read = async (name) => JSON.parse(await readFile(join(directory, name), 'utf8'));
  const write = (name, value) => writeJsonFileAtomic(join(directory, name), value, { mode: 0o600 });
  return { directory, nodes, read, write };
}

describe('workspace execution location migration', () => {
  test.each(['source', 'target'])('names the chat when a legacy handoff %s has an invalid provider', async (side) => {
    const f = await fixture();
    const decision = legacyHandoff();
    if (side === 'source') decision.source.agentId = 'invalid/provider';
    else {
      decision.target.execution.agentId = 'invalid/provider';
      decision.target.execution.agentSettings = envelope('invalid/provider');
    }
    await f.write('chats.json', { version: 5, sessions: { [chatId]: legacyChat() } });
    await f.write('agent-ownership-journal.json', { version: 5, ownershipIntents: [decision] });
    await expect(migrateWorkspaceExecutionLocations(f.directory, f.nodes))
      .rejects.toThrow(`Invalid local execution target for chat ${chatId}`);
    expect(await f.read('agent-ownership-journal.json')).toEqual({ version: 5, ownershipIntents: [decision] });
  });

  test('retains native bindings and a pending handoff without inspecting missing directories', async () => {
    const f = await fixture();
    const source = legacyChat();
    const decision = legacyHandoff();
    await f.write('chats.json', { version: 5, sessions: { [chatId]: source } });
    await f.write('agent-ownership-journal.json', { version: 5, ownershipIntents: [decision] });
    await migrateWorkspaceExecutionLocations(f.directory, f.nodes);
    const registry = new ChatRegistry(f.directory);
    await registry.init();
    expect(registry.getChat(chatId)).toMatchObject(source);
    const location = registry.getChat(chatId).executionLocation;
    const migrated = (await f.read('agent-ownership-journal.json')).ownershipIntents[0];
    expect(migrated).toMatchObject({
      ...decision, version: 6,
      source: { ...decision.source, executionLocation: location },
      target: { execution: { projectPath, executionLocation: { nodeId: location.nodeId, workspaceId: location.workspaceId } } },
    });
    expect(migrated.target.execution.executionLocation.instanceId).not.toBe(location.instanceId);
    expect(f.nodes.snapshot().instances.map((entry) => entry.storageNamespace)).toEqual(['source', 'target']);
    await registry.flush();
  });

  test.each(['chats.json', 'agent-ownership-journal.json'])('restarts after failure writing %s without reallocating identities', async (failedFile) => {
    const f = await fixture();
    await f.write('chats.json', { version: 5, sessions: { [chatId]: legacyChat() } });
    await f.write('agent-ownership-journal.json', { version: 5, ownershipIntents: [legacyHandoff()] });
    await expect(migrateWorkspaceExecutionLocations(f.directory, f.nodes, async (file, value, options) => {
      if (basename(file) === failedFile) throw new Error('injected crash');
      await writeJsonFileAtomic(file, value, options);
    })).rejects.toThrow('injected crash');
    const identities = f.nodes.snapshot();
    const restarted = new ExecutionNodesStore(f.directory);
    await restarted.init();
    await migrateWorkspaceExecutionLocations(f.directory, restarted);
    expect(restarted.snapshot()).toEqual(identities);
    const registry = await f.read('chats.json');
    const journal = await f.read('agent-ownership-journal.json');
    expect(registry.version).toBe(6);
    expect(journal.version).toBe(6);
    expect(journal.ownershipIntents[0].source.executionLocation).toEqual(registry.sessions[chatId].executionLocation);
    await migrateWorkspaceExecutionLocations(f.directory, restarted);
    expect(await f.read('chats.json')).toEqual(registry);
    expect(await f.read('agent-ownership-journal.json')).toEqual(journal);
  });

  test('qualifies deleted native references even when the chat is already absent', async () => {
    const f = await fixture();
    const reference = {
      chatId, agentId: 'source', agentSessionId: 'native-session', projectPath,
      model: 'synthetic-model', nativeSession: legacyChat().nativeSession,
      carryOverRevision: 'carry-v1:0', settings: envelope('source'),
    };
    await f.write('chats.json', { version: 5, sessions: {} });
    await f.write('agent-ownership-journal.json', { version: 5, ownershipIntents: [{
      version: 2, kind: 'delete', operationId: 'delete-operation', chatId, phase: 'registry-removed',
      sourceEpoch: 'source-epoch', releaseReferences: [reference], createdAt: '2026-01-01T00:00:00.000Z',
    }] });
    await migrateWorkspaceExecutionLocations(f.directory, f.nodes);
    const intent = (await f.read('agent-ownership-journal.json')).ownershipIntents[0];
    expect(intent.version).toBe(3);
    expect(intent.releaseReferences[0].chat).toEqual(reference);
    expect(f.nodes.requireKnownLocation(intent.releaseReferences[0].executionLocation, 'source').workspace.projectPath).toBe(projectPath);
  });

  test.each(['chats.json', 'agent-ownership-journal.json'])('rejects explicit null in %s instead of treating it as a missing file', async (file) => {
    const f = await fixture();
    await f.write(file, null);
    await expect(migrateWorkspaceExecutionLocations(f.directory, f.nodes)).rejects.toThrow();
    expect(await f.read(file)).toBeNull();
  });

  test('preserves known removed locations but refuses unknown or mismatched workspace bindings', async () => {
    const f = await fixture();
    await f.write('chats.json', { version: 5, sessions: { [chatId]: legacyChat() } });
    await migrateWorkspaceExecutionLocations(f.directory, f.nodes);
    const registry = await f.read('chats.json');
    const removed = { ...f.nodes.snapshot(), workspaces: f.nodes.snapshot().workspaces.map((entry) => ({
      ...entry, removedAt: '2026-01-01T00:00:00.000Z',
    })) };
    await f.write('execution-nodes.json', removed);
    const restarted = new ExecutionNodesStore(f.directory);
    await restarted.init();
    await migrateWorkspaceExecutionLocations(f.directory, restarted);
    expect(await f.read('chats.json')).toEqual(registry);
    for (const patch of [
      { projectPath: '/different-project' },
      { executionLocation: { ...registry.sessions[chatId].executionLocation, workspaceId: 'unknown' } },
      { executionLocation: null },
    ]) {
      const invalid = { ...registry, sessions: { [chatId]: { ...registry.sessions[chatId], ...patch } } };
      await f.write('chats.json', invalid);
      await expect(migrateWorkspaceExecutionLocations(f.directory, restarted)).rejects.toThrow();
      expect(await f.read('chats.json')).toEqual(invalid);
    }
  });
});
