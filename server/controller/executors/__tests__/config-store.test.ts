import { afterEach, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ExecutorConfigStore } from '../config-store.js';
import { createExecutorSecret, executorConnectionUrl } from '../../../remote/transport/connection-url.js';
import { CorruptStateFileError } from '../../../common/json-file-store.js';

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
  expect(executor.connection).toEqual({ kind: 'executor-connects', advertisedUrl: null });
  expect(store.connection(executor.id).connectionUrl).toBe('');
  expect(store.connection(executor.id, 'https://controller.test/base/').connectionUrl)
    .toBe(`wss://controller.test/base/executor/${executor.id}#secret=${executor.secret}`);
  const filePath = join(root, 'executors.json');
  if (process.platform !== 'win32') expect((await stat(filePath)).mode & 0o777).toBe(0o600);
  expect(JSON.parse(await readFile(filePath, 'utf8')).executors).toEqual([executor]);
  const reloaded = new ExecutorConfigStore(root);
  await reloaded.initialize();
  expect(reloaded.list()).toEqual([executor]);
  await expect(store.remove('local')).rejects.toMatchObject({ code: 'EXECUTOR_NOT_FOUND' });
});

test('management access defaults off and persists independently of ordinary CLI access', async () => {
  const { root, store } = await fixture();
  const executor = await store.create({ direction: 'executor-connects', label: 'Worker', allowControllerCli: true });
  expect(executor.allowExecutorManagement).toBe(false);
  await store.update(executor.id, { allowExecutorManagement: true, allowControllerCli: false });
  const restarted = new ExecutorConfigStore(root);
  await restarted.initialize();
  expect(restarted.require(executor.id)).toMatchObject({ allowControllerCli: false, allowExecutorManagement: true });
  const file = join(root, 'executors.json');
  const stored = JSON.parse(await readFile(file, 'utf8'));
  delete stored.executors[0].allowExecutorManagement;
  await writeFile(file, JSON.stringify(stored));
  await restarted.initialize();
  expect(restarted.require(executor.id).allowExecutorManagement).toBe(false);
});

test('URL updates preserve identity and configuration objects are not mutable capabilities', async () => {
  const { store } = await fixture();
  const original = await store.create({ direction: 'executor-connects', label: 'Original' });
  const connectionUrl = `ws://127.0.0.1:8080/executor/${original.id}#secret=${original.secret}`;
  await store.update(original.id, { connection: { direction: 'executor-connects', connectionUrl, noTls: true } });
  const updated = await store.update(original.id, { label: 'Renamed', enabled: false });
  expect(updated.id).toBe(original.id);
  expect(updated.secret).toBe(original.secret);
  expect(store.connection(original.id).connectionUrl).toBe(connectionUrl);
  expect(store.connection(original.id, 'not a public URL').connectionUrl).toBe(connectionUrl);
  const copy = store.list() as { label: string }[];
  copy[0].label = 'Corrupted';
  expect(store.require(original.id).label).toBe('Renamed');
  await store.remove(original.id);
  expect(store.list()).toEqual([]);
});

test('inbound creation atomically expands and validates a public address without storing a caller secret', async () => {
  const { root, store } = await fixture();
  const created = await store.create({ direction: 'executor-connects', label: 'Proxied', advertisedUrl: 'wss://controller.test/proxy/{executorId}?route={executorId}&tag=a&tag=b' });
  expect(created.connection).toEqual({ kind: 'executor-connects', advertisedUrl: `wss://controller.test/proxy/${created.id}?route=${created.id}&tag=a&tag=b` });
  for (const advertisedUrl of ['ws://controller.test', 'wss://0.0.0.0/executor', 'wss://controller.test/#secret=secret', 'https://controller.test',
    `wss://controller.test/${'{executorId}'.repeat(150)}`]) {
    await expect(store.create({ direction: 'executor-connects', label: 'Invalid', advertisedUrl })).rejects.toThrow();
  }
  expect(store.list()).toHaveLength(1);
  const restarted = new ExecutorConfigStore(root);
  await restarted.initialize();
  expect(restarted.connection(created.id)).toEqual(store.connection(created.id));
});

test('normalized connection addresses remain usable within request and response limits', async () => {
  const { store } = await fixture();
  const created = await store.create({ direction: 'executor-connects', label: 'Synthetic worker' });
  const connectionUrl = `wss://worker.test/${' '.repeat(1500)}/#secret=${createExecutorSecret()}`;
  await expect(store.create({ direction: 'controller-connects', label: 'Oversized', connectionUrl })).rejects.toThrow('exceeds 4096');
  await expect(store.update(created.id, { connection: { direction: 'controller-connects', connectionUrl, noTls: false } })).rejects.toThrow('exceeds 4096');
  expect(store.list()).toEqual([created]);
});

