import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { request as requestHttps } from 'node:https';
import { controllerTlsOptions, type ControllerTlsTrust } from '../../../common/controller-tls.js';
import { parseNodeEnrollmentBundle, type NodeEnrollmentBundle } from '../../../common/execution-node-config.js';
import { enrollExecutionNode } from '../../../server/execution-node/enrollment-client.js';
import { prepareFixtureAccount } from '../../support/fixture-account.js';
import { TlsCertificates, type TestCertificate } from '../../support/tls-certificates.js';
import { MAX_NODE_ENROLLMENTS_PER_PEER_PER_MINUTE } from '../../../server/routes/execution-node-enrollment.js';
import type { EnrollmentFixtureCommand, EnrollmentFixtureReady, EnrollmentFixtureReply, EnrollmentFixtureRequest } from '../../support/node-enrollment-server.js';

let certificates: TlsCertificates;
let leaf: TestCertificate;
let root: TestCertificate;
let issued: TestCertificate;
let expired: TestCertificate;
beforeAll(async () => {
  certificates = await TlsCertificates.create();
  leaf = await certificates.selfSigned('node-leaf');
  root = await certificates.selfSigned('node-root', true);
  issued = await certificates.issued('node-issued', root);
  expired = await certificates.issued('node-expired', root, { expired: true });
});
afterAll(async () => certificates?.dispose());

async function fixture(certificate: TestCertificate | null, trust: ControllerTlsTrust, options: {
  authDisabled?: boolean; needsSetup?: boolean; directory?: string;
} = {}) {
  const directory = options.directory ?? await mkdtemp(join(homedir(), 'garcon-node-enrollment-http-'));
  const workspace = join(directory, 'workspace');
  await mkdir(workspace, { recursive: true });
  if (!options.needsSetup && !options.directory) await prepareFixtureAccount(directory);
  const ready = Promise.withResolvers<EnrollmentFixtureReady>();
  const replies = new Map<number, (reply: EnrollmentFixtureReply) => void>();
  let sequence = 0;
  const child = Bun.spawn([process.execPath, join(import.meta.dir, '../../support/node-enrollment-server.ts')], {
    cwd: join(import.meta.dir, '../../..'), stdin: 'ignore', stdout: 'ignore', stderr: 'pipe',
    env: { ...process.env,
      GARCON_CONFIG_DIR: directory, GARCON_WORKSPACE_DIR: workspace, GARCON_DISABLE_AUTH: String(options.authDisabled ?? false),
      GARCON_TLS_CERT: certificate?.certificatePath ?? '', GARCON_TLS_KEY: certificate?.keyPath ?? '', GARCON_TLS_CA: '',
      GARCON_ENROLLMENT_TEST_TRUST: JSON.stringify(trust),
    },
    ipc(message: EnrollmentFixtureReady | EnrollmentFixtureReply) {
      if (message.type === 'ready') ready.resolve(message);
      else { replies.get(message.id)?.(message); replies.delete(message.id); }
    },
  });
  const diagnostic = new Response(child.stderr).text();
  const timeout = setTimeout(() => ready.reject(new Error('Enrollment fixture startup timed out')), 10_000);
  const earlyExit = child.exited.then(async () => { throw new Error('Enrollment fixture exited: ' + await diagnostic); });
  let details: EnrollmentFixtureReady;
  try { details = await Promise.race([ready.promise, earlyExit]); }
  catch (error) { child.kill(); await child.exited; await rm(directory, { recursive: true, force: true }); throw error; }
  finally { clearTimeout(timeout); }
  return {
    ...details, directory, workspace,
    async command(command: EnrollmentFixtureCommand): Promise<EnrollmentFixtureReply> {
      const id = ++sequence;
      const reply = Promise.withResolvers<EnrollmentFixtureReply>();
      replies.set(id, reply.resolve);
      child.send({ id, command } satisfies EnrollmentFixtureRequest);
      const timer = setTimeout(() => reply.reject(new Error('Enrollment fixture command timed out')), 5000);
      try { return await reply.promise; } finally { clearTimeout(timer); replies.delete(id); }
    },
    post(path: string, body: unknown, credential?: string): Promise<Response> {
      return fetch(`${details.baseUrl}${path}`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(credential ? { Authorization: 'Bearer ' + credential } : {}) },
        body: JSON.stringify(body), tls: controllerTlsOptions(trust), redirect: 'error', signal: AbortSignal.timeout(5000),
      });
    },
    async issue(): Promise<NodeEnrollmentBundle> {
      const response = await this.post('/api/v1/execution-nodes/enrollment', { nodeId: details.nodeId }, details.accountToken);
      expect(response.status).toBe(200);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      const parsed = parseNodeEnrollmentBundle(await response.json());
      expect(parsed).not.toBeNull();
      return parsed!;
    },
    async stop(retain = false): Promise<void> {
      child.send({ id: ++sequence, command: { kind: 'stop' } } satisfies EnrollmentFixtureRequest);
      const timer = setTimeout(() => child.kill(), 5000);
      try { expect(await child.exited).toBe(0); await diagnostic; }
      finally { clearTimeout(timer); if (!retain) await rm(directory, { recursive: true, force: true }); }
    },
  };
}

