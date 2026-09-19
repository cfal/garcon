import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { ChatRegistry, type ChatRegistryPatch } from '../store.js';
import { normalizeChatRegistryEntry } from '../registry-entry-codec.js';

const CHAT_ID = '1783725900000300';
const NODE_ID = '22222222-2222-4222-8222-222222222222';
const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

async function fixture(nodeId?: string | null) {
  const directory = await mkdtemp(path.join(homedir(), 'garcon-node-persistence-'));
  directories.push(directory);
  const registry = new ChatRegistry(directory);
  await registry.init();
  registry.addChat({
    id: CHAT_ID, nodeId, agentId: 'test', model: 'synthetic-model', projectPath: '/project',
    parentChat: null, preambleSelection: { revision: 0, orderedPreambleIds: [] },
  });
  await registry.flush();
  return { directory, registry, file: path.join(directory, 'chats.json') };
}

test('new local chats omit the node field; remote ownership survives save and reload', async () => {
  for (const nodeId of [undefined, null, 'local', NODE_ID]) {
    const { file, directory } = await fixture(nodeId);
    const stored = JSON.parse(await readFile(file, 'utf8'));
    expect(stored.version).toBe(5);
    expect(stored.sessions[CHAT_ID].nodeId).toBe(nodeId === NODE_ID ? NODE_ID : undefined);
    const reloaded = new ChatRegistry(directory);
    await reloaded.init();
    expect(reloaded.getChat(CHAT_ID)?.nodeId).toBe(nodeId === NODE_ID ? NODE_ID : undefined);
  }
});

test('unrelated updates preserve absent and null local fields without backfill', async () => {
  const { file, directory } = await fixture();
  for (const nodeId of [undefined, null]) {
    const stored = JSON.parse(await readFile(file, 'utf8'));
    stored.sessions[CHAT_ID].nodeId = nodeId;
    await writeFile(file, JSON.stringify(stored));
    const registry = new ChatRegistry(directory);
    await registry.init();
    registry.updateChat(CHAT_ID, { model: 'different-model' });
    await registry.flush();
    expect(JSON.parse(await readFile(file, 'utf8')).sessions[CHAT_ID].nodeId).toBe(nodeId);
  }
});

test('generic patches cannot move ownership and invalid stored IDs fail closed', async () => {
  const { registry } = await fixture(NODE_ID);
  const malformedPatch = { nodeId: 'local', model: 'different-model' } as ChatRegistryPatch;
  registry.updateChat(CHAT_ID, malformedPatch);
  await registry.flush();
  expect(registry.getChat(CHAT_ID)?.nodeId).toBe(NODE_ID);
  for (const nodeId of ['', 'unknown', 1, {}]) {
    expect(() => normalizeChatRegistryEntry({ ...registry.getChat(CHAT_ID), nodeId }, CHAT_ID)).toThrow('Invalid execution node ID');
  }
});

test('native identity is qualified by node and agent', async () => {
  const { registry } = await fixture(NODE_ID);
  registry.updateChat(CHAT_ID, { agentSessionId: 'shared-native-id' });
  const localId = '1783725900000301';
  const otherAgentId = '1783725900000302';
  for (const [id, agentId] of [[localId, 'test'], [otherAgentId, 'other']] as const) {
    registry.addChat({ id, agentId, projectPath: '/project', model: 'synthetic-model',
      agentSessionId: 'shared-native-id', parentChat: null,
      preambleSelection: { revision: 0, orderedPreambleIds: [] } });
  }
  expect(registry.lookupNativeSession('shared-native-id')).toEqual({ status: 'ambiguous' });
  expect(registry.lookupNativeSession('shared-native-id', 'test')).toEqual({ status: 'found', chatId: localId });
  expect(registry.lookupNativeSession('shared-native-id', 'test', NODE_ID)).toEqual({ status: 'found', chatId: CHAT_ID });
  expect(registry.lookupNativeSession('shared-native-id', 'other', NODE_ID)).toEqual({ status: 'not-found' });
  expect(registry.getChatByAgentSessionId('shared-native-id', 'test', NODE_ID)?.[0]).toBe(CHAT_ID);
  await registry.flush();
});

test('ownership installation persists node and destination path together and clears Local on return', async () => {
  const { registry, directory, file } = await fixture();
  registry.updateChat(CHAT_ID, { agentSessionId: 'source-native-id' });
  await registry.installAgentOwnership(CHAT_ID, {
    nodeId: NODE_ID, projectPath: '/remote/project', patch: { agentSessionId: null, model: 'target-model' },
  });
  const reloaded = new ChatRegistry(directory);
  await reloaded.init();
  expect(reloaded.getChat(CHAT_ID)).toMatchObject({ nodeId: NODE_ID, projectPath: '/remote/project', agentSessionId: null, model: 'target-model' });
  await reloaded.installAgentOwnership(CHAT_ID, { nodeId: 'local', projectPath: '/project', patch: {} });
  const local = JSON.parse(await readFile(file, 'utf8')).sessions[CHAT_ID];
  expect(local.nodeId).toBeUndefined();
  expect(local.projectPath).toBe('/project');
});
