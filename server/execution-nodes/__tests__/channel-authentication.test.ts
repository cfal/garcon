import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { NodeChannelAuthentication, MAX_NODE_CHANNEL_HANDSHAKES, MAX_NODE_CHANNEL_ATTEMPTS_PER_PEER_PER_MINUTE } from '../channel-authentication.js';
import { NodePairingStore } from '../pairing-store.js';
import { NodeEnrollmentTransport } from '../trust.js';
import { DomainError } from '../../lib/domain-error.js';
import { AtomicJsonWriteError, writeJsonFileAtomic } from '../../lib/json-file-store.js';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

async function fixture(options: ConstructorParameters<typeof NodePairingStore>[1] = {}) {
  const directory = await mkdtemp(path.join(homedir(), 'garcon-node-channel-auth-')); directories.push(directory);
  const pairings = new NodePairingStore(directory, options); await pairings.init();
  const enrollment = await pairings.issueEnrollment('synthetic-node');
  const paired = await pairings.enroll({ version: 1, controllerId: enrollment.controllerId, nodeId: enrollment.nodeId, token: enrollment.token });
  let now = 0; let enabled = true;
  const authentication = new NodeChannelAuthentication({ pairings, now: () => now,
    transport: new NodeEnrollmentTransport({ listenerUsesTls: true }),
    authorize() { if (!enabled) throw new DomainError('NODE_ADMIN_REQUIRED', 'Synthetic administration disabled', 403); } });
  const request = (authorization = `Garcon-Node ${paired.credential}`, url = 'https://synthetic.invalid/ws/nodes') =>
    new Request(url, { headers: { Upgrade: 'websocket', Authorization: authorization } });
  const peer = (i = 1) => ({ requestIP: () => ({ address: `127.0.0.${i}` }) });
  return { authentication, pairings, paired, request, peer, advance() { now += 60_000; }, disable() { enabled = false; } };
}

test('captures a credential authority without exposing its secret and rejects it after re-pairing', async () => {
  const f = await fixture();
  const first = f.authentication.authenticate(f.request(), f.peer());
  expect(first.principal).toEqual({ controllerId: f.paired.controllerId, nodeId: f.paired.nodeId });
  expect(JSON.stringify(first)).not.toContain(f.paired.credential);
  first.validate(); first.releaseHandshake();
  await f.pairings.revoke(f.paired.nodeId);
  expect(() => first.validate()).toThrow();
  expect(() => f.authentication.authenticate(f.request(), f.peer())).toThrow();
  const enrollment = await f.pairings.issueEnrollment(f.paired.nodeId);
  const next = await f.pairings.enroll({ version: 1, nodeId: enrollment.nodeId, controllerId: enrollment.controllerId, token: enrollment.token });
  const replacement = f.authentication.authenticate(f.request(`Garcon-Node ${next.credential}`), f.peer());
  replacement.validate(); replacement.releaseHandshake();
  expect(() => first.validate()).toThrow();
});

test('an unrelated pairing write leaves established channels valid while new authentication waits', async () => {
  let pause = false;
  const writing = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const f = await fixture({ write: async (...args) => {
    if (pause) { writing.resolve(); await release.promise; }
    await writeJsonFileAtomic(...args);
  } });
  const connection = f.authentication.authenticate(f.request(), f.peer()); connection.releaseHandshake();
  pause = true;
  const issued = f.pairings.issueEnrollment('synthetic-other-node');
  await writing.promise;
  try {
    expect(() => connection.validate()).not.toThrow();
    expect(() => f.authentication.authenticate(f.request(), f.peer())).toThrow('in progress');
  } finally { release.resolve(); await issued; }
  expect(() => connection.validate()).not.toThrow();
});

