import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { NodeEnrollmentBundle, NodeEnrollmentIssueRequest } from '../../../common/execution-node-config.js';
import { LOCAL_SERVER_PRINCIPAL, type ServerPrincipal } from '../../lib/http-route-types.js';
import { AtomicJsonWriteError, writeJsonFileAtomic } from '../../lib/json-file-store.js';
import { DomainError } from '../../lib/domain-error.js';
import { NodeEnrollmentService } from '../enrollment.js';
import { NodePairingStore } from '../pairing-store.js';
import type { ExecutionNodesStore } from '../store.js';

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

const account = (): Extract<ServerPrincipal, { mode: 'authenticated' }> => ({ mode: 'authenticated', key: 'synthetic', username: 'synthetic', expiresAtMs: Date.now() + 60_000 });
const issue = (): NodeEnrollmentIssueRequest => ({ nodeId: 'remote-node' });
const controller = (): Pick<NodeEnrollmentBundle, 'controllerUrl' | 'trust'> => ({ controllerUrl: 'https://controller.test', trust: { kind: 'system-ca' } });

async function fixture(write = writeJsonFileAtomic, connection = controller()) {
  const directory = await mkdtemp(join(homedir(), 'garcon-enrollment-test-'));
  directories.push(directory);
  let enabled = true;
  let removed = false;
  const pairings = new NodePairingStore(directory, { write });
  const nodes = { requireNode(nodeId: string) {
    if (removed) throw new DomainError('NODE_REMOVED', 'Node was removed', 409);
    if (!['remote-node', 'local-node'].includes(nodeId)) throw new DomainError('NODE_UNAVAILABLE', 'Unknown node', 409);
    return { id: nodeId, kind: nodeId === 'local-node' ? 'local' : 'remote', label: 'Synthetic', removedAt: null };
  } } satisfies Pick<ExecutionNodesStore, 'requireNode'>;
  const service = new NodeEnrollmentService({ pairings, nodes, controller: connection, isAdministrationEnabled: async () => enabled });
  return {
    service, pairings, nodes, file: join(directory, 'execution-node-pairing.json'),
    disable: () => { enabled = false; }, remove: () => { removed = true; },
  };
}

