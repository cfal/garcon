import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { splitChatRelationships } from '../chat-relationships-split.js';
import { migrateNativeChildObservers } from '../native-child-observers.js';
import { WorkspaceMigrationRunner } from '../index.js';
import { ChatRegistry } from '../../chats/store.js';
import { withFailingDirectorySync } from '../../../common/__tests__/atomic-write-failure.js';

const A = '1783725900000300';
const B = '1783725900000301';
let directory;
let file;
const historical = ['chat-id-migration', 'core-record-migration', 'ephemeral-queue-state-cleanup',
  'carryover-node-migration', 'carryover-segment-migration', 'agent-integration-settings-refresh',
  'agent-execution-mode-refresh', 'fork-ordinal-cleanup', 'provider-assignments'];

function legacy(parentChat) {
  return {
    agentId: 'test', agentOwnershipEpoch: 'synthetic-epoch', agentSettingsById: {},
    projectPath: '/synthetic', model: 'test-model', carryOverSegments: [], nativeSeedReceipt: null,
    carryOverMigrationQuarantine: null, retainedExtra: 'preserved',
    ...(parentChat === undefined ? {} : { parentChat }),
  };
}
async function write(entry) {
  await fs.writeFile(file, JSON.stringify({ version: 5, retainedExtra: true, sessions: { [A]: entry } }));
}
const read = async () => JSON.parse(await fs.readFile(file, 'utf8'));

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-relationship-migration-'));
  file = path.join(directory, 'chats.json');
});
afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }); });

describe('chat relationship split', () => {
  it.each([undefined, null, { chatId: B, relation: 'delegation' },
    { chatId: B, relation: 'fork', transcriptViewId: 'source-view', ordinal: 0 },
    { chatId: B, relation: 'handoff', transcriptViewId: 'source-view', ordinal: 42 },
  ])('preserves the exact legacy relationship and unrelated data: %j', async (parent) => {
    const original = legacy(parent);
    await write(original);
    await splitChatRelationships(directory);
    const { parentChat: _, ...rest } = original;
    expect(await read()).toEqual({ version: 6, retainedExtra: true, sessions: { [A]: {
      ...rest,
      parentChatId: parent?.relation === 'delegation' ? B : null,
      lineage: parent && parent.relation !== 'delegation' ? {
        sourceChatId: B, kind: parent.relation, transcriptViewId: parent.transcriptViewId, ordinal: parent.ordinal,
      } : null,
    } } });
    const bytes = await fs.readFile(file, 'utf8');
    await splitChatRelationships(directory);
    expect(await fs.readFile(file, 'utf8')).toBe(bytes);
    await migrateNativeChildObservers(directory);
    const registry = new ChatRegistry(directory);
    await registry.init();
    expect(registry.getChat(A).lineage).toEqual((await read()).sessions[A].lineage);
  });

  it.each([{}, 'bad', { chatId: A, relation: 'delegation' }, { chatId: B, relation: 'unknown' },
    { chatId: B, relation: 'fork', transcriptViewId: 'source-view', ordinal: -1 },
    { chatId: B, relation: 'handoff' }, { chatId: B, relation: 'delegation', ordinal: 5 },
  ])('refuses malformed heritage without changing the file: %j', async (parent) => {
    await write(legacy(parent));
    const bytes = await fs.readFile(file, 'utf8');
    await expect(splitChatRelationships(directory)).rejects.toThrow();
    expect(await fs.readFile(file, 'utf8')).toBe(bytes);
  });

  it('does not create a missing file or accept malformed already-converted data', async () => {
    await splitChatRelationships(directory);
    await expect(fs.stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
    await fs.writeFile(file, JSON.stringify({ version: 6, sessions: { [A]: legacy(null) } }));
    await expect(splitChatRelationships(directory)).rejects.toThrow();
  });

  it.each([
    legacy({ relation: 'delegation', chatId: 'invalid' }),
    { ...legacy(null), executorId: 'invalid' },
  ])('identifies the entry when relationship or registry validation fails', async (entry) => {
    await write(entry);
    await expect(splitChatRelationships(directory)).rejects.toThrow(`entry ${A}`);
    expect((await read()).version).toBe(5);
  });

  it('retries definite and uncertain atomic writes without losing lineage', async () => {
    await write(legacy({ chatId: B, relation: 'fork', transcriptViewId: 'source-view', ordinal: 2 }));
    const rename = spyOn(fs, 'rename').mockRejectedValueOnce(new Error('disk unavailable'));
    try { await expect(splitChatRelationships(directory)).rejects.toThrow('disk unavailable'); }
    finally { rename.mockRestore(); }
    expect((await read()).version).toBe(5);
    await withFailingDirectorySync(directory, async () => {
      await expect(splitChatRelationships(directory)).rejects.toThrow();
    });
    expect((await read()).version).toBe(6);
    await splitChatRelationships(directory);
    expect((await read()).sessions[A].lineage.ordinal).toBe(2);
  });

  it.each([null, 4, 7, 9])('restarts after conversion without replaying historical writers (version %s)', async (version) => {
    if (version !== null) {
      await fs.writeFile(path.join(directory, 'workspace-version.json'), JSON.stringify({ version }));
      await write(legacy({ chatId: B, relation: 'delegation' }));
    }
    const runner = await WorkspaceMigrationRunner.open(directory);
    for (const name of historical) await runner.run(name, async () => {});
    await runner.checkpointThrough('provider-assignments');
    expect(runner.initialVersion).toBe(version ?? 0);
    expect(JSON.parse(await fs.readFile(path.join(directory, 'workspace-version.json'), 'utf8')))
      .toEqual(version === 9 ? { version: 9 } : { version: 9, checkpoint: true });
    await runner.run('chat-relationships-split', () => splitChatRelationships(directory));
    await runner.checkpointThrough('chat-relationships-split');
    await runner.run('native-child-observers', () => migrateNativeChildObservers(directory));
    const registry = new ChatRegistry(directory);
    await registry.init();
    await registry.flush();

    const restarted = await WorkspaceMigrationRunner.open(directory);
    expect(restarted.resumedFromCheckpoint).toBe(true);
    for (const name of historical) await restarted.run(name, async () => { throw new Error(`Replayed ${name}`); });
    await restarted.checkpointThrough('provider-assignments');
    await restarted.run('chat-relationships-split', () => splitChatRelationships(directory));
    await restarted.run('native-child-observers', () => migrateNativeChildObservers(directory));
    await restarted.finish();
    expect(JSON.parse(await fs.readFile(path.join(directory, 'workspace-version.json'), 'utf8'))).toEqual({ version: 11 });
    expect((await WorkspaceMigrationRunner.open(directory)).resumedFromCheckpoint).toBe(false);
  });
});
