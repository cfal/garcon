import { afterEach, expect, test } from 'bun:test';
import { createNoiseServer } from '@cfal/noise-ws';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { WebSocketLink } from '../websocket-link.js';

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
  return { key: await Bun.file(key).text(), cert: await Bun.file(cert).text() };
}

for (const role of ['controller', 'worker'] as const) {
  test(`${role} verifies WSS by default; opting out still requires the correct Noise key`, async () => {
    const peer = new WebSocketLink({ role: role === 'controller' ? 'worker' : 'controller', nodeId: 'synthetic-node', secret });
    cleanups.push(() => peer.dispose());
    const noise = createNoiseServer();
    const server = Bun.serve({
      hostname: '0.0.0.0', port: 0, tls: await certificate(), websocket: noise.websocket,
      fetch(request, server) { return peer.upgrade(request, server, noise); },
    });
    cleanups.push(async () => { noise.close(); await server.stop(true); });
    const address = `wss://127.0.0.1:${server.port}/execution-node`;
    for (const config of [
      { secret },
      { secret: Buffer.alloc(32, 9).toString('base64url'), allowUnverifiedTls: true },
    ]) {
      const rejected = new WebSocketLink({ role, nodeId: 'synthetic-node', ...config, reconnectDelayMs: 60_000 });
      cleanups.push(() => rejected.dispose());
      const failure = Promise.withResolvers<void>();
      rejected.onError(() => failure.resolve());
      rejected.dial(address);
      await failure.promise;
      expect(rejected.current).toBeNull();
      expect(peer.current).toBeNull();
      await rejected.dispose();
    }
    const accepted = new WebSocketLink({ role, nodeId: 'synthetic-node', secret, allowUnverifiedTls: true });
    cleanups.push(() => accepted.dispose());
    accepted.dial(address);
    await Promise.all([accepted.ready, peer.ready]);
    expect(accepted.current?.connected).toBe(true);
  });
}

test('certificate opt-out cannot opt in to ws transport', async () => {
  const link = new WebSocketLink({ role: 'worker', secret, allowUnverifiedTls: true });
  try { expect(() => link.dial('ws://127.0.0.1:1/execution-node')).toThrow('require TLS'); }
  finally { await link.dispose(); }
});