describe('node enrollment administration', () => {
  test('refuses unconfigured administration and non-account principals before any credential write', async () => {
    for (const principal of [null, LOCAL_SERVER_PRINCIPAL, { ...account(), expiresAtMs: 0 }, { ...account(), expiresAtMs: NaN }]) {
      const f = await fixture();
      await expect(f.service.issue(issue(), principal)).rejects.toMatchObject({ code: 'NODE_ADMIN_REQUIRED' });
      await expect(readFile(f.file)).rejects.toMatchObject({ code: 'ENOENT' });
    }
    const f = await fixture();
    f.disable();
    await expect(f.service.issue(issue(), account())).rejects.toMatchObject({ code: 'NODE_ADMIN_REQUIRED' });
    await expect(f.service.enroll({ version: 1, controllerId: 'controller', nodeId: 'remote-node', token: `enroll.token.${'A'.repeat(43)}` }))
      .rejects.toMatchObject({ code: 'NODE_ADMIN_REQUIRED' });
    await expect(readFile(f.file)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('rejects missing/local/removed nodes without issuing', async () => {
    const f = await fixture();
    await expect(f.service.issue({ ...issue(), nodeId: 'local-node' }, account())).rejects.toMatchObject({ code: 'NODE_ENROLLMENT_INVALID' });
    await expect(f.service.issue({ ...issue(), nodeId: 'missing-node' }, account())).rejects.toMatchObject({ code: 'NODE_UNAVAILABLE' });
    f.remove();
    await expect(f.service.issue(issue(), account())).rejects.toMatchObject({ code: 'NODE_REMOVED' });
    await expect(readFile(f.file)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('requires verified controller-owned configuration and rejects request overrides', async () => {
    await expect(fixture(writeJsonFileAtomic, { ...controller(), controllerUrl: 'http://controller.test' })).rejects.toThrow('HTTPS');
    await expect(fixture(writeJsonFileAtomic, { ...controller(), trust: {
      kind: 'trusted-pem', certificatesPem: ['-----BEGIN CERTIFICATE-----\nYWJj\n-----END CERTIFICATE-----\n'], certificateSha256: ['a'.repeat(64)],
    } })).rejects.toThrow();
    const connection = { ...controller() };
    const f = await fixture(writeJsonFileAtomic, connection);
    connection.controllerUrl = 'https://changed.test';
    for (const override of [{ controllerUrl: 'https://changed.test' }, { trust: { kind: 'system-ca' } }]) {
      await expect(f.service.issue({ ...issue(), ...override }, account())).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    }
    await expect(readFile(f.file)).rejects.toMatchObject({ code: 'ENOENT' });
    const bundle = await f.service.issue(issue(), account());
    expect(bundle).toMatchObject(controller());
    const changed = bundle.trust;
    Object.assign(changed, { kind: 'invalid' });
    expect(await f.service.issue(issue(), account())).toMatchObject(controller());
  });

  test('anonymous exchange conceals missing, local, removed, and unpaired remote targets', async () => {
    const f = await fixture();
    await f.pairings.init();
    const input = { version: 1 as const, controllerId: f.pairings.controllerId, token: `enroll.token.${'A'.repeat(43)}` };
    const expected = { code: 'NODE_ENROLLMENT_INVALID', status: 401, message: 'Invalid or already consumed node enrollment' };
    for (const nodeId of ['missing-node', 'local-node', 'remote-node']) {
      await expect(f.service.enroll({ ...input, nodeId })).rejects.toMatchObject(expected);
    }
    f.remove();
    await expect(f.service.enroll({ ...input, nodeId: 'remote-node' })).rejects.toMatchObject(expected);
    expect(JSON.parse(await readFile(f.file, 'utf8')).enrollments).toEqual([]);
  });

  test('exchanges once without account credentials and rejects disabled setup without consuming the token', async () => {
    const f = await fixture();
    const bundle = await f.service.issue(issue(), account());
    const request = { version: bundle.version, controllerId: bundle.controllerId, nodeId: bundle.nodeId, token: bundle.token };
    const paired = await f.service.enroll(request);
    expect(f.pairings.authenticate(paired.credential)?.nodeId).toBe('remote-node');
    await expect(f.service.enroll(request)).rejects.toMatchObject({ code: 'NODE_ENROLLMENT_INVALID' });
    await f.pairings.revoke('remote-node');
    const fresh = await f.service.issue(issue(), account());
    f.disable();
    await expect(f.service.enroll({ ...request, token: fresh.token })).rejects.toMatchObject({ code: 'NODE_ADMIN_REQUIRED' });
    expect((await f.pairings.enroll({ ...request, token: fresh.token })).nodeId).toBe('remote-node');
  });

  test.each(['remove', 'disable'] as const)('rechecks %s after credential initialization awaits', async (change) => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const f = await fixture(async (...args) => { entered.resolve(); await release.promise; await writeJsonFileAtomic(...args); });
    const pending = f.service.issue(issue(), account());
    await entered.promise;
    f[change]();
    release.resolve();
    await expect(pending).rejects.toMatchObject({ code: change === 'remove' ? 'NODE_REMOVED' : 'NODE_ADMIN_REQUIRED' });
    expect(JSON.parse(await readFile(f.file, 'utf8')).enrollments).toEqual([]);
  });

  for (const operation of ['issue', 'enroll'] as const) {
    test.each(['remove', 'disable', ...(operation === 'issue' ? ['expire' as const] : [])] as const)(
      `revokes the persisted candidate when %s changes during the final ${operation} write`, async (change) => {
        const written = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        let hold = false;
        const f = await fixture(async (...args) => {
          await writeJsonFileAtomic(...args);
          if (hold) { hold = false; written.resolve(); await release.promise; }
        });
        await f.pairings.init();
        const issued = await f.pairings.issueEnrollment('remote-node');
        const input = { version: issued.version, controllerId: issued.controllerId, nodeId: issued.nodeId, token: issued.token };
        const otherIssue = await f.pairings.issueEnrollment('other-node');
        const other = await f.pairings.enroll({ version: otherIssue.version, controllerId: otherIssue.controllerId,
          nodeId: otherIssue.nodeId, token: otherIssue.token });
        const now = Date.now();
        const clock = spyOn(Date, 'now').mockReturnValue(now);
        hold = true;
        const pending = operation === 'issue' ? f.service.issue(issue(), account()) : f.service.enroll(input);
        const result = pending.then(() => null, (error: unknown) => error);
        try {
          await written.promise;
          if (change === 'expire') clock.mockReturnValue(now + 60_001);
          else f[change]();
          release.resolve();
          expect(await result).toMatchObject({ code: 'NODE_PAIRING_UNAVAILABLE', retryable: false, status: 409,
            cause: expect.objectContaining({ code: change === 'remove' ? 'NODE_REMOVED' : 'NODE_ADMIN_REQUIRED' }) });
          const stored = JSON.parse(await readFile(f.file, 'utf8'));
          expect(stored.nodes.map((node: { nodeId: string }) => node.nodeId)).toEqual(['other-node']);
          expect(stored.enrollments).toEqual([]);
          expect(f.pairings.authenticate(other.credential)?.nodeId).toBe('other-node');
          await expect(f.pairings.enroll(input)).rejects.toMatchObject({ code: 'NODE_ENROLLMENT_INVALID' });
        } finally { release.resolve(); await result; clock.mockRestore(); }
      },
    );

    test.each(['remove', 'disable', ...(operation === 'issue' ? ['expire' as const] : [])] as const)(
      `rechecks %s after ${operation} waits for an initialized store's mutation lock`, async (change) => {
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        let hold = false;
        const f = await fixture(async (...args) => {
          if (hold) { hold = false; entered.resolve(); await release.promise; }
          await writeJsonFileAtomic(...args);
        });
        await f.pairings.init();
        const issued = await f.pairings.issueEnrollment('remote-node');
        const input = { version: issued.version, controllerId: issued.controllerId, nodeId: issued.nodeId, token: issued.token };
        let blocker: Promise<unknown> | undefined;
        let checks = 0;
        const requireNode = f.nodes.requireNode.bind(f.nodes);
        const check = spyOn(f.nodes, 'requireNode').mockImplementation((nodeId) => {
          const node = requireNode(nodeId);
          if (++checks === 2) { hold = true; blocker = f.pairings.issueEnrollment('other-node'); }
          return node;
        });
        const now = Date.now();
        const clock = spyOn(Date, 'now').mockReturnValue(now);
        try {
          const pending = operation === 'issue' ? f.service.issue(issue(), account()) : f.service.enroll(input);
          const result = pending.then(() => null, (error: unknown) => error);
          await entered.promise;
          if (change === 'expire') clock.mockReturnValue(now + 60_001);
          else f[change]();
          release.resolve();
          await blocker;
          expect(await result).toMatchObject({ code: change === 'remove'
            ? operation === 'enroll' ? 'NODE_ENROLLMENT_INVALID' : 'NODE_REMOVED' : 'NODE_ADMIN_REQUIRED' });
          const stored = JSON.parse(await readFile(f.file, 'utf8'));
          expect(stored.enrollments.find((entry: { nodeId: string }) => entry.nodeId === 'remote-node')?.verifier).toBeDefined();
          expect(stored.nodes.find((entry: { nodeId: string }) => entry.nodeId === 'remote-node')?.verifier).toBeNull();
        } finally { release.resolve(); check.mockRestore(); clock.mockRestore(); }
      },
    );
  }

  test('retains authorization loss and failed credential cleanup with a durability fence', async () => {
    const written = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let phase: 'normal' | 'hold' | 'cleanup' = 'normal';
    const f = await fixture(async (...args) => {
      if (phase === 'cleanup') throw new AtomicJsonWriteError('Synthetic cleanup failure', false);
      await writeJsonFileAtomic(...args);
      if (phase === 'hold') { phase = 'cleanup'; written.resolve(); await release.promise; }
    });
    await f.pairings.init();
    phase = 'hold';
    const result = f.service.issue(issue(), account()).catch((error: unknown) => error);
    try {
      await written.promise;
      f.disable();
      release.resolve();
      const error = await result;
      expect(error).toMatchObject({ code: 'NODE_PAIRING_UNAVAILABLE', retryable: false, status: 503 });
      if (!(error instanceof Error) || !(error.cause instanceof AggregateError)) throw new Error('Expected authorization and cleanup errors');
      expect(error.cause.errors).toEqual([
        expect.objectContaining({ code: 'NODE_ADMIN_REQUIRED' }),
        expect.objectContaining({ message: 'Synthetic cleanup failure' }),
      ]);
      expect(() => f.pairings.authenticate('')).toThrow('durability is unknown');
      await expect(f.pairings.issueEnrollment('other-node')).rejects.toMatchObject({ code: 'NODE_PAIRING_UNAVAILABLE' });
    } finally { release.resolve(); await result; }
  });

  test('snapshots the requested node and account before initialization yields', async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const f = await fixture(async (...args) => { entered.resolve(); await release.promise; await writeJsonFileAtomic(...args); });
    const request = { ...issue() };
    const principal = account();
    const pending = f.service.issue(request, principal);
    await entered.promise;
    request.nodeId = 'local-node';
    principal.expiresAtMs = 0;
    release.resolve();
    expect(await pending).toMatchObject(issue());
  });
});