test('policy-only updates preserve inherited public URLs across restart and public-base changes', async () => {
  const { root, store } = await fixture();
  const executor = await store.create({ direction: 'executor-connects', label: 'Inherited' });
  await store.update(executor.id, { connection: { direction: 'executor-connects', noTls: true } });
  const reloaded = new ExecutorConfigStore(root);
  await reloaded.initialize();
  expect(reloaded.require(executor.id).connection).toEqual({ kind: 'executor-connects', advertisedUrl: null });
  expect(reloaded.connection(executor.id, 'https://new-controller.test/base').connectionUrl)
    .toBe(`wss://new-controller.test/base/executor/${executor.id}#secret=${executor.secret}`);
  await expect(reloaded.update(executor.id, { connection: { direction: 'controller-connects', noTls: true } }))
    .rejects.toThrow('Changing connection direction requires a connection URL');
});

test.each(['executor-connects', 'controller-connects'] as const)('policy-only updates validate the retained explicit URL (%s)', async direction => {
  const { store } = await fixture();
  const executor = await store.create({ direction: 'executor-connects', label: 'Explicit' });
  const connectionUrl = executorConnectionUrl('ws://worker.test/executor', executor.secret);
  await store.update(executor.id, { connection: { direction, connectionUrl, noTls: true } });
  await store.update(executor.id, { connection: { direction, noTls: true } });
  expect(store.connection(executor.id).connectionUrl).toBe(connectionUrl);
  await expect(store.update(executor.id, { connection: { direction, noTls: false } })).rejects.toThrow('require TLS');
  expect(store.connection(executor.id).noTls).toBe(true);
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

test('executor labels are case-insensitively unique across serialized creates and reserve Local', async () => {
  const { root, store } = await fixture();
  const results = await Promise.allSettled([' Build Machine ', 'BUILD MACHINE'].map((label) =>
    store.create({ direction: 'executor-connects', label })));
  expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected']);
  expect(results[1]).toMatchObject({ reason: { code: 'VALIDATION_FAILED', message: expect.stringContaining('already exists') } });
  for (const label of ['Local', 'local', ' LOCAL ']) {
    await expect(store.create({ direction: 'executor-connects', label })).rejects.toThrow('reserved');
  }
  expect(store.list().map((entry) => entry.label)).toEqual(['Build Machine']);
  const restarted = new ExecutorConfigStore(root);
  await restarted.initialize();
  await expect(restarted.create({ direction: 'executor-connects', label: 'build machine' })).rejects.toThrow('already exists');
});

test('renames reject collisions with disabled executors but allow changing their own capitalization', async () => {
  const { root, store } = await fixture();
  const first = await store.create({ direction: 'executor-connects', label: 'First' });
  const second = await store.create({ direction: 'executor-connects', label: 'Second' });
  await store.update(first.id, { enabled: false });
  const before = await readFile(join(root, 'executors.json'), 'utf8');
  await expect(store.update(second.id, { label: ' FIRST ', allowControllerCli: true })).rejects.toThrow('already exists');
  await expect(store.update(second.id, { label: 'LOCAL' })).rejects.toThrow('reserved');
  expect(await readFile(join(root, 'executors.json'), 'utf8')).toBe(before);
  expect(store.require(second.id)).toEqual(second);
  expect((await store.update(second.id, { label: 'SECOND' })).label).toBe('SECOND');
  const results = await Promise.allSettled([store.update(first.id, { label: 'Shared' }), store.update(second.id, { label: 'SHARED' })]);
  expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected']);
  await store.remove(first.id);
  expect((await store.update(second.id, { label: 'shared' })).label).toBe('shared');
});

test('existing duplicate labels stay readable and configurable while a rename repairs them', async () => {
  const { root, store } = await fixture();
  const first = await store.create({ direction: 'executor-connects', label: 'First' });
  const second = await store.create({ direction: 'executor-connects', label: 'Second' });
  const file = join(root, 'executors.json');
  await writeFile(file, JSON.stringify({ version: 1, executors: store.list().map((entry) => ({
    ...entry, label: entry.id === second.id ? ' Duplicate ' : 'Duplicate',
  })) }));
  await store.initialize();
  expect(store.list()).toHaveLength(2);
  await store.update(first.id, { enabled: false, label: 'Duplicate' });
  await store.update(second.id, { label: 'Duplicate', allowExecutorManagement: true });
  expect(store.require(second.id)).toMatchObject({ label: 'Duplicate', allowExecutorManagement: true });
  await expect(store.create({ direction: 'executor-connects', label: 'DUPLICATE' })).rejects.toThrow('already exists');
  await store.update(second.id, { label: 'Repaired' });
  expect(store.list().map((entry) => entry.label)).toEqual(['Duplicate', 'Repaired']);
});

test.each(['executor-connects', 'controller-connects'] as const)(
  'arbitrary public URLs survive updates and restart (%s)', async (direction) => {
    const { root, store } = await fixture();
    const connectionUrl = executorConnectionUrl('wss://proxy.example.com/any-prefix?route=worker&tag=a&tag=b', createExecutorSecret());
    const executor = await store.create(direction === 'executor-connects'
      ? { direction, label: 'Proxied worker' }
      : { direction, label: 'Proxied worker', connectionUrl });
    await store.update(executor.id, { connection: { direction, connectionUrl, noTls: false } });
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

test('retired executor schema rejects startup with explicit upgrade and restore instructions', async () => {
  const { root, store } = await fixture();
  const executor = await store.create({ direction: 'executor-connects', label: 'Upgrade' });
  const file = join(root, 'executors.json');
  const stored = JSON.parse(await readFile(file, 'utf8'));
  stored.executors[0].allowInsecureDevelopment = stored.executors[0].noTls;
  delete stored.executors[0].noTls;
  const legacy = JSON.stringify(stored);
  await writeFile(file, legacy);
  const error = await new ExecutorConfigStore(root).initialize().then(() => null, error => error);
  expect(error.message).toContain('rename it to noTls, preserving its boolean value');
  expect(error.message).toContain('restore it to');
  expect(error.cause).toBeInstanceOf(CorruptStateFileError);
  expect(error.message).toContain(error.cause.quarantinePath);
  expect(error.message).not.toContain(executor.secret);
  expect(await readFile(error.cause.quarantinePath, 'utf8')).toBe(legacy);
  stored.executors[0].noTls = stored.executors[0].allowInsecureDevelopment;
  delete stored.executors[0].allowInsecureDevelopment;
  await writeFile(file, JSON.stringify(stored), { mode: 0o600 });
  const upgraded = new ExecutorConfigStore(root);
  await upgraded.initialize();
  expect(upgraded.require(executor.id).secret).toBe(executor.secret);
});

test.each([
  { kind: 'executor-connects' },
  { kind: 'executor-connects', advertisedUrl: 1 },
  { kind: 'controller-connects' },
  { kind: 'controller-connects', targetUrl: null },
  { kind: 'controller-connects', targetUrl: 1 },
  { kind: 'unknown', targetUrl: 'wss://worker.test/executor' },
])('malformed stored connections retain their validation failure: %j', async connection => {
  const { root, store } = await fixture();
  await store.create({ direction: 'executor-connects', label: 'Malformed' });
  const file = join(root, 'executors.json');
  const stored = JSON.parse(await readFile(file, 'utf8'));
  stored.executors[0].connection = connection;
  await writeFile(file, JSON.stringify(stored));
  await expect(new ExecutorConfigStore(root).initialize()).rejects.toMatchObject({
    cause: { message: 'Invalid executor connection configuration' },
  });
});

test('TLS verification defaults on and explicit opt-out survives restart and rename', async () => {
  const { root, store } = await fixture();
  const connectionUrl = executorConnectionUrl('wss://worker.example.com/executor', createExecutorSecret());
  const executor = await store.create({ direction: 'controller-connects', label: 'Worker', connectionUrl });
  expect(store.connection(executor.id).allowUnverifiedTls).toBe(false);
  await store.update(executor.id, { connection: {
    direction: 'controller-connects', connectionUrl, noTls: false, allowUnverifiedTls: true,
  } });
  await store.update(executor.id, { label: 'Renamed' });
  const reloaded = new ExecutorConfigStore(root);
  await reloaded.initialize();
  expect(reloaded.connection(executor.id)).toEqual({ connectionUrl, noTls: false, allowUnverifiedTls: true });
  await reloaded.update(executor.id, { connection: { direction: 'controller-connects', connectionUrl, noTls: false } });
  expect(reloaded.connection(executor.id).allowUnverifiedTls).toBe(false);
  await reloaded.update(executor.id, { connection: {
    direction: 'controller-connects', connectionUrl: connectionUrl.replace('wss:', 'ws:'),
    noTls: true, allowUnverifiedTls: true,
  } });
  expect(reloaded.connection(executor.id).allowUnverifiedTls).toBe(false);
});
