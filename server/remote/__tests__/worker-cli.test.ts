import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { homedir, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { readWorkerCliOptions as readOptions } from '../worker-cli.js';
import { parseConnectionUrl } from '../transport/connection-url.js';
import { loadListenerSecret } from '../listener-secret.js';

const roots: string[] = [];
const readWorkerCliOptions = (args: readonly string[]) => readOptions(args, {});
const readDialOptions = (url: string, args: readonly string[] = []) => readOptions(args, { GARCON_CONTROLLER_URL: url });
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function workspace() {
  const temporary = join(homedir(), 'tmp');
  await mkdir(temporary, { recursive: true });
  const root = await mkdtemp(join(temporary, 'worker-cli-'));
  roots.push(root);
  return root;
}

test('worker config root follows controller precedence and rejects workspace selectors', async () => {
  const root = await workspace();
  const url = `wss://example.com/executor/22222222-2222-4222-8222-222222222222#secret=${Buffer.alloc(32, 9).toString('base64url')}`;
  expect((await readOptions([], { GARCON_CONTROLLER_URL: url, HOME: root })).configDir).toBe(join(root, '.garcon'));
  expect((await readDialOptions(url, ['--config-dir', root])).configDir).toBe(root);
  expect((await readOptions([], { GARCON_CONTROLLER_URL: url, GARCON_CONFIG_DIR: root })).configDir).toBe(root);
  expect((await readOptions(['--config-dir', '/elsewhere'], { GARCON_CONTROLLER_URL: url, GARCON_CONFIG_DIR: root })).configDir).toBe('/elsewhere');
  await expect(readDialOptions(url, ['--config-dir', ''])).rejects.toThrow('non-empty');
  await expect(readDialOptions(url, ['--workspace-dir', root])).rejects.toThrow('--workspace-dir is controller-only');
  await expect(readDialOptions(url, ['--workspace', 'default'])).rejects.toThrow('Invalid executor arguments');
});

test('parsing does not open listener storage; startup reuses the private persisted secret', async () => {
  const root = await workspace();
  const args = ['--listen', '0', '--no-tls', '--config-dir', root];
  const first = await readWorkerCliOptions(args);
  expect(first.configDir).toBe(root);
  expect(first).not.toHaveProperty('workspaceDir');
  const restarted = await readWorkerCliOptions(args);
  expect(first).toEqual(restarted);
  await expect(stat(join(root, 'executor'))).rejects.toMatchObject({ code: 'ENOENT' });
  const secret = await loadListenerSecret(join(root, 'executor'));
  expect(await loadListenerSecret(join(root, 'executor'))).toBe(secret);
  expect(first.connection).toEqual({ kind: 'listen', port: 0, bindAddress: '0.0.0.0' });
  if (process.platform !== 'win32') expect((await stat(join(root, 'executor', 'executor-secret.json'))).mode & 0o777).toBe(0o600);
  const full = `wss://example.com/executor/22222222-2222-4222-8222-222222222222#secret=${secret}`;
  const dialing = await readDialOptions(full, ['--config-dir', root]);
  expect(dialing.connection).toEqual({ kind: 'dial', url: full.split('#')[0], secret });
  expect(dialing).not.toHaveProperty('executorId');
  expect(dialing).not.toHaveProperty('label');
  expect(dialing.allowUnverifiedTls).toBe(false);
  expect((await readDialOptions(full, ['--allow-unverified-tls', '--config-dir', root])).allowUnverifiedTls).toBe(true);
  await expect(readWorkerCliOptions([...args, '--allow-unverified-tls'])).rejects.toThrow('only when dialing');
});

test('listener bind address is independent of the advertised URL and rejects empty values or dial mode', async () => {
  const root = await workspace();
  const args = ['--listen', '0', '--no-tls', '--config-dir', root];
  const options = await readWorkerCliOptions([...args, '--bind-address', '127.0.0.1', '--advertise-url', 'ws://worker.example.com:19781/executor']);
  expect(options.connection).toEqual({ kind: 'listen', port: 0, bindAddress: '127.0.0.1' });
  expect(options.advertisedUrl).toBe('ws://worker.example.com:19781/executor');
  await expect(readWorkerCliOptions([...args, '--bind-address', ' '])).rejects.toThrow('non-empty hostname or IP address');
  await expect(readDialOptions(`ws://worker.example.com/executor#secret=${Buffer.alloc(32, 9).toString('base64url')}`,
    ['--bind-address', '127.0.0.1'])).rejects.toThrow('--bind-address applies only to listeners');
});

test('dialing and advertised URLs preserve arbitrary proxy paths and query strings', async () => {
  const root = await workspace();
  const socketUrl = 'wss://proxy.example.com/any-prefix?route=worker&tag=a&tag=b';
  const secret = Buffer.alloc(32, 9).toString('base64url');
  const dialing = await readDialOptions(`${socketUrl}#secret=${secret}`, ['--config-dir', root]);
  expect(dialing.connection).toEqual({ kind: 'dial', url: socketUrl, secret });
  const listening = await readWorkerCliOptions([
    '--listen', '0', '--no-tls', '--config-dir', root, '--advertise-url', socketUrl,
  ]);
  expect(listening.advertisedUrl).toBe(socketUrl);
});

test.each([
  ['0', '0.0.0.0'],
  ['127.1', '127.0.0.1'],
  ['localhost', 'localhost'],
  ['::1', '::1'],
  ['[::1]', '::1'],
  ['::', '::'],
])('canonicalizes listener bind address %s to %s', async (input, expected) => {
  const root = await workspace();
  const options = await readWorkerCliOptions([
    '--listen', '0', '--bind-address', input, '--no-tls', '--config-dir', root,
  ]);
  expect(options.connection).toEqual({ kind: 'listen', port: 0, bindAddress: expected });
});

test.each(['fe80::1%eth0', '[fe80::1%eth0]'])('rejects scoped IPv6 %s before creating listener state', async (bindAddress) => {
  const root = await workspace();
  await expect(readWorkerCliOptions([
    '--listen', '0', '--bind-address', bindAddress, '--no-tls', '--config-dir', root,
    '--advertise-url', 'ws://worker.example.com:19781/executor',
  ])).rejects.toThrow('Scoped IPv6 listener bind addresses are not supported');
  await expect(stat(join(root, 'executor', 'executor-secret.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});

test.each(['localhost:8080', 'http://localhost', 'user@localhost', 'localhost/path', 'localhost?query', 'localhost#fragment'])('rejects a URL or port in bind address %s', async (bindAddress) => {
  const root = await workspace();
  await expect(readWorkerCliOptions([
    '--listen', '0', '--bind-address', bindAddress, '--no-tls', '--config-dir', root,
  ])).rejects.toThrow('Listener bind address must be a hostname or IP address without a port');
});

test('CLI validation does not disclose connection credentials', async () => {
  const secret = Buffer.alloc(32, 7).toString('base64url');
  for (const args of [[], ['--listen', 'NaN'], ['--listen', '99999'], ['--connect', secret, '--listen', '0'], ['--unexpected', secret]]) {
    let failure: unknown;
    try { await readWorkerCliOptions(args); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).not.toContain(secret);
  }
});

test('dial environment is consumed on success and failure; old credential flags are rejected', async () => {
  const url = `wss://controller.example.com/executor#secret=${Buffer.alloc(32, 9).toString('base64url')}`;
  for (const args of [[], ['--listen', '0'], ['--connect', url], ['--allow-insecure-development']]) {
    const environment = { GARCON_CONTROLLER_URL: url };
    if (args.length) await expect(readOptions(args, environment)).rejects.toThrow();
    else expect((await readOptions(args, environment)).connection.kind).toBe('dial');
    expect(environment).not.toHaveProperty('GARCON_CONTROLLER_URL');
  }
  await expect(readDialOptions(url, ['--no-tls'])).rejects.toThrow('conflicts');
  await expect(readDialOptions(url.replace('wss:', 'ws:'))).rejects.toThrow('require TLS');
  expect((await readDialOptions(url.replace('wss:', 'ws:'), ['--no-tls'])).noTls).toBe(true);
});

test('listeners require one explicit TLS mode and a complete readable key pair', async () => {
  for (const flags of [[], ['--tls-cert', '/missing'], ['--tls-private-key', '/missing'],
    ['--no-tls', '--tls-cert', '/missing', '--tls-private-key', '/missing'],
    ['--tls-cert', '/missing', '--tls-private-key', '/missing']]) {
    await expect(readWorkerCliOptions(['--listen', '0', ...flags])).rejects.toThrow();
  }
  await expect(readDialOptions(`wss://host/#secret=${Buffer.alloc(32, 9).toString('base64url')}`, ['--tls-cert', '/missing'])).rejects.toThrow('only to listeners');
});

test('advertised URL flag overrides environment and never carries a credential or wildcard', async () => {
  const environment = { GARCON_EXECUTOR_ADVERTISE_URL: 'wss://public.example.com/proxy?target=worker' };
  expect((await readOptions(['--listen', '0', '--no-tls'], environment)).advertisedUrl).toBe(environment.GARCON_EXECUTOR_ADVERTISE_URL);
  expect((await readOptions(['--listen', '0', '--no-tls', '--advertise-url', 'wss://override.example.com/'], environment)).advertisedUrl).toBe('wss://override.example.com/');
  for (const advertisedUrl of ['ws://0.0.0.0/executor', 'wss://host/#secret=invalid', 'wss://user:password@host/']) {
    await expect(readOptions(['--listen', '0', '--no-tls'], { GARCON_EXECUTOR_ADVERTISE_URL: advertisedUrl })).rejects.toThrow();
  }
});

test.each([undefined, '127.0.0.1', '0'])('public worker starts with bind address %s without printing its secret', async (bindAddress) => {
  const root = await workspace();
  const advertisedUrl = bindAddress === '127.0.0.1' ? 'ws://worker.example.com:19781/executor' : undefined;
  const child = Bun.spawn(['bun', 'server/main.ts', 'executor', '--listen', '0', '--no-tls', '--config-dir', root,
    ...(bindAddress ? ['--bind-address', bindAddress] : []),
    ...(advertisedUrl ? ['--advertise-url', advertisedUrl] : [])], {
    stdout: 'pipe', stderr: 'pipe',
    env: { ...process.env, GARCON_CONFIG_DIR: '', GARCON_CONTROLLER_URL: '', GARCON_EXECUTOR_ADVERTISE_URL: '' },
  });
  try {
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    let output = '';
    while (!output.includes('\n')) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error('Worker exited before listening');
      output += decoder.decode(chunk.value, { stream: true });
    }
    reader.releaseLock();
    const listening = JSON.parse(output.split('\n')[0]!);
    expect(listening.type).toBe('executor-listening');
    const listener = new URL(listening.url);
    expect(listener.hostname).toBe(bindAddress === '127.0.0.1' ? bindAddress : '0.0.0.0');
    expect(listening).not.toHaveProperty('connectionUrl');
    expect(output).not.toContain(await loadListenerSecret(join(root, 'executor')));
    const reveal = Bun.spawn(['bun', 'server/main.ts', 'executor', 'connection-url', '--config-dir', root,
      '--advertise-url', advertisedUrl ?? listening.url.replace('0.0.0.0', '127.0.0.1'), '--no-tls'], { stdout: 'pipe', stderr: 'pipe' });
    const revealed = (await new Response(reveal.stdout).text()).trim();
    expect(await reveal.exited).toBe(0);
    expect(parseConnectionUrl(revealed).secret).toBe(await loadListenerSecret(join(root, 'executor')));
    listener.protocol = 'http:';
    listener.hostname = '127.0.0.1';
    expect((await fetch(listener)).status).toBe(400);
    const external = Object.values(networkInterfaces()).flat().find((entry) => entry?.family === 'IPv4' && !entry.internal);
    if (external) {
      listener.hostname = external.address;
      if (bindAddress === '127.0.0.1') {
        await expect(fetch(listener, { signal: AbortSignal.timeout(1000) })).rejects.toThrow();
      } else {
        expect((await fetch(listener, { signal: AbortSignal.timeout(1000) })).status).toBe(400);
      }
    }
    child.kill('SIGTERM');
    expect(await child.exited).toBe(0);
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
    await child.exited;
  }
}, 15_000);

test('dialing worker starts and shuts down offline without disclosing its credential', async () => {
  const root = await workspace();
  const secret = Buffer.alloc(32, 8).toString('base64url');
  const connectionUrl = `ws://127.0.0.1:1/executor/22222222-2222-4222-8222-222222222222#secret=${secret}`;
  const child = Bun.spawn(['bun', 'server/main.ts', 'executor',
    '--config-dir', root, '--no-tls'], { stdout: 'pipe', stderr: 'pipe',
      env: { ...process.env, GARCON_CONFIG_DIR: '', GARCON_CONTROLLER_URL: connectionUrl, GARCON_EXECUTOR_ADVERTISE_URL: '' } });
  const reader = child.stdout.getReader();
  let output = '';
  try {
    const decoder = new TextDecoder();
    while (!output.includes('\n')) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error('Worker exited before listening');
      output += decoder.decode(chunk.value, { stream: true });
    }
    expect(JSON.parse(output.split('\n')[0]!)).not.toHaveProperty('connectionUrl');
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
    await child.exited;
    const decoder = new TextDecoder();
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      output += decoder.decode(chunk.value, { stream: true });
    }
    reader.releaseLock();
  }
  output += await new Response(child.stderr).text();
  expect(output).not.toContain(secret);
  expect(child.exitCode).toBe(0);
}, 15_000);
