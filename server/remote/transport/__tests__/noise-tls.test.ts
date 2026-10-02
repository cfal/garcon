import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { WebSocketLink } from '../websocket-link.js';
import { ExecutorRpcConnection } from '../rpc-connection.js';
import { RpcAdmissionBudgets } from '../rpc-admission.js';
import { RpcReplyJournal } from '../rpc-journal.js';
import { readWorkerCliOptions } from '../../worker-cli.js';

const secret = Buffer.alloc(32, 42).toString('base64url');
const cleanups: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function pairedConnections(link: WebSocketLink): Promise<ExecutorRpcConnection> {
  const ready = Promise.withResolvers<ExecutorRpcConnection>();
  const journal = new RpcReplyJournal();
  const admission = new RpcAdmissionBudgets();
  cleanups.push(() => journal.dispose());
  link.onSession(transport => {
    const connection = new ExecutorRpcConnection(link, transport, { journal, admission });
    connection.onEndpoint(rpc => rpc.handle(async () => ({ files: [], truncated: false })));
    void transport.ready.then(() => {
      if (link.role === 'controller') connection.activate();
      ready.resolve(connection);
    });
  });
  return ready.promise;
}

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
  test(`${role} pairs WSS lanes with trusted or explicitly unverified TLS; Noise still requires its key`, async () => {
    const peer = new WebSocketLink({ role: role === 'controller' ? 'worker' : 'controller', executorId: 'synthetic-executor', secret });
    cleanups.push(() => peer.dispose());
    const peerConnection = pairedConnections(peer);
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
    const acceptedConnection = pairedConnections(accepted);
    accepted.dial(address);
    const connections = await Promise.all([acceptedConnection, peerConnection]);
    const endpoints = await Promise.all(connections.map(connection => connection.bulk.wait()));
    expect(endpoints[0]!.transport.id).toBe(endpoints[1]!.transport.id);
    const controller = role === 'controller' ? endpoints[0]! : endpoints[1]!;
    expect(await controller.call('', 'files.list', { projectPath: '/synthetic-project' }))
      .toEqual({ files: [], truncated: false });
    expect(accepted.current?.connected).toBe(true);
    await accepted.dispose();
    const trusted = Bun.spawn([process.execPath, '-e', `
      import { WebSocketLink } from './server/remote/transport/websocket-link.ts';
      import { ExecutorRpcConnection } from './server/remote/transport/rpc-connection.ts';
      import { RpcAdmissionBudgets } from './server/remote/transport/rpc-admission.ts';
      import { RpcReplyJournal } from './server/remote/transport/rpc-journal.ts';
      const link = new WebSocketLink({ role: '${role}', executorId: 'synthetic-executor', secret: process.env.SYNTHETIC_SECRET, redialDelaysMs: [60000] });
      const journal = new RpcReplyJournal();
      let connection;
      link.onSession(transport => {
        connection = new ExecutorRpcConnection(link, transport, { journal, admission: new RpcAdmissionBudgets() });
      });
      link.onError(() => { process.exitCode = 1; void link.dispose(); });
      link.dial(process.env.SYNTHETIC_ADDRESS);
      await link.ready;
      if (link.role === 'controller') connection.activate();
      await connection.bulk.wait();
      await link.dispose();
      journal.dispose();
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