const signal = () => AbortSignal.timeout(5000);
const exchange = (bundle: NodeEnrollmentBundle) => ({ version: bundle.version, controllerId: bundle.controllerId, nodeId: bundle.nodeId, token: bundle.token });

describe('node enrollment across HTTPS, account authorization, and private persistence', () => {
  test('pairs through self-signed or private-CA trust and persists only verifiers', async () => {
    for (const [certificate, trust] of [[leaf, leaf.trust], [issued, root.trust]] as const) {
      const f = await fixture(certificate, trust);
      try {
        const bundle = await f.issue();
        const paired = await enrollExecutionNode(bundle, signal());
        expect(paired).toMatchObject({ controllerId: bundle.controllerId, nodeId: f.nodeId, trust });
        expect(await f.command({ kind: 'authenticate', credential: paired.credential })).toMatchObject({ exchanges: 1, authenticated: true });
        const persisted = await readFile(join(f.workspace, 'execution-node-pairing.json'), 'utf8');
        expect(persisted).not.toContain(bundle.token);
        expect(persisted).not.toContain(paired.credential);
        const topology = await readFile(join(f.workspace, 'execution-nodes.json'), 'utf8');
        expect(topology).not.toContain(bundle.token);
        expect(topology).not.toContain(paired.credential);
        await expect(enrollExecutionNode(bundle, signal())).rejects.toMatchObject({ code: 'NODE_ENROLLMENT_INVALID' });
      } finally { await f.stop(); }
    }
  });

  test('requires an administrator account instead of browserless, local, or node capabilities', async () => {
    const f = await fixture(leaf, leaf.trust);
    try {
      const input = { nodeId: f.nodeId };
      expect((await f.post('/api/v1/execution-nodes/enrollment', input)).status).toBe(401);
      expect((await f.post('/api/v1/execution-nodes/enrollment', input, f.localCapability)).status).toBe(403);
      expect((await f.post('/api/v1/execution-nodes/enrollment', { ...input, nodeId: f.localNodeId }, f.accountToken)).status).toBe(409);
      const bundle = await f.issue();
      expect((await f.post('/api/v1/execution-nodes/enroll', { ...exchange(bundle), token: f.accountToken })).status).toBe(400);
      const paired = await enrollExecutionNode(bundle, signal());
      expect((await f.post('/api/v1/execution-nodes/enrollment', input, paired.credential)).status).toBe(401);
    } finally { await f.stop(); }
    for (const options of [{ authDisabled: true }, { needsSetup: true }]) {
      const f = await fixture(leaf, leaf.trust, options);
      try {
        const response = await f.post('/api/v1/execution-nodes/enrollment', { nodeId: f.nodeId }, f.accountToken);
        expect(response.status).toBe(403);
        expect(await response.json()).toMatchObject({ errorCode: 'NODE_ADMIN_REQUIRED' });
        const exchangeResponse = await f.post('/api/v1/execution-nodes/enroll', { version: 1, controllerId: 'controller', nodeId: f.nodeId, token: `enroll.token.${'A'.repeat(43)}` });
        expect(exchangeResponse.status).toBe(403);
        await expect(readFile(join(f.workspace, 'execution-node-pairing.json'))).rejects.toMatchObject({ code: 'ENOENT' });
      } finally { await f.stop(); }
    }
  });

  test('rejects plaintext enrollment even with spoofed forwarded HTTPS metadata', async () => {
    const f = await fixture(null, { kind: 'system-ca' });
    try {
      const response = await fetch(`${f.baseUrl}/api/v1/execution-nodes/enroll`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-Proto': 'https', 'X-Forwarded-For': '127.0.0.1' },
        body: JSON.stringify({ version: 1, controllerId: 'controller', nodeId: f.nodeId, token: `enroll.token.${'A'.repeat(43)}` }),
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ errorCode: 'NODE_TLS_REQUIRED' });
      await expect(readFile(join(f.workspace, 'execution-node-pairing.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await f.stop(); }
  });

  test('consumes concurrent requests once, rejects expiry, and requires revoke/reissue after a lost reply', async () => {
    const f = await fixture(leaf, leaf.trust);
    try {
      const bundle = await f.issue();
      const results = await Promise.allSettled([enrollExecutionNode(bundle, signal()), enrollExecutionNode(bundle, signal())]);
      expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
      expect(await f.command({ kind: 'inspect' })).toMatchObject({ exchanges: 2 });
      await f.command({ kind: 'revoke' });
      const fresh = await f.issue();
      await f.command({ kind: 'drop-reply' });
      await expect(enrollExecutionNode(fresh, signal())).rejects.toMatchObject({ code: 'NODE_PAIRING_UNAVAILABLE' });
      expect(await f.command({ kind: 'inspect' })).toMatchObject({ exchanges: 3 });
      await expect(enrollExecutionNode(fresh, signal())).rejects.toMatchObject({ code: 'NODE_ENROLLMENT_INVALID' });
      await f.command({ kind: 'revoke' });
      const replacement = await f.issue();
      await f.command({ kind: 'expire' });
      await expect(enrollExecutionNode(replacement, signal())).rejects.toMatchObject({ code: 'NODE_ENROLLMENT_EXPIRED' });
    } finally { await f.stop(); }
  });

  test('retains controller identity and revocation after restarting the credential authority', async () => {
    const first = await fixture(leaf, leaf.trust);
    let bundle: NodeEnrollmentBundle;
    let paired: Awaited<ReturnType<typeof enrollExecutionNode>>;
    try {
      bundle = await first.issue();
      paired = await enrollExecutionNode(bundle, signal());
    } catch (error) { await first.stop(); throw error; }
    await first.stop(true);
    const second = await fixture(leaf, leaf.trust, { directory: first.directory });
    try {
      expect(second.nodeId).toBe(first.nodeId);
      expect(await second.command({ kind: 'authenticate', credential: paired.credential })).toMatchObject({ authenticated: true });
      await second.command({ kind: 'revoke' });
      const fresh = await second.issue();
      expect(fresh.controllerId).toBe(bundle.controllerId);
      expect(await second.command({ kind: 'authenticate', credential: paired.credential })).toMatchObject({ authenticated: false });
      expect((await enrollExecutionNode(fresh, signal())).credential).not.toBe(paired.credential);
    } finally { await second.stop(); }
  });

  test('sends no token request when TLS trust, hostname, or validity fails', async () => {
    for (const [certificate, trust, hostname, reason] of [
      [leaf, { kind: 'system-ca' }, '127.0.0.1', 'certificate-untrusted'],
      [leaf, root.trust, '127.0.0.1', 'certificate-untrusted'],
      [leaf, leaf.trust, '127.0.0.2', 'hostname-mismatch'],
      [expired, root.trust, '127.0.0.1', 'certificate-expired'],
    ] as const) {
      const f = await fixture(certificate, trust);
      try {
        const bundle: NodeEnrollmentBundle = { version: 1, controllerId: 'controller', nodeId: f.nodeId,
          controllerUrl: f.baseUrl.replace('127.0.0.1', hostname), trust, expiresAt: new Date(Date.now() + 60_000).toISOString(), token: `enroll.token.${'A'.repeat(43)}` };
        await expect(enrollExecutionNode(bundle, signal())).rejects.toMatchObject({ code: 'NODE_TLS_UNTRUSTED', tlsReason: reason });
        expect(await f.command({ kind: 'inspect' })).toMatchObject({ exchanges: 0 });
      } finally { await f.stop(); }
    }
  });

  test('does not follow enrollment redirects to another origin, path, or plaintext listener', async () => {
    for (const target of ['https://elsewhere.invalid/enroll', 'http://127.0.0.1/secret', '/redirected']) {
      const paths: string[] = [];
      const server = Bun.serve({ hostname: '0.0.0.0', port: 0, tls: { cert: leaf.cert, key: leaf.key },
        fetch(request) {
          paths.push(new URL(request.url).pathname);
          return Response.redirect(new URL(target, request.url).href, 307);
        },
      });
      try {
        const bundle: NodeEnrollmentBundle = { version: 1, controllerId: 'controller', nodeId: 'node',
          controllerUrl: `https://127.0.0.1:${server.port}`, trust: leaf.trust,
          expiresAt: new Date(Date.now() + 60_000).toISOString(), token: `enroll.token.${'A'.repeat(43)}` };
        await expect(enrollExecutionNode(bundle, signal())).rejects.toMatchObject({ code: 'NODE_PAIRING_UNAVAILABLE' });
        expect(paths).toEqual(['/api/v1/execution-nodes/enroll']);
      } finally { await server.stop(true); }
    }
  });

  test('rejects changed trust until the operator supplies an explicitly reissued bundle', async () => {
    const first = await fixture(leaf, leaf.trust);
    let bundle: NodeEnrollmentBundle;
    try { bundle = await first.issue(); }
    catch (error) { await first.stop(); throw error; }
    await first.stop(true);
    const second = await fixture(issued, root.trust, { directory: first.directory });
    try {
      await expect(enrollExecutionNode({ ...bundle, controllerUrl: second.baseUrl }, signal())).rejects.toMatchObject({ code: 'NODE_TLS_UNTRUSTED' });
      expect(await second.command({ kind: 'inspect' })).toMatchObject({ exchanges: 0 });
      const fresh = await second.issue();
      expect(fresh.controllerId).toBe(bundle.controllerId);
      expect(fresh.nodeId).toBe(bundle.nodeId);
      expect(fresh.trust).toEqual(root.trust);
      expect((await enrollExecutionNode(fresh, signal())).nodeId).toBe(bundle.nodeId);
    } finally { await second.stop(); }
  });

  test('rejects caller-selected destinations or trust, request versions, and namespaces', async () => {
    const f = await fixture(leaf, leaf.trust);
    try {
      for (const override of [{ controllerUrl: 'https://unrelated.test' }, { trust: root.trust },
        { trust: { ...leaf.trust, certificateSha256: ['0'.repeat(64)] } }]) {
        const response = await f.post('/api/v1/execution-nodes/enrollment', { nodeId: f.nodeId, ...override }, f.accountToken);
        expect(response.status).toBe(400);
      }
      await expect(readFile(join(f.workspace, 'execution-node-pairing.json'))).rejects.toMatchObject({ code: 'ENOENT' });
      const bundle = await f.issue();
      expect((await f.post('/api/v1/execution-nodes/enroll', { ...exchange(bundle), version: 2 })).status).toBe(400);
      expect((await f.post('/api/v1/execution-nodes/enroll', { ...exchange(bundle), controllerId: 'another-controller' })).status).toBe(401);
      expect((await f.post('/api/v1/execution-nodes/enroll', { ...exchange(bundle), nodeId: 'another-node' })).status).toBe(401);
      expect((await enrollExecutionNode(bundle, signal())).nodeId).toBe(f.nodeId);
    } finally { await f.stop(); }
  });

  test('accepts a real gzip response while enforcing the decoded byte bound', async () => {
    const paired = { version: 1, controllerId: 'controller', nodeId: 'node', credential: `node.node.${'A'.repeat(43)}` };
    const payload = JSON.stringify(paired);
    const compressed = gzipSync(payload);
    expect(compressed.byteLength).not.toBe(Buffer.byteLength(payload));
    let requests = 0;
    let oversized = false;
    const server = Bun.serve({
      hostname: '0.0.0.0', port: 0,
      tls: { cert: await readFile(leaf.certificatePath), key: await readFile(leaf.keyPath) },
      fetch() {
        requests++;
        const bytes = oversized ? gzipSync(' '.repeat(4096) + payload) : compressed;
        return new Response(bytes, { headers: {
          'Content-Type': 'application/json', 'Content-Encoding': 'gzip', 'Content-Length': String(bytes.byteLength),
        } });
      },
    });
    const bundle: NodeEnrollmentBundle = { version: 1, controllerId: 'controller', nodeId: 'node',
      controllerUrl: `https://127.0.0.1:${server.port}`, trust: leaf.trust,
      expiresAt: new Date(Date.now() + 60_000).toISOString(), token: `enroll.token.${'A'.repeat(43)}` };
    try {
      expect(await enrollExecutionNode(bundle, signal())).toMatchObject(paired);
      oversized = true;
      await expect(enrollExecutionNode(bundle, signal())).rejects.toMatchObject({ code: 'NODE_PAIRING_UNAVAILABLE' });
      expect(requests).toBe(2);
    } finally { await server.stop(true); }
  });

  test('conceals anonymous resource status while allowing an administrator to issue beyond the peer quota', async () => {
    const f = await fixture(leaf, leaf.trust);
    try {
      let bundle = await f.issue();
      for (let index = 0; index < MAX_NODE_ENROLLMENTS_PER_PEER_PER_MINUTE; index++) bundle = await f.issue();
      const responses = [];
      for (const nodeId of ['unknown-node', f.localNodeId, f.nodeId]) {
        const response = await f.post('/api/v1/execution-nodes/enroll', { ...exchange(bundle), nodeId, token: `enroll.token.${'A'.repeat(43)}` });
        expect(response.status).toBe(401);
        responses.push(await response.json());
      }
      expect(responses[0]).toEqual(responses[1]);
      expect(responses[1]).toEqual(responses[2]);
      expect(responses[0]).toMatchObject({ errorCode: 'NODE_ENROLLMENT_INVALID' });
      expect((await enrollExecutionNode(bundle, signal())).nodeId).toBe(f.nodeId);
    } finally { await f.stop(); }
  });

  test('one physical HTTPS peer cannot exhaust another peer\'s exchange budget', async () => {
    const f = await fixture(leaf, leaf.trust);
    try {
      const bundle = await f.issue();
      for (let index = 0; index < MAX_NODE_ENROLLMENTS_PER_PEER_PER_MINUTE; index++) {
        expect((await f.post('/api/v1/execution-nodes/enroll', { ...exchange(bundle), version: 2 })).status).toBe(400);
      }
      expect((await f.post('/api/v1/execution-nodes/enroll', exchange(bundle))).status).toBe(429);
      await expect(enrollExecutionNode(bundle, signal())).rejects.toMatchObject({ code: 'NODE_PAIRING_CAPACITY', retryable: true });
      const response = await new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
        const request = requestHttps(`${f.baseUrl}/api/v1/execution-nodes/enroll`, {
          method: 'POST', localAddress: '127.0.0.2', agent: false,
          ca: leaf.cert, rejectUnauthorized: true, signal: signal(),
          headers: { 'Content-Type': 'application/json' },
        }, (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('error', reject);
          response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
        });
        request.on('error', reject);
        request.end(JSON.stringify(exchange(bundle)));
      });
      expect(response.status).toBe(200);
      expect(JSON.parse(response.body)).toMatchObject({ nodeId: f.nodeId, controllerId: bundle.controllerId });
    } finally { await f.stop(); }
  });
});
