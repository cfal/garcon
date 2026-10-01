import { expect, mock, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExecutorSnapshot } from '@garcon/common/executors';
import { parseCliArgs } from '../args.js';
import { applyExecutorConnectionStdin, readExecutorConnectionStdin } from '../executor-args.js';
import { runExecutorCommand, type ExecutorCommandClient } from '../executor-commands.js';
import { executorProviders } from '../executor-responses.js';
import { GarconTransportError } from '../garcon-client.js';
import { createCliOutput } from '../output.js';

const id = '11111111-1111-4111-8111-111111111111';
const snapshot: ExecutorSnapshot = { id, label: 'Worker', kind: 'remote', enabled: true,
  allowControllerCli: true, allowExecutorManagement: false, direction: 'executor-connects', availability: 'ready',
  instanceId: 'synthetic', projectBasePath: '/workspace', lastError: null,
  machineServices: { files: true, git: true, gh: true, terminals: true } };
const connection = { connectionUrl: `wss://worker.test/executor#secret=${'A'.repeat(43)}`, allowInsecureDevelopment: false, allowUnverifiedTls: false };
const providers = [{ id: 'synthetic-profile', label: 'Profile', executorIds: [id] }];

function command(args: string[]) {
  const parsed = parseCliArgs(['executor', ...args], {}, '/workspace');
  if (parsed.kind !== 'executor') throw new Error('Wrong command');
  return parsed;
}

function fixture() {
  let stdout = '';
  let stderr = '';
  const output = createCliOutput({ write(text) { stdout += text; } }, { write(text) { stderr += text; } });
  const client = {
    listExecutors: mock(async () => [snapshot]), createExecutor: mock(async () => ({ id })),
    updateExecutor: mock(async () => [snapshot]), deleteExecutor: mock(async () => []),
    getExecutorConnection: mock(async () => connection), getExecutorProviders: mock(async () => providers),
    assignExecutorProvider: mock(async () => providers), unassignExecutorProvider: mock(async () => [{ ...providers[0]!, executorIds: [] }]),
  } satisfies ExecutorCommandClient;
  return { client, output, stdout: () => stdout, stderr: () => stderr };
}

test('executor parser handles independent grants, both directions, and strict update flags', () => {
  expect(command(['create', '--label', ' Worker ', '--direction', 'executor-connects', '--advertise-url', 'wss://controller.test/executor/{executorId}',
    '--allow-controller-cli', 'true', '--allow-executor-management', 'false']).operation).toMatchObject({ action: 'create', request: {
      label: 'Worker', allowControllerCli: true, allowExecutorManagement: false, advertisedUrl: 'wss://controller.test/executor/{executorId}',
    } });
  expect(command(['update', id, '--allow-executor-management', 'false']).operation).toEqual({ action: 'update', id, request: { allowExecutorManagement: false } });
  expect(command(['update', id, '--direction', 'controller-connects', '--connection-url', '-', '--allow-insecure-development', 'false']).readsConnectionFromStdin).toBe(true);
  expect(command(['assign-provider', 'local', '--provider', 'synthetic-profile']).operation).toEqual({ action: 'assign-provider', id: 'local', providerId: 'synthetic-profile' });
});

test('executor parser rejects irrelevant, ambiguous, unsafe, and incomplete options', () => {
  for (const args of [
    [], ['missing'], ['list', id], ['list', '--provider', 'synthetic'], ['show'], ['show', 'unknown'], ['delete', 'local'],
    ['update', id], ['update', id, '--allow-controller-cli', 'yes'], ['update', id, '--connection-url', connection.connectionUrl],
    ['update', id, '--allow-executor-management', 'true', '--allow-executor-management', 'false'],
    ['create', '--label', 'Worker', '--direction', 'executor-connects'],
    ['create', '--label', 'Worker', '--label', 'Other', '--direction', 'executor-connects', '--advertise-url', 'wss://worker.test'],
    ['create', '--label', 'Worker', '--direction', 'controller-connects', '--connection-url', connection.connectionUrl, '--advertise-url', 'wss://worker.test'],
    ['wait', id], ['wait', id, '--ready', '--timeout', '0'], ['wait', id, '--ready', '--timeout', 'Infinity'],
    ['connection', id, '--json', '--output', 'credential'], ['enable', id, '--force'], ['assign-provider', id],
  ]) expect(() => command(args)).toThrow();
});

