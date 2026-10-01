import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { WebSocketLink } from '../websocket-link.js';
import { readWorkerCliOptions } from '../../worker-cli.js';

const secret = Buffer.alloc(32, 42).toString('base64url');
const cleanups: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function certificate() {
  const temporary = join(homedir(), 'tmp');
  await mkdir(temporary, { recursive: true });
  const directory = await mkdtemp(join(temporary, 'garcon-noise-tls-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const key = join(directory, 'key.pem');
  const cert = join(directory, 'cert.pem');
  const child = Bun.spawn(['openssl', 'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes',
    '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost'],
  { stdout: 'ignore', stderr: 'pipe' });
  const diagnostics = await new Response(child.stderr).text();
  if (await child.exited !== 0) throw new Error(`Synthetic certificate generation failed: ${diagnostics}`);
  return { key: await Bun.file(key).text(), cert: await Bun.file(cert).text(), keyPath: key, certPath: cert, directory };
}

for (const role of ['controller', 'worker'] as const) {
  test(`${role} verifies WSS by default; opting out still requires the correct Noise key`, async () => {
    const peer = new WebSocketLink({ role: role === 'controller' ? 'worker' : 'controller', executorId: 'synthetic-executor', secret });
    cleanups.push(() => peer.dispose());
    const credentials = await certificate();
    const address = peer.listen(0, '0.0.0.0', credentials);
    for (const config of [
      { secret },
      { secret: Buffer.alloc(32, 9).toString('base64url'), allowUnverifiedTls: true },
    ]) {
      const rejected = new WebSocketLink({ role, executorId: 'synthetic-executor', ...config, redialDelaysMs: [60_000] });
      cleanups.push(() => rejected.dispose());
      const failure = Promise.withResolvers<void>();
      rejected.onError(() => failure.resolve());
      rejected.dial(address);
      await failure.promise;
      expect(rejected.current).toBeNull();
      expect(peer.current).toBeNull();
      await rejected.dispose();
    }
    const accepted = new WebSocketLink({ role, executorId: 'synthetic-executor', secret, allowUnverifiedTls: true });
    cleanups.push(() => accepted.dispose());
    accepted.dial(address);
    await Promise.all([accepted.ready, peer.ready]);
    expect(accepted.current?.connected).toBe(true);
    await accepted.dispose();
    const trusted = Bun.spawn([process.execPath, '-e', `
      import { WebSocketLink } from './server/remote/transport/websocket-link.ts';
      const link = new WebSocketLink({ role: '${role}', executorId: 'synthetic-executor', secret: process.env.SYNTHETIC_SECRET, redialDelaysMs: [60000] });
      link.onError(() => { process.exitCode = 1; void link.dispose(); });
      link.dial(process.env.SYNTHETIC_ADDRESS);
      await link.ready;
      await link.dispose();
    `], { env: { ...process.env, NODE_EXTRA_CA_CERTS: credentials.certPath, SYNTHETIC_SECRET: secret, SYNTHETIC_ADDRESS: address },
      stdout: 'pipe', stderr: 'pipe', timeout: 10_000 });
    const diagnostics = await new Response(trusted.stderr).text();
    expect(await trusted.exited, diagnostics).toBe(0);
  });
}

test('public worker loads TLS files and serves HTTPS without disclosing its private key or Noise secret', async () => {
  const credentials = await certificate();
  const args = ['--listen', '0', '--tls-cert', credentials.certPath, '--tls-private-key', credentials.keyPath, '--config-dir', credentials.directory];
  const options = await readWorkerCliOptions(args, {});
  expect(options.connection).toMatchObject({ kind: 'listen', tls: { cert: credentials.cert, key: credentials.key } });
  await expect(readWorkerCliOptions(['--listen', '0', '--tls-cert', credentials.certPath, '--tls-private-key', credentials.certPath], {})).rejects.toThrow('valid TLS');
  const child = Bun.spawn([process.execPath, 'server/main.ts', 'executor', ...args], {
    env: { ...process.env, GARCON_CONTROLLER_URL: '', GARCON_EXECUTOR_ADVERTISE_URL: '' }, stdout: 'pipe', stderr: 'pipe', timeout: 15_000,
  });
  try {
    const reader = child.stdout.getReader();
    let output = '';
    while (!output.includes('\n')) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error('TLS worker exited before listening');
      output += new TextDecoder().decode(chunk.value);
    }
    reader.releaseLock();
    const frame = JSON.parse(output.split('\n')[0]!);
    expect(frame.url).toStartWith('wss:');
    expect(frame).not.toHaveProperty('connectionUrl');
    expect(output).not.toContain(credentials.key);
    const url = new URL(frame.url);
    url.hostname = '127.0.0.1';
    url.protocol = 'https:';
    expect((await fetch(url, { tls: { ca: credentials.cert } })).status).toBe(400);
    await expect(fetch(url)).rejects.toThrow();
  } finally { child.kill('SIGTERM'); await child.exited; }
});

test('certificate opt-out cannot opt in to ws transport', async () => {
  const link = new WebSocketLink({ role: 'worker', secret, allowUnverifiedTls: true });
  try { expect(() => link.dial('ws://127.0.0.1:1/executor')).toThrow('require TLS'); }
  finally { await link.dispose(); }
});
