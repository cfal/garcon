import { afterEach, expect, it, spyOn } from 'bun:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { migrateNativeChildObservers } from '../native-child-observers.js';
import { ChatRegistry } from '../../chats/store.js';
import { withFailingDirectorySync } from '../../../common/__tests__/atomic-write-failure.js';

const ID = '1783725900000401';
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-observer-migration-'));
  directories.push(directory);
  const file = path.join(directory, 'chats.json');
  const entry = {
    agentId: 'claude', agentOwnershipEpoch: 'synthetic-epoch', agentSettingsById: {},
    projectPath: '/synthetic', model: 'synthetic-model', carryOverSegments: [], nativeSeedReceipt: null,
    carryOverMigrationQuarantine: null, parentChatId: null, lineage: null, extra: 'preserved',
  };
  await fs.writeFile(file, JSON.stringify({ version: 6, sessions: { [ID]: entry } }));
  return { directory, file, entry };
}

it('adds only the null marker, validates entries, and is idempotent', async () => {
  const { directory, file, entry } = await fixture();
  await migrateNativeChildObservers(directory);
  const bytes = await fs.readFile(file, 'utf8');
  expect(JSON.parse(bytes)).toEqual({ version: 7, sessions: { [ID]: { ...entry, nativeObservation: null } } });
  await migrateNativeChildObservers(directory);
  expect(await fs.readFile(file, 'utf8')).toBe(bytes);
  const registry = new ChatRegistry(directory);
  await registry.init();
  expect(registry.getChat(ID)!.nativeObservation).toBeNull();
});

it('retries pre-rename failure and validates a post-rename uncertain save', async () => {
  const { directory, file } = await fixture();
  const rename = spyOn(fs, 'rename').mockRejectedValueOnce(new Error('synthetic disk failure'));
  try { await expect(migrateNativeChildObservers(directory)).rejects.toThrow('synthetic disk failure'); }
  finally { rename.mockRestore(); }
  expect(JSON.parse(await fs.readFile(file, 'utf8')).version).toBe(6);
  await withFailingDirectorySync(directory, async () => {
    await expect(migrateNativeChildObservers(directory)).rejects.toThrow();
  });
  expect(JSON.parse(await fs.readFile(file, 'utf8')).version).toBe(7);
  await migrateNativeChildObservers(directory);
});

it('does not interpret a missing schema-7 marker as executable', async () => {
  const { directory, file, entry } = await fixture();
  await fs.writeFile(file, JSON.stringify({ version: 7, sessions: { [ID]: entry } }));
  await expect(migrateNativeChildObservers(directory)).rejects.toThrow('Missing nativeObservation');
});
