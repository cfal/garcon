import { afterEach, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ExecutorConfigStore } from '../config-store.js';
import { createExecutorSecret, executorConnectionUrl } from '../../../remote/transport/connection-url.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const temporary = join(homedir(), 'tmp');
  await mkdir(temporary, { recursive: true });
  const root = await mkdtemp(join(temporary, 'executor-config-'));
  roots.push(root);
  const store = new ExecutorConfigStore(root);
  await store.initialize();
  return { root, store };
}

test('CLI access defaults off, persists separately, and older stored executors remain denied', async () => {
  const { root, store } = await fixture();
  const executor = await store.create({ direction: 'executor-connects', label: 'Worker' });
  expect(executor.allowControllerCli).toBe(false);
  await store.update(executor.id, { allowControllerCli: true });
  const restarted = new ExecutorConfigStore(root);
  await restarted.initialize();
  expect(restarted.require(executor.id).allowControllerCli).toBe(true);
  const file = join(root, 'executors.json');
  const stored = JSON.parse(await readFile(file, 'utf8'));
  delete stored.executors[0].allowControllerCli;
  await writeFile(file, JSON.stringify(stored));
  await restarted.initialize();
  expect(restarted.require(executor.id).allowControllerCli).toBe(false);
});

test('executor configuration is private, durable, and never persists a Local executor', async () => {
  const { root, store } = await fixture();
  expect(store.list()).toEqual([]);
  const executor = await store.create({ direction: 'executor-connects', label: 'Build machine' });
  expect(store.connection(executor.id).connectionUrl).toBe(`wss://example.com/executor/${executor.id}#secret=${executor.secret}`);
  const filePath = join(root, 'executors.json');
  if (process.platform !== 'win32') expect((await stat(filePath)).mode & 0o777).toBe(0o600);
  expect(JSON.parse(await readFile(filePath, 'utf8')).executors).toEqual([executor]);
  const reloaded = new ExecutorConfigStore(root);
  await reloaded.initialize();
  expect(reloaded.list()).toEqual([executor]);
  await expect(store.remove('local')).rejects.toMatchObject({ code: 'EXECUTOR_NOT_FOUND' });
});

test('URL updates preserve identity and configuration objects are not mutable capabilities', async () => {
  const { store } = await fixture();
  const original = await store.create({ direction: 'executor-connects', label: 'Original' });
  const connectionUrl = `ws://127.0.0.1:8080/executor/${original.id}#secret=${original.secret}`;
  await store.update(original.id, { connection: { direction: 'executor-connects', connectionUrl, allowInsecureDevelopment: true } });
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
  const connectionUrl = executorConnectionUrl('wss://worker.example.com/executor', createExecutorSecret());
  const [first, second] = await Promise.all([
    store.create({ direction: 'controller-connects', label: 'Remote', connectionUrl }),
    store.create({ direction: 'executor-connects', label: 'Inbound' }),
  ]);
  expect(store.list()).toHaveLength(2);
  expect(first.secret).not.toBe(second.secret);
  await expect(store.create({ direction: 'controller-connects', label: 'Duplicate', connectionUrl })).rejects.toThrow('unique');
  expect(store.list()).toHaveLength(2);
});

test.each(['executor-connects', 'controller-connects'] as const)(
  'arbitrary public URLs survive updates and restart (%s)', async (direction) => {
    const { root, store } = await fixture();
    const connectionUrl = executorConnectionUrl('wss://proxy.example.com/any-prefix?route=worker&tag=a&tag=b', createExecutorSecret());
    const executor = await store.create(direction === 'executor-connects'
      ? { direction, label: 'Proxied worker' }
      : { direction, label: 'Proxied worker', connectionUrl });
    await store.update(executor.id, { connection: { direction, connectionUrl, allowInsecureDevelopment: false } });
    const reloaded = new ExecutorConfigStore(root);
    await reloaded.initialize();
    expect(reloaded.connection(executor.id).connectionUrl).toBe(connectionUrl);
    expect(reloaded.require(executor.id).id).toBe(executor.id);
  },
);

test('insecurely readable persisted secrets reject startup', async () => {
  if (process.platform === 'win32') return;
  const { root, store } = await fixture();
  await store.create({ direction: 'executor-connects', label: 'Private' });
  await chmod(join(root, 'executors.json'), 0o644);
  await expect(new ExecutorConfigStore(root).initialize()).rejects.toThrow('OS account');
});

test('TLS verification defaults on and explicit opt-out survives restart and rename', async () => {
  const { root, store } = await fixture();
  const connectionUrl = executorConnectionUrl('wss://worker.example.com/executor', createExecutorSecret());
  const executor = await store.create({ direction: 'controller-connects', label: 'Worker', connectionUrl });
  expect(store.connection(executor.id).allowUnverifiedTls).toBe(false);
  await store.update(executor.id, { connection: {
    direction: 'controller-connects', connectionUrl, allowInsecureDevelopment: false, allowUnverifiedTls: true,
  } });
  await store.update(executor.id, { label: 'Renamed' });
  const reloaded = new ExecutorConfigStore(root);
  await reloaded.initialize();
  expect(reloaded.connection(executor.id)).toEqual({ connectionUrl, allowInsecureDevelopment: false, allowUnverifiedTls: true });
  await reloaded.update(executor.id, { connection: { direction: 'controller-connects', connectionUrl, allowInsecureDevelopment: false } });
  expect(reloaded.connection(executor.id).allowUnverifiedTls).toBe(false);
  await reloaded.update(executor.id, { connection: {
    direction: 'controller-connects', connectionUrl: connectionUrl.replace('wss:', 'ws:'),
    allowInsecureDevelopment: true, allowUnverifiedTls: true,
  } });
  expect(reloaded.connection(executor.id).allowUnverifiedTls).toBe(false);
});
