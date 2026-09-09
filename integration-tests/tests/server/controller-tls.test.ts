import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { X509Certificate } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { controllerTlsOptions, type ControllerTlsTrust } from '../../../common/controller-tls.js';
import { certificateTrust, verifyControllerTlsTrust } from '../../../common/controller-tls-node.js';
import { discoverRuntime } from '../../../cli/discovery.js';
import { prepareFixtureAccount } from '../../support/fixture-account.js';
import { GarconClient } from '../../../cli/garcon-client.js';
import { loadServerTls } from '../../../server/lib/controller-tls.js';
import { GarconProcess } from '../../support/garcon-process.js';
import { TlsCertificates, type TestCertificate } from '../../support/tls-certificates.js';

let certificates: TlsCertificates;
let leaf: TestCertificate;
let root: TestCertificate;
let issued: TestCertificate;
let expired: TestCertificate;
let intermediate: TestCertificate;
let chainedLeaf: TestCertificate;
let fullchain: TestCertificate;

beforeAll(async () => {
  certificates = await TlsCertificates.create();
  leaf = await certificates.selfSigned('self-signed');
  root = await certificates.selfSigned('ca', true);
  issued = await certificates.issued('issued', root);
  expired = await certificates.issued('expired', root, { expired: true });
  intermediate = await certificates.issued('intermediate', root, { ca: true });
  chainedLeaf = await certificates.issued('chained-leaf', intermediate);
  fullchain = await certificates.chain('fullchain', chainedLeaf, [intermediate]);
});
afterAll(async () => certificates?.dispose());

function listener(certificate: { cert: string; key: string }) {
  const requests: Array<{ path: string; authorization: string | null }> = [];
  const server = Bun.serve({
    port: 0, hostname: '0.0.0.0', tls: { cert: certificate.cert, key: certificate.key },
    fetch(request, server) {
      const url = new URL(request.url);
      requests.push({ path: url.pathname, authorization: request.headers.get('Authorization') });
      if (url.pathname === '/redirect') return Response.redirect(`http://127.0.0.1:${server.port}/secret`);
      if (request.headers.get('Upgrade') === 'websocket' && server.upgrade(request)) return;
      return Response.json({ ok: true });
    },
    websocket: { open(socket) { socket.send('verified'); }, message() {} },
  });
  return { server, requests, baseUrl: `https://127.0.0.1:${server.port}` };
}

async function websocketMessage(url: string, trust: ControllerTlsTrust): Promise<string> {
  // The browser-test tsconfig includes lib.dom, which hides Bun's documented constructor overload.
  const RuntimeWebSocket = WebSocket as typeof WebSocket & {
    new(url: string | URL, options: Bun.WebSocketOptions): WebSocket;
  };
  const socket = new RuntimeWebSocket(url.replace('https:', 'wss:'), {
    tls: controllerTlsOptions(trust), headers: { Authorization: 'Garcon-Node synthetic-credential' },
  });
  const timeout = setTimeout(() => socket.close(), 2_000);
  try {
    return await new Promise<string>((resolve, reject) => {
      socket.onmessage = (event) => resolve(String(event.data));
      socket.onerror = () => reject(new Error('TLS WebSocket handshake failed'));
      socket.onclose = () => reject(new Error('TLS WebSocket closed before verification'));
    });
  } finally {
    clearTimeout(timeout);
    socket.close();
  }
}