test('unknown credential durability invalidates established channels even after an unrelated write', async () => {
  let uncertain = false;
  const f = await fixture({ write: async (...args) => {
    await writeJsonFileAtomic(...args);
    if (uncertain) throw new AtomicJsonWriteError('Synthetic unconfirmed write', true);
  } });
  const connection = f.authentication.authenticate(f.request(), f.peer()); connection.releaseHandshake();
  uncertain = true;
  await expect(f.pairings.issueEnrollment('synthetic-other-node')).rejects.toThrow('unconfirmed');
  expect(() => connection.validate()).toThrow('durability is unknown');
});

test('revocation fences only its node before waiting behind another credential write', async () => {
  let hold = false;
  const writing = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const f = await fixture({ write: async (...args) => {
    if (hold) { hold = false; writing.resolve(); await release.promise; }
    await writeJsonFileAtomic(...args);
  } });
  const issue = await f.pairings.issueEnrollment('other-node');
  const other = await f.pairings.enroll({ version: 1, controllerId: issue.controllerId, nodeId: issue.nodeId, token: issue.token });
  const first = f.authentication.authenticate(f.request(), f.peer()); first.releaseHandshake();
  const second = f.authentication.authenticate(f.request(`Garcon-Node ${other.credential}`), f.peer()); second.releaseHandshake();
  hold = true;
  const blocker = f.pairings.issueEnrollment('third-node');
  await writing.promise;
  const revoked = f.pairings.revoke(f.paired.nodeId);
  const duplicate = f.pairings.revoke(f.paired.nodeId);
  try {
    expect(() => first.validate()).toThrow('no longer current');
    expect(() => second.validate()).not.toThrow();
  } finally {
    release.resolve();
    await Promise.all([blocker, revoked, duplicate]);
  }
  expect(() => first.validate()).toThrow('no longer current');
  expect(() => second.validate()).not.toThrow();
  expect(f.pairings.authenticate(f.paired.credential)).toBeNull();
});

test('a pre-write revocation failure requires fresh authentication and never revives captured channels', async () => {
  let fail = false;
  const f = await fixture({ write: async (...args) => {
    if (fail) throw new AtomicJsonWriteError('Synthetic failed revocation', false);
    await writeJsonFileAtomic(...args);
  } });
  const captured = f.authentication.authenticate(f.request(), f.peer()); captured.releaseHandshake();
  fail = true;
  const pending = f.pairings.revoke(f.paired.nodeId);
  expect(() => captured.validate()).toThrow('no longer current');
  await expect(pending).rejects.toThrow('Synthetic failed revocation');
  const fresh = f.authentication.authenticate(f.request(), f.peer()); fresh.releaseHandshake();
  expect(() => fresh.validate()).not.toThrow();
  expect(() => captured.validate()).toThrow('no longer current');
});

test('browser/local credentials, query credentials, wrong endpoints and plaintext cannot authorize node upgrades', async () => {
  const f = await fixture();
  for (const header of ['', 'Bearer synthetic-account-jwt', 'Bearer synthetic-local-capability', `Garcon-Node ${f.paired.credential}, synthetic-extra`]) {
    expect(() => f.authentication.authenticate(f.request(header), f.peer())).toThrow();
  }
  for (const url of ['http://synthetic.invalid/ws/nodes', 'https://synthetic.invalid/ws/nodes/extra', 'https://synthetic.invalid/ws/nodes?credential=synthetic', 'https://synthetic.invalid/ws']) {
    expect(() => f.authentication.authenticate(f.request(undefined, url), f.peer())).toThrow();
  }
});

test('bulk upgrade authentication retains its distinct channel kind and the same credential lifetime', async () => {
  const f = await fixture();
  const session = f.authentication.authenticate(f.request(), f.peer());
  const bulk = f.authentication.authenticate(f.request(undefined, 'https://synthetic.invalid/ws/nodes/bulk'), f.peer());
  expect(session.kind).toBe('session'); expect(bulk.kind).toBe('bulk');
  expect(bulk.principal).toEqual(session.principal);
  session.releaseHandshake(); bulk.releaseHandshake();
  for (const url of ['https://synthetic.invalid/ws/nodes/bulk/extra', 'https://synthetic.invalid/ws/nodes/bulk?session=synthetic',
    'http://synthetic.invalid/ws/nodes/bulk']) expect(() => f.authentication.authenticate(f.request(undefined, url), f.peer())).toThrow();
  expect(() => f.authentication.authenticate(f.request('Bearer synthetic-browser', 'https://synthetic.invalid/ws/nodes/bulk'), f.peer())).toThrow();
  await f.pairings.revoke(f.paired.nodeId);
  expect(() => bulk.validate()).toThrow();
});

