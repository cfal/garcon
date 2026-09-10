import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { writeJsonFileAtomic } from '../../lib/json-file-store.js';
import { migrateLocalChatLocations } from '../location-migration.js';
import { ExecutionNodesStore } from '../store.js';
import { normalizeChatRegistryEntry } from '../../chats/registry-entry-codec.js';

const directories = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

function oldEntry(agentId = 'synthetic-provider', projectPath = '/synthetic/missing/project') {
  return {
    agentId, projectPath, model: 'synthetic-model', agentOwnershipEpoch: 'synthetic-owner',
    agentSettingsById: {}, agentSessionId: 'synthetic-native-session',
    nativeSession: { ownerId: agentId, schemaVersion: 1, value: { sessionId: 'synthetic-native-session' } },
    nativeSeedReceipt: null, carryOverSegments: [], carryOverMigrationQuarantine: null,
    preambleSelection: { revision: 2, orderedPreambleIds: [] }, parentChat: null,
  };
}

async function fixture() {
  const directory = await mkdtemp(join(homedir(), 'garcon-location-migration-'));
  directories.push(directory);
  const store = new ExecutionNodesStore(directory);
  await store.init();
  return { directory, store };
}

describe('legacy-local placement migration', () => {
  test.each(['agentId', 'projectPath'])('names the chat with missing %s before allocating identities', async (field) => {
    const { store } = await fixture();
    const original = store.snapshot();
    const entry = oldEntry();
    entry.nativeSession = null;
    delete entry[field];
    await expect(migrateLocalChatLocations({ version: 5, sessions: {
      '1780000000000001': entry,
    } }, store)).rejects.toThrow('Invalid local execution target for chat 1780000000000001');
    expect(store.snapshot()).toEqual(original);
  });

  test('names the chat with malformed persisted placement', () => {
    expect(() => normalizeChatRegistryEntry({ ...oldEntry(), executionLocation: null }, '1780000000000001'))
      .toThrow('Invalid execution location for chat 1780000000000001');
  });

  test('crash before registry replacement reuses durable identities without requiring project directories', async () => {
    const { directory, store } = await fixture();
    const raw = { version: 5, sessions: {
      '1780000000000001': oldEntry(),
      '1780000000000002': oldEntry('second-provider'),
      '1780000000000003': oldEntry('synthetic-provider', '/synthetic/another-missing'),
    } };
    const original = structuredClone(raw);
    const first = await migrateLocalChatLocations(raw, store);
    expect(raw).toEqual(original);
    const restarted = new ExecutionNodesStore(directory);
    await restarted.init();
    const retried = await migrateLocalChatLocations(raw, restarted);
    expect(retried).toEqual(first);
    expect(retried.version).toBe(6);
    expect(retried.sessions['1780000000000001']).toMatchObject(raw.sessions['1780000000000001']);
    const locations = Object.values(retried.sessions).map((entry) => entry.executionLocation);
    expect(locations[0].nodeId).toBe(locations[1].nodeId);
    expect(locations[0].workspaceId).toBe(locations[1].workspaceId);
    expect(locations[0].instanceId).toBe(locations[2].instanceId);
    expect(locations[0].instanceId).not.toBe(locations[1].instanceId);
    const persisted = JSON.parse(await readFile(join(directory, 'execution-nodes.json'), 'utf8'));
    expect(persisted.instances).toHaveLength(2);
    expect(persisted.workspaces).toHaveLength(2);
    await writeJsonFileAtomic(join(directory, 'chats.json'), retried, { mode: 0o600 });
    expect(JSON.parse(await readFile(join(directory, 'chats.json'), 'utf8'))).toEqual(retried);
  });

  test('never treats a malformed or unknown remote reference as legacy local', async () => {
    const { store } = await fixture();
    const original = store.snapshot();
    for (const executionLocation of [null, {}, { nodeId: 'remote', instanceId: 'missing', workspaceId: 'missing' }]) {
      await expect(migrateLocalChatLocations({ version: 5, sessions: {
        '1780000000000001': { ...oldEntry(), executionLocation },
      } }, store)).rejects.toThrow('execution location');
      expect(store.snapshot()).toEqual(original);
    }
  });

  test('preserves an explicit known binding and refuses already-upgraded or future registries', async () => {
    const { store } = await fixture();
    const entry = oldEntry();
    const [executionLocation] = await store.prepareLocalTargets([entry]);
    const raw = { version: 5, sessions: { '1780000000000001': { ...entry, executionLocation } } };
    const upgraded = await migrateLocalChatLocations(raw, store);
    expect(upgraded.sessions['1780000000000001'].executionLocation).toEqual(executionLocation);
    await expect(migrateLocalChatLocations(upgraded, store)).rejects.toThrow('version-5');
    await expect(migrateLocalChatLocations({ ...raw, version: 100 }, store)).rejects.toThrow('version-5');
  });
});