test('credential stdin is bounded, strict UTF-8, and applied only to the connection', async () => {
  const parsed = command(['create', '--label', 'Worker', '--direction', 'controller-connects', '--connection-url', '-']);
  expect(applyExecutorConnectionStdin(parsed, `${connection.connectionUrl}\n`).operation).toMatchObject({ request: { connectionUrl: connection.connectionUrl } });
  for (const value of ['', 'x'.repeat(4100), 'one\ntwo', '\ud800']) expect(() => applyExecutorConnectionStdin(parsed, value)).toThrow();
  const stream = (bytes: Uint8Array) => new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } });
  expect(await readExecutorConnectionStdin(stream(new TextEncoder().encode(connection.connectionUrl)))).toBe(connection.connectionUrl);
  await expect(readExecutorConnectionStdin(stream(new Uint8Array([0xff])))).rejects.toThrow('UTF-8');
  await expect(readExecutorConnectionStdin(stream(new Uint8Array(5000)))).rejects.toThrow('4096');
  const abort = new AbortController();
  abort.abort();
  await expect(readExecutorConnectionStdin(stream(new Uint8Array()), abort.signal)).rejects.toThrow();
});

test('all administration verbs call their typed operation and ordinary output stays credential-free', async () => {
  for (const args of [['list'], ['show', id], ['providers'], ['wait', id, '--ready'],
    ['create', '--label', 'Worker', '--direction', 'controller-connects', '--connection-url', connection.connectionUrl],
    ['update', id, '--label', 'Worker'], ['enable', id], ['disable', id], ['delete', id],
    ['assign-provider', id, '--provider', 'synthetic-profile'], ['unassign-provider', id, '--provider', 'synthetic-profile']]) {
    const f = fixture();
    await runExecutorCommand(command([...args, '--json']), f.client, f.output);
    expect(JSON.parse(f.stdout())).toBeDefined();
    expect(f.stdout()).not.toContain('secret');
    expect(f.stderr()).toBe('');
  }
});

test('unknown mutation outcomes are reported without retries and controls cannot inject terminal escapes', async () => {
  const f = fixture();
  f.client.createExecutor.mockRejectedValueOnce(new GarconTransportError('executors', 'disconnected'));
  await expect(runExecutorCommand(command(['create', '--label', 'Worker', '--direction', 'controller-connects', '--connection-url', connection.connectionUrl]), f.client, f.output))
    .rejects.toThrow('outcome is unknown');
  expect(f.client.createExecutor).toHaveBeenCalledTimes(1);
  f.client.listExecutors.mockResolvedValueOnce([{ ...snapshot, label: '\x1b[31m\u202eWorker' }]);
  await runExecutorCommand(command(['list']), f.client, f.output);
  expect(f.stdout()).not.toContain('\x1b');
  expect(f.stdout()).not.toContain('\u202e');
});

test('readiness waits reject disabled, missing, cancelled and timed-out executors', async () => {
  const f = fixture();
  f.client.listExecutors.mockResolvedValueOnce([{ ...snapshot, enabled: false, availability: 'offline' }]);
  await expect(runExecutorCommand(command(['wait', id, '--ready']), f.client, f.output)).rejects.toThrow('disabled');
  f.client.listExecutors.mockResolvedValueOnce([]);
  await expect(runExecutorCommand(command(['wait', id, '--ready']), f.client, f.output)).rejects.toThrow('not found');
  f.client.listExecutors.mockResolvedValue([{ ...snapshot, availability: 'offline', lastError: { code: 'EXECUTOR_UNAVAILABLE', message: 'Connection refused' } }]);
  const waiting = command(['wait', id, '--ready']);
  await expect(runExecutorCommand({ ...waiting, operation: { action: 'wait', id, timeoutMs: 10 } }, f.client, f.output)).rejects.toThrow('Connection refused');
  const abort = new AbortController();
  abort.abort(new Error('Synthetic cancellation'));
  await expect(runExecutorCommand(waiting, f.client, f.output, abort.signal)).rejects.toThrow('Synthetic cancellation');
});

test('connection reveal uses exclusive private output and does not echo credentials when writing a file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'executor-cli-output-'));
  try {
    const f = fixture();
    const target = join(root, 'connection');
    await runExecutorCommand(command(['connection', id, '--output', target]), f.client, f.output);
    expect(await readFile(target, 'utf8')).toBe(`${connection.connectionUrl}\n`);
    if (process.platform !== 'win32') expect((await stat(target)).mode & 0o777).toBe(0o600);
    expect(f.stdout()).toBe('');
    expect(f.stderr()).not.toContain('secret');
    await expect(runExecutorCommand(command(['connection', id, '--output', target]), f.client, f.output)).rejects.toThrow('already exists');
    expect(f.client.getExecutorConnection).toHaveBeenCalledTimes(1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('provider projection validates identities and discards irrelevant endpoint metadata', () => {
  const value = { providers: [{ id: 'synthetic-profile', label: 'Profile', endpoints: [{ apiKeyLabel: 'redacted' }] }], assignments: { revision: 1, assignments: { [id]: ['synthetic-profile'] } } };
  expect(executorProviders(value)).toEqual(providers);
  for (const invalid of [null, { ...value, assignments: { revision: 1, assignments: { bad: [] } } },
    { ...value, providers: [...value.providers, ...value.providers] }]) expect(() => executorProviders(invalid)).toThrow();
});