test('handshake capacity is bounded, release is idempotent, and completed connections still revalidate administration', async () => {
  const f = await fixture();
  const grants = Array.from({ length: MAX_NODE_CHANNEL_HANDSHAKES }, (_, i) => f.authentication.authenticate(f.request(), f.peer(i + 1)));
  expect(() => f.authentication.authenticate(f.request(), f.peer(99))).toThrow('Too many');
  grants[0]!.releaseHandshake(); grants[0]!.releaseHandshake();
  const replacement = f.authentication.authenticate(f.request(), f.peer(99));
  expect(() => f.authentication.authenticate(f.request(), f.peer(100))).toThrow('Too many');
  replacement.releaseHandshake(); for (const grant of grants) grant.releaseHandshake();
  f.disable();
  expect(() => grants[0]!.validate()).toThrow('disabled');
  expect(() => f.authentication.authenticate(f.request(), f.peer(101))).toThrow('disabled');
});

test('failed credentials consume the bounded physical-peer rate window and forwarded addresses cannot evade it', async () => {
  const f = await fixture();
  for (let i = 0; i < MAX_NODE_CHANNEL_ATTEMPTS_PER_PEER_PER_MINUTE; i++) {
    const request = f.request('Bearer synthetic-invalid');
    request.headers.set('x-forwarded-for', `10.0.0.${i + 1}`);
    expect(() => f.authentication.authenticate(request, f.peer())).toThrow('authentication failed');
  }
  expect(() => f.authentication.authenticate(f.request(), f.peer())).toThrow('Too many');
  f.advance();
  const granted = f.authentication.authenticate(f.request(), f.peer());
  granted.validate(); granted.releaseHandshake();
});

test('bulk handshakes cannot consume session handshake capacity or its reconnect rate budget', async () => {
  const f = await fixture();
  const request = () => f.request(undefined, 'https://synthetic.invalid/ws/nodes/bulk');
  const bulk = Array.from({ length: MAX_NODE_CHANNEL_HANDSHAKES }, (_, i) => f.authentication.authenticate(request(), f.peer(i + 1)));
  expect(() => f.authentication.authenticate(request(), f.peer(99))).toThrow('Too many');
  const session = f.authentication.authenticate(f.request(), f.peer()); session.releaseHandshake();
  for (const grant of bulk) grant.releaseHandshake();
  for (let i = 1; i < MAX_NODE_CHANNEL_ATTEMPTS_PER_PEER_PER_MINUTE; i++) {
    f.authentication.authenticate(request(), f.peer()).releaseHandshake();
  }
  expect(() => f.authentication.authenticate(request(), f.peer())).toThrow('Too many');
  const next = f.authentication.authenticate(f.request(), f.peer()); next.releaseHandshake();
  next.validate();
});

test('two socket kinds bound aggregate concurrent handshakes to twice the per-kind limit', async () => {
  const f = await fixture();
  const grants = [];
  for (const pathname of ['/ws/nodes', '/ws/nodes/bulk']) {
    const request = () => f.request(undefined, `https://synthetic.invalid${pathname}`);
    for (let i = 0; i < MAX_NODE_CHANNEL_HANDSHAKES; i++) grants.push(f.authentication.authenticate(request(), f.peer(i + 1)));
    expect(() => f.authentication.authenticate(request(), f.peer(99))).toThrow('Too many');
  }
  expect(grants).toHaveLength(MAX_NODE_CHANNEL_HANDSHAKES * 2);
  for (const grant of grants) grant.releaseHandshake();
});
