import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { homedir, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { readWorkerCliOptions } from '../worker-cli.js';
import { parseConnectionUrl } from '../connection-url.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function workspace() {
  const temporary = join(homedir(), 'tmp');
  await mkdir(temporary, { recursive: true });
  const root = await mkdtemp(join(temporary, 'worker-cli-'));
  roots.push(root);
  return root;
}

test('listener reuses a private persisted secret while connect takes the complete URL', async () => {
  const root = await workspace();
  const args = ['--listen', '0', '--allow-insecure-development', '--workspace-dir', root];
  const first = await readWorkerCliOptions(args);
  const restarted = await readWorkerCliOptions(args);
  expect(first.secret).toBe(restarted.secret);
  expect(first.connection).toEqual({ kind: 'listen', port: 0, bindAddress: '0.0.0.0' });
  if (process.platform !== 'win32') expect((await stat(join(root, 'execution-node-secret.json'))).mode & 0o777).toBe(0o600);
  const full = `wss://example.com/execution-node/22222222-2222-4222-8222-222222222222#secret=${first.secret}`;
  const dialing = await readWorkerCliOptions(['--connect', full, '--workspace-dir', root]);
  expect(dialing.secret).toBe(first.secret);
  expect(dialing.connection).toEqual({ kind: 'dial', url: full.split('#')[0] });
  expect(dialing).not.toHaveProperty('nodeId');
  expect(dialing).not.toHaveProperty('label');
  expect(dialing.allowUnverifiedTls).toBe(false);
  expect((await readWorkerCliOptions(['--connect', full, '--allow-unverified-tls', '--workspace-dir', root])).allowUnverifiedTls).toBe(true);
  await expect(readWorkerCliOptions([...args, '--allow-unverified-tls'])).rejects.toThrow('only to --connect');
});

test('listener bind address is independent of the advertised URL and rejects empty values or dial mode', async () => {
  const root = await workspace();
  const args = ['--listen', '0', '--allow-insecure-development', '--workspace-dir', root];
  const options = await readWorkerCliOptions([...args, '--bind-address', '127.0.0.1', '--advertise-url', 'ws://worker.example.com:19781/execution-node']);
  expect(options.connection).toEqual({ kind: 'listen', port: 0, bindAddress: '127.0.0.1' });
  expect(options.advertisedUrl).toBe('ws://worker.example.com:19781/execution-node');
  await expect(readWorkerCliOptions([...args, '--bind-address', ' '])).rejects.toThrow('non-empty hostname or IP address');
  await expect(readWorkerCliOptions(['--connect', `ws://worker.example.com/execution-node#secret=${options.secret}`,
    '--bind-address', '127.0.0.1'])).rejects.toThrow('--bind-address applies only to listeners');
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
    '--listen', '0', '--bind-address', input, '--allow-insecure-development', '--workspace-dir', root,
  ]);
  expect(options.connection).toEqual({ kind: 'listen', port: 0, bindAddress: expected });
});

test.each(['fe80::1%eth0', '[fe80::1%eth0]'])('rejects scoped IPv6 %s before creating listener state', async (bindAddress) => {
  const root = await workspace();
  await expect(readWorkerCliOptions([
    '--listen', '0', '--bind-address', bindAddress, '--allow-insecure-development', '--workspace-dir', root,
    '--advertise-url', 'ws://worker.example.com:19781/execution-node',
  ])).rejects.toThrow('Scoped IPv6 listener bind addresses are not supported');
  await expect(stat(join(root, 'execution-node-secret.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});

test.each(['localhost:8080', 'http://localhost', 'user@localhost', 'localhost/path', 'localhost?query', 'localhost#fragment'])('rejects a URL or port in bind address %s', async (bindAddress) => {
  const root = await workspace();
  await expect(readWorkerCliOptions([
    '--listen', '0', '--bind-address', bindAddress, '--allow-insecure-development', '--workspace-dir', root,
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

test.each([undefined, '127.0.0.1', '0'])('public worker starts with bind address %s, prints onboarding URL, and shuts down without a controller', async (bindAddress) => {
  const root = await workspace();
  const advertisedUrl = bindAddress === '127.0.0.1' ? 'ws://worker.example.com:19781/execution-node' : undefined;
  const process = Bun.spawn(['bun', 'server/main.ts', 'execution-node', '--listen', '0', '--allow-insecure-development', '--workspace-dir', root,
    ...(bindAddress ? ['--bind-address', bindAddress] : []),
    ...(advertisedUrl ? ['--advertise-url', advertisedUrl] : [])], {
    stdout: 'pipe', stderr: 'pipe',
  });
  try {
    const reader = process.stdout.getReader();
    const decoder = new TextDecoder();
    let output = '';
    while (!output.includes('\n')) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error('Worker exited before listening');
      output += decoder.decode(chunk.value, { stream: true });
    }
    reader.releaseLock();
    const listening = JSON.parse(output.split('\n')[0]!);
    expect(listening.type).toBe('execution-node-listening');
    const listener = new URL(listening.url);
    expect(listener.hostname).toBe(bindAddress === '127.0.0.1' ? bindAddress : '0.0.0.0');
    expect(parseConnectionUrl(listening.connectionUrl).socketUrl).toBe(advertisedUrl ?? listening.url);
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
    process.kill('SIGTERM');
    expect(await process.exited).toBe(0);
  } finally {
    if (process.exitCode === null) process.kill('SIGTERM');
    await process.exited;
  }
}, 15_000);

test('dialing worker starts and shuts down offline without disclosing its credential', async () => {
  const root = await workspace();
  const secret = Buffer.alloc(32, 8).toString('base64url');
  const connectionUrl = `ws://127.0.0.1:1/execution-node/22222222-2222-4222-8222-222222222222#secret=${secret}`;
  const child = Bun.spawn(['bun', 'server/main.ts', 'execution-node', '--connect', connectionUrl,
    '--workspace-dir', root, '--allow-insecure-development'], { stdout: 'pipe', stderr: 'pipe' });
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