describe('controller TLS boundary', () => {
  test('loads matching material and verifies fingerprints over DER, not PEM whitespace', async () => {
    expect(await loadServerTls(null)).toBeNull();
    expect(await loadServerTls(leaf)).toEqual({ listener: { cert: leaf.cert, key: leaf.key }, trust: leaf.trust });
    expect(certificateTrust(`\n${leaf.cert.trim()}\n\n`)).toEqual(leaf.trust);
    expect(verifyControllerTlsTrust(leaf.trust)).toEqual(leaf.trust);
    expect(() => certificateTrust(leaf.cert + leaf.key)).toThrow('only certificates');
    expect(() => verifyControllerTlsTrust({
      kind: 'trusted-pem', certificatesPem: [leaf.cert], certificateSha256: ['0'.repeat(64)],
    })).toThrow('fingerprint');
    await expect(loadServerTls({ certificatePath: leaf.certificatePath, keyPath: root.keyPath }))
      .rejects.toThrow('do not match');
  });

  test('rejects malformed and oversized file material before listening', async () => {
    const invalid = join(certificates.directory, 'invalid.pem');
    await writeFile(invalid, 'not a certificate');
    await expect(loadServerTls({ certificatePath: invalid, keyPath: leaf.keyPath })).rejects.toThrow();
    await writeFile(invalid, 'x'.repeat(256 * 1024 + 1));
    await expect(loadServerTls({ certificatePath: invalid, keyPath: leaf.keyPath })).rejects.toThrow('bounded regular file');
    await expect(loadServerTls({ certificatePath: certificates.directory, keyPath: leaf.keyPath })).rejects.toThrow('bounded regular file');
    await expect(loadServerTls({ ...leaf, caPath: invalid })).rejects.toThrow('bounded regular file');
    await expect(loadServerTls({ ...leaf, caPath: leaf.keyPath })).rejects.toThrow('only certificates');
    await writeFile(invalid, 'not a certificate');
    await expect(loadServerTls({ ...leaf, caPath: invalid })).rejects.toThrow();
    await writeFile(invalid, root.cert.repeat(17));
    await expect(loadServerTls({ ...leaf, caPath: invalid })).rejects.toThrow('1 to 16 certificates');
  });

  test('accepts self-signed leaf and private CA trust on the authenticated connection', async () => {
    for (const certificate of [leaf, { ...issued, caPath: root.certificatePath }, { ...fullchain, caPath: root.certificatePath }]) {
      const material = (await loadServerTls(certificate))!;
      const { trust } = material;
      expect(Object.keys(material.listener).sort()).toEqual(['cert', 'key']);
      const fixture = listener(material.listener);
      try {
        const response = await fetch(fixture.baseUrl, {
          tls: controllerTlsOptions(trust), headers: { Authorization: 'synthetic-enrollment' }, redirect: 'error',
        });
        expect(await response.json()).toEqual({ ok: true });
        expect(await websocketMessage(fixture.baseUrl, trust)).toBe('verified');
        expect(fixture.requests.map((request) => request.authorization))
          .toEqual(['synthetic-enrollment', 'Garcon-Node synthetic-credential']);
      } finally { await fixture.server.stop(true); }
    }
  });

  test('uses system trust for signed chains instead of making their certificates trust anchors', async () => {
    const rootBearing = await certificates.chain('root-bearing', chainedLeaf, [intermediate, root]);
    const unrelatedRoot = await certificates.chain('unrelated-root', chainedLeaf, [intermediate, leaf]);
    for (const certificate of [issued, fullchain, rootBearing, unrelatedRoot]) {
      const material = (await loadServerTls(certificate))!;
      expect(material.trust).toEqual({ kind: 'system-ca' });
      expect(JSON.stringify(material.trust)).not.toContain('BEGIN CERTIFICATE');
      const fixture = listener(material.listener);
      try {
        await expect(fetch(fixture.baseUrl, {
          tls: controllerTlsOptions(material.trust), headers: { Authorization: 'synthetic-credential' },
          redirect: 'error', signal: AbortSignal.timeout(2_000),
        })).rejects.toThrow();
        expect(fixture.requests).toEqual([]);
      } finally { await fixture.server.stop(true); }
    }
  });

  test('does not mistake matching issuer names or appended roots for a self-signed leaf', async () => {
    const sameNames = await certificates.issued('self-issued-looking', root, { subject: '/CN=synthetic-ca' });
    const certificate = new X509Certificate(sameNames.cert);
    expect(certificate.subject).toBe(certificate.issuer);
    expect(certificate.verify(certificate.publicKey)).toBe(false);
    expect((await loadServerTls(sameNames))!.trust).toEqual({ kind: 'system-ca' });
    const extra = await certificates.chain('extra-root-after-self-signed', leaf, [root]);
    expect((await loadServerTls(extra))!.trust).toEqual(leaf.trust);
  });

  test('explicit CA trust overrides automatic trust and never falls back on failure', async () => {
    await expect(loadServerTls({ ...issued, caPath: issued.certificatePath })).rejects.toThrow('self-signed trust anchor');
    for (const [certificate, trust] of [
      [issued, issued.trust],
      [chainedLeaf, root.trust],
      [leaf, (await loadServerTls({ ...leaf, caPath: root.certificatePath }))!.trust],
    ] as const) {
      const fixture = listener(certificate);
      try {
        await expect(fetch(fixture.baseUrl, {
          tls: controllerTlsOptions(trust), headers: { Authorization: 'synthetic-credential' },
          redirect: 'error', signal: AbortSignal.timeout(2_000),
        })).rejects.toThrow();
        await expect(websocketMessage(fixture.baseUrl, trust)).rejects.toThrow();
        expect(fixture.requests).toEqual([]);
      } finally { await fixture.server.stop(true); }
    }
  });

  test('failed trust, hostname, and expiry checks send no credential or HTTP upgrade', async () => {
    for (const [certificate, trust, hostname] of [
      [leaf, { kind: 'system-ca' }, '127.0.0.1'],
      [leaf, root.trust, '127.0.0.1'],
      [leaf, leaf.trust, '127.0.0.2'],
      [expired, (await loadServerTls({ ...expired, caPath: root.certificatePath }))!.trust, '127.0.0.1'],
      [issued, (await loadServerTls({ ...issued, caPath: root.certificatePath }))!.trust, '127.0.0.2'],
    ] as const) {
      const fixture = listener(certificate);
      const url = fixture.baseUrl.replace('127.0.0.1', hostname);
      try {
        await expect(fetch(url, {
          tls: controllerTlsOptions(trust), headers: { Authorization: 'synthetic-enrollment' },
          redirect: 'error', signal: AbortSignal.timeout(2_000),
        })).rejects.toThrow();
        await expect(websocketMessage(url, trust)).rejects.toThrow();
        expect(fixture.requests).toEqual([]);
      } finally { await fixture.server.stop(true); }
    }
  });

  test('rejects redirects instead of downgrading an authenticated request', async () => {
    const fixture = listener(leaf);
    try {
      await expect(fetch(`${fixture.baseUrl}/redirect`, {
        tls: controllerTlsOptions(leaf.trust), headers: { Authorization: 'synthetic-enrollment' }, redirect: 'error',
      })).rejects.toThrow();
      expect(fixture.requests.map((request) => request.path)).toEqual(['/redirect']);
    } finally { await fixture.server.stop(true); }
  });

  test('discovers and authenticates to the actual HTTPS controller without global trust changes', async () => {
    for (const [name, certificate, ca, trust] of [
      ['self-signed', leaf, null, leaf.trust], ['private-ca', fullchain, root, root.trust],
    ] as const) {
      const configDir = join(certificates.directory, `config-${name}`);
      const projectDir = join(certificates.directory, `project-${name}`);
      const homeDir = join(certificates.directory, `home-${name}`);
      await Promise.all([configDir, projectDir, homeDir].map((directory) => mkdir(directory)));
      await prepareFixtureAccount(configDir);
      const garcon = await GarconProcess.start({
        repoRoot: join(import.meta.dir, '../../..'), configDir, workspaceDir: join(configDir, 'workspace-tls'),
        workspaceName: 'tls', projectDir, homeDir, bindAddress: '0.0.0.0', disableAuth: false,
        environment: {
          GARCON_TLS_CERT: certificate.certificatePath, GARCON_TLS_KEY: certificate.keyPath,
          ...(ca ? { GARCON_TLS_CA: ca.certificatePath } : {}),
        },
      });
      try {
        expect(garcon.baseUrl.startsWith('https:')).toBe(true);
        const connection = await discoverRuntime({ configDir, workspace: 'tls' });
        expect(connection.tlsTrust).toEqual(trust);
        const client = new GarconClient(connection);
        expect(await client.verifyRuntime()).toBe(true);
        expect(await client.listChats()).toMatchObject({ total: 0 });
        const anonymous = await fetch(`${connection.baseUrl}/api/v1/chats`, { tls: controllerTlsOptions(trust) });
        expect(anonymous.status).toBe(401);
        const rawDescriptor = await readFile(join(configDir, 'workspace-tls/server-runtime.json'), 'utf8');
        expect(rawDescriptor).not.toContain('PRIVATE KEY');
        await expect(fetch(`${connection.baseUrl}/api/v1/runtime`)).rejects.toThrow();
      } finally { await garcon.stop(); }
    }
  }, 30_000);
});
