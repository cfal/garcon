import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { NODE_ENROLLMENT_TTL_MS, parseNodeEnrollmentResponse } from '../../../common/execution-node-config.js';
import { AtomicJsonWriteError, writeJsonFileAtomic } from '../../lib/json-file-store.js';
import { MAX_PAIRED_NODE_IDENTITIES, MAX_PENDING_NODE_ENROLLMENTS, NodePairingStore } from '../pairing-store.js';

const directories = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function fixture(options = {}) {
  const directory = await mkdtemp(join(homedir(), 'garcon-pairing-test-'));
  directories.push(directory);
  let now = Date.parse('2026-09-10T12:00:00.000Z');
  const store = new NodePairingStore(directory, { now: () => now, ...options });
  await store.init();
  const file = join(directory, 'execution-node-pairing.json');
  return {
    directory, store, file, advance: (ms) => { now += ms; },
    read: async () => JSON.parse(await readFile(file, 'utf8')),
    restart: async () => {
      const restarted = new NodePairingStore(directory, { now: () => now });
      await restarted.init();
      return restarted;
    },
  };
}

function request(issued) {
  return { version: issued.version, controllerId: issued.controllerId, nodeId: issued.nodeId, token: issued.token };
}

describe('node pairing credential authority', () => {
  test('persists one private workspace identity without creating resources or retaining plaintext credentials', async () => {
    const f = await fixture();
    const enrollment = await f.store.issueEnrollment('node-one');
    expect(enrollment.expiresAt).toBe('2026-09-10T12:10:00.000Z');
    expect(Buffer.from(enrollment.token.split('.')[2], 'base64url')).toHaveLength(32);
    expect((await f.read()).enrollments[0].verifier).toBe(createHash('sha256').update(enrollment.token).digest('hex'));
    expect(await readFile(f.file, 'utf8')).not.toContain(enrollment.token);
    const paired = await f.store.enroll(request(enrollment));
    expect(parseNodeEnrollmentResponse(paired)).toEqual(paired);
    expect(Buffer.from(paired.credential.split('.')[2], 'base64url')).toHaveLength(32);
    expect(f.store.authenticate(paired.credential)).toEqual({ controllerId: enrollment.controllerId, nodeId: 'node-one' });
    expect(await f.read()).toEqual({
      version: 1, controllerId: f.store.controllerId,
      nodes: [{ nodeId: 'node-one', verifier: createHash('sha256').update(paired.credential).digest('hex') }], enrollments: [],
    });
    expect(await readFile(f.file, 'utf8')).not.toContain(paired.credential);
    expect((await stat(f.file)).mode & 0o777).toBe(0o600);
    const restarted = await f.restart();
    expect(restarted.controllerId).toBe(f.store.controllerId);
    expect(restarted.authenticate(paired.credential)).toEqual(f.store.authenticate(paired.credential));
    await expect(restarted.enroll(request(enrollment))).rejects.toMatchObject({ code: 'NODE_ENROLLMENT_INVALID' });
  });

  test('consumes an enrollment exactly once across concurrent exchanges and a lost reply', async () => {
    const f = await fixture();
    const enrollment = await f.store.issueEnrollment('node-one');
    const results = await Promise.allSettled([f.store.enroll(request(enrollment)), f.store.enroll(request(enrollment))]);
    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    const paired = results.find((result) => result.status === 'fulfilled').value;
    expect(results.find((result) => result.status === 'rejected').reason.code).toBe('NODE_ENROLLMENT_INVALID');
    const restarted = await f.restart();
    await expect(restarted.enroll(request(enrollment))).rejects.toMatchObject({ code: 'NODE_ENROLLMENT_INVALID' });
    await expect(restarted.issueEnrollment('node-one')).rejects.toMatchObject({ code: 'NODE_ALREADY_PAIRED' });
    await restarted.revoke('node-one');
    const replacement = await restarted.enroll(request(await restarted.issueEnrollment('node-one')));
    expect(restarted.authenticate(paired.credential)).toBeNull();
    expect(restarted.authenticate(replacement.credential)?.nodeId).toBe('node-one');
  });

  test('rejects expired or wrong-namespace tokens without consuming a valid token', async () => {
    const f = await fixture();
    const issued = await f.store.issueEnrollment('node-one');
    await expect(f.store.enroll({ ...request(issued), controllerId: 'other-controller' }))
      .rejects.toMatchObject({ code: 'NODE_ENROLLMENT_INVALID' });
    await expect(f.store.enroll({ ...request(issued), nodeId: 'other-node' }))
      .rejects.toMatchObject({ code: 'NODE_ENROLLMENT_INVALID' });
    await expect(f.store.enroll({ ...request(issued), token: issued.token.slice(0, -43) + 'A'.repeat(43) }))
      .rejects.toMatchObject({ code: 'NODE_ENROLLMENT_INVALID' });
    f.advance(NODE_ENROLLMENT_TTL_MS);
    await expect(f.store.enroll(request(issued))).rejects.toMatchObject({ code: 'NODE_ENROLLMENT_EXPIRED' });
    const fresh = await f.store.issueEnrollment('node-one');
    f.advance(NODE_ENROLLMENT_TTL_MS - 1);
    expect((await f.store.enroll(request(fresh))).nodeId).toBe('node-one');
  });

  test('reissuing or revoking a pending enrollment invalidates only that node token', async () => {
    const f = await fixture();
    const old = await f.store.issueEnrollment('node-one');
    const other = await f.store.issueEnrollment('node-two');
    const fresh = await f.store.issueEnrollment('node-one');
    await expect(f.store.enroll(request(old))).rejects.toMatchObject({ code: 'NODE_ENROLLMENT_INVALID' });
    await f.store.revoke('node-one');
    await f.store.revoke('node-one');
    await expect(f.store.enroll(request(fresh))).rejects.toMatchObject({ code: 'NODE_ENROLLMENT_INVALID' });
    expect((await f.store.enroll(request(other))).nodeId).toBe('node-two');
    expect((await f.read()).nodes.map((node) => node.nodeId)).toEqual(['node-two']);
  });

  test('does not accept an enrollment, browser JWT, changed secret, or another node as a credential', async () => {
    const f = await fixture();
    const issued = await f.store.issueEnrollment('node-one');
    const first = await f.store.enroll(request(issued));
    const second = await f.store.enroll(request(await f.store.issueEnrollment('node-two')));
    for (const credential of ['', 'browser.jwt.token', issued.token, first.credential + '.extra',
      first.credential.replace('node-one', 'node-two'), first.credential.slice(0, -43) + 'A'.repeat(43)]) {
      expect(f.store.authenticate(credential)).toBeNull();
    }
    await f.store.revoke('node-one');
    const restarted = await f.restart();
    expect(restarted.authenticate(first.credential)).toBeNull();
    expect(restarted.authenticate(second.credential)?.nodeId).toBe('node-two');
    const anotherWorkspace = await fixture();
    expect(anotherWorkspace.store.authenticate(second.credential)).toBeNull();
  });

  test('snapshots an exchange before waiting for the persistence lock', async () => {
    let hold = false;
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    const f = await fixture({ write: async (...args) => {
      if (hold) { entered.resolve(); await release.promise; }
      await writeJsonFileAtomic(...args);
    } });
    const issued = await f.store.issueEnrollment('node-one');
    hold = true;
    const other = f.store.issueEnrollment('node-two');
    await entered.promise;
    const input = request(issued);
    const pending = f.store.enroll(input);
    input.controllerId = 'changed-controller';
    input.token = 'changed-token';
    release.resolve();
    await other;
    expect((await pending).nodeId).toBe('node-one');
  });

  test('bounds active and pending credentials while releasing expired and revoked capacity', async () => {
    const f = await fixture();
    for (let index = 0; index < MAX_PENDING_NODE_ENROLLMENTS; index++) await f.store.issueEnrollment(`node-${index}`);
    await expect(f.store.issueEnrollment('next-node')).rejects.toMatchObject({ code: 'NODE_PAIRING_CAPACITY', status: 429, retryable: true });
    await expect(f.store.issueEnrollment('node-0')).resolves.toBeDefined();
    f.advance(NODE_ENROLLMENT_TTL_MS);
    await f.store.issueEnrollment('next-node');
    const saved = await f.read();
    expect(saved.enrollments).toHaveLength(1);
    expect(saved.nodes).toHaveLength(1);
    saved.nodes = Array.from({ length: MAX_PAIRED_NODE_IDENTITIES }, (_, index) => ({ nodeId: `node-${index}`, verifier: 'a'.repeat(64) }));
    saved.enrollments = [];
    await writeJsonFileAtomic(f.file, saved, { mode: 0o600 });
    const restarted = await f.restart();
    await expect(restarted.issueEnrollment('overflow-node')).rejects.toMatchObject({ code: 'NODE_PAIRING_CAPACITY', status: 409, retryable: false });
    await restarted.revoke('node-0');
    await expect(restarted.issueEnrollment('overflow-node')).resolves.toBeDefined();
    expect((await f.read()).nodes).toHaveLength(MAX_PAIRED_NODE_IDENTITIES);
  });

  test.each(['issue', 'enroll', 'revoke'])('preserves pre-rename state and fences post-rename uncertainty during %s', async (operation) => {
    let failure = null;
    const f = await fixture({ write: async (...args) => {
      if (failure === 'before') throw new AtomicJsonWriteError('Synthetic pre-rename failure', false);
      await writeJsonFileAtomic(...args);
      if (failure === 'after') throw new AtomicJsonWriteError('Synthetic directory-sync uncertainty', true);
    } });
    const issued = await f.store.issueEnrollment('node-one');
    const paired = operation === 'revoke' ? await f.store.enroll(request(issued)) : null;
    const act = () => operation === 'issue' ? f.store.issueEnrollment('node-two')
      : operation === 'enroll' ? f.store.enroll(request(issued)) : f.store.revoke('node-one');
    const before = await f.read();
    failure = 'before';
    await expect(act()).rejects.toThrow('Synthetic pre-rename failure');
    expect(await f.read()).toEqual(before);
    if (paired) expect(f.store.authenticate(paired.credential)).not.toBeNull();
    failure = 'after';
    await expect(act()).rejects.toThrow('Synthetic directory-sync uncertainty');
    const after = await f.read();
    expect(after).not.toEqual(before);
    expect(() => f.store.authenticate(paired?.credential ?? '')).toThrow('durability is unknown');
    await expect(f.store.issueEnrollment('another-node')).rejects.toMatchObject({ code: 'NODE_PAIRING_UNAVAILABLE' });
    const restarted = await f.restart();
    expect(restarted.controllerId).toBe(before.controllerId);
    if (operation === 'enroll') await expect(restarted.enroll(request(issued))).rejects.toMatchObject({ code: 'NODE_ENROLLMENT_INVALID' });
    if (paired) expect(restarted.authenticate(paired.credential)).toBeNull();
  });

  test.each(['success', 'before', 'after'])('fences authentication during revocation until %s settlement', async (outcome) => {
    let hold = false;
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    const f = await fixture({ write: async (...args) => {
      if (hold) {
        if (outcome !== 'before') await writeJsonFileAtomic(...args);
        entered.resolve();
        await release.promise;
        if (outcome !== 'success') throw new AtomicJsonWriteError('Synthetic write failure', outcome === 'after');
      } else await writeJsonFileAtomic(...args);
    } });
    const paired = await f.store.enroll(request(await f.store.issueEnrollment('node-one')));
    hold = true;
    const pending = f.store.revoke('node-one');
    const settled = pending.catch((error) => error);
    try {
      await entered.promise;
      expect(() => f.store.authenticate(paired.credential)).toThrow('in progress');
    } finally { release.resolve(); await settled; }
    if (outcome === 'after') expect(() => f.store.authenticate(paired.credential)).toThrow('durability is unknown');
    else expect(f.store.authenticate(paired.credential) !== null).toBe(outcome === 'before');
  });

  test('fails closed on corrupt and quarantined storage rather than replacing controller identity', async () => {
    for (const corrupt of [
      '{malformed', JSON.stringify({ version: 1, controllerId: 'controller', nodes: [], enrollments: [], credential: 'extra' }),
      JSON.stringify({ version: 1, controllerId: 'controller', nodes: [{ nodeId: 'node', verifier: 'invalid' }], enrollments: [] }),
      JSON.stringify({ version: 1, controllerId: 'controller', nodes: [], enrollments: [{
        id: 'token', nodeId: 'missing', verifier: 'a'.repeat(64), expiresAt: '2026-09-10T12:10:00.000Z',
      }] }),
    ]) {
      const f = await fixture();
      await writeFile(f.file, corrupt);
      await expect(f.restart()).rejects.toThrow('corrupt');
      await expect(f.restart()).rejects.toThrow('corrupt');
    }
  });
});
