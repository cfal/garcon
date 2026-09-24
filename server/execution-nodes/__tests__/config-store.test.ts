import { afterEach, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ExecutionNodeConfigStore } from '../config-store.js';
import { createNodeSecret, nodeConnectionUrl } from '../connection-url.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const temporary = join(homedir(), 'tmp');
  await mkdir(temporary, { recursive: true });
  const root = await mkdtemp(join(temporary, 'node-config-'));
  roots.push(root);
  const store = new ExecutionNodeConfigStore(root);
  await store.initialize();
  return { root, store };
}

test('CLI access defaults off, persists separately, and older stored nodes remain denied', async () => {
  const { root, store } = await fixture();
  const node = await store.create({ direction: 'node-connects', label: 'Worker' });
  expect(node.allowControllerCli).toBe(false);
  await store.update(node.id, { allowControllerCli: true });
  const restarted = new ExecutionNodeConfigStore(root);
  await restarted.initialize();
  expect(restarted.require(node.id).allowControllerCli).toBe(true);
  const file = join(root, 'execution-nodes.json');
  const stored = JSON.parse(await readFile(file, 'utf8'));
  delete stored.nodes[0].allowControllerCli;
  await writeFile(file, JSON.stringify(stored));
  await restarted.initialize();
  expect(restarted.require(node.id).allowControllerCli).toBe(false);
});

test('node configuration is private, durable, and never persists a Local node', async () => {
  const { root, store } = await fixture();
  expect(store.list()).toEqual([]);
  const node = await store.create({ direction: 'node-connects', label: 'Build machine' });
  expect(store.connection(node.id).connectionUrl).toBe(`wss://example.com/execution-node/${node.id}#secret=${node.secret}`);
  const filePath = join(root, 'execution-nodes.json');
  if (process.platform !== 'win32') expect((await stat(filePath)).mode & 0o777).toBe(0o600);
  expect(JSON.parse(await readFile(filePath, 'utf8')).nodes).toEqual([node]);
  const reloaded = new ExecutionNodeConfigStore(root);
  await reloaded.initialize();
  expect(reloaded.list()).toEqual([node]);
  await expect(store.remove('local')).rejects.toMatchObject({ code: 'EXECUTION_NODE_NOT_FOUND' });
});

test('URL updates preserve identity and configuration objects are not mutable capabilities', async () => {
  const { store } = await fixture();
  const original = await store.create({ direction: 'node-connects', label: 'Original' });
  const connectionUrl = `ws://127.0.0.1:8080/execution-node/${original.id}#secret=${original.secret}`;
  await store.update(original.id, { connection: { direction: 'node-connects', connectionUrl, allowInsecureDevelopment: true } });
  const updated = await store.update(original.id, { label: 'Renamed', enabled: false });
  expect(updated.id).toBe(original.id);
  expect(updated.secret).toBe(original.secret);
  expect(store.connection(original.id).connectionUrl).toBe(connectionUrl);
  const copy = store.list() as { label: string }[];
  copy[0].label = 'Corrupted';
  expect(store.require(original.id).label).toBe('Renamed');
  await store.remove(original.id);
  expect(store.list()).toEqual([]);
});

test('pasted worker credentials are unique and concurrent creates do not overwrite each other', async () => {
  const { store } = await fixture();
  const connectionUrl = nodeConnectionUrl('wss://worker.example.com/execution-node', createNodeSecret());
  const [first, second] = await Promise.all([
    store.create({ direction: 'controller-connects', label: 'Remote', connectionUrl }),
    store.create({ direction: 'node-connects', label: 'Inbound' }),
  ]);
  expect(store.list()).toHaveLength(2);
  expect(first.secret).not.toBe(second.secret);
  await expect(store.create({ direction: 'controller-connects', label: 'Duplicate', connectionUrl })).rejects.toThrow('unique');
  expect(store.list()).toHaveLength(2);
});

test('insecurely readable persisted secrets reject startup', async () => {
  if (process.platform === 'win32') return;
  const { root, store } = await fixture();
  await store.create({ direction: 'node-connects', label: 'Private' });
  await chmod(join(root, 'execution-nodes.json'), 0o644);
  await expect(new ExecutionNodeConfigStore(root).initialize()).rejects.toThrow('OS account');
});

test('TLS verification defaults on and explicit opt-out survives restart and rename', async () => {
  const { root, store } = await fixture();
  const connectionUrl = nodeConnectionUrl('wss://worker.example.com/execution-node', createNodeSecret());
  const node = await store.create({ direction: 'controller-connects', label: 'Worker', connectionUrl });
  expect(store.connection(node.id).allowUnverifiedTls).toBe(false);
  await store.update(node.id, { connection: {
    direction: 'controller-connects', connectionUrl, allowInsecureDevelopment: false, allowUnverifiedTls: true,
  } });
  await store.update(node.id, { label: 'Renamed' });
  const reloaded = new ExecutionNodeConfigStore(root);
  await reloaded.initialize();
  expect(reloaded.connection(node.id)).toEqual({ connectionUrl, allowInsecureDevelopment: false, allowUnverifiedTls: true });
  await reloaded.update(node.id, { connection: { direction: 'controller-connects', connectionUrl, allowInsecureDevelopment: false } });
  expect(reloaded.connection(node.id).allowUnverifiedTls).toBe(false);
  await reloaded.update(node.id, { connection: {
    direction: 'controller-connects', connectionUrl: connectionUrl.replace('wss:', 'ws:'),
    allowInsecureDevelopment: true, allowUnverifiedTls: true,
  } });
  expect(reloaded.connection(node.id).allowUnverifiedTls).toBe(false);
});
