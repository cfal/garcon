import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { controllerTlsOptions } from '../../../common/controller-tls.js';
import type { ControllerTlsTrust } from '../../../common/controller-tls.js';
import { createNodeBulkSocket, createNodeControllerSocket } from '../../../server/execution-node/controller-socket.js';
import { createNodeClientSocket, type NodeClientSocket } from '../../../server/execution-nodes/transport/bun-sockets.js';
import { serializeNodeLeaseFrame } from '../../../server/execution-nodes/transport/lease-wire.js';
import { serializeNodeBulkSessionFrame } from '../../../server/execution-nodes/transport/bulk-session-wire.js';
import { parseNodeBulkFrameText, serializeNodeBulkFrame, type NodeBulkReply } from '../../../server/execution-nodes/transport/bulk-channel-wire.js';
import type { NodeBulkSessionDataFrame } from '../../../server/execution-nodes/transport/bulk-session-channel.js';
import { withTimeout } from '../../support/deferred.js';
import { createNodeSessionFixture, nodeSessionSystemdAvailable } from '../../support/node-session-handshake-fixture.js';
import { TlsCertificates, type TestCertificate } from '../../support/tls-certificates.js';

let certificates: TlsCertificates;
let leaf: TestCertificate; let root: TestCertificate; let issued: TestCertificate; let wrong: TestCertificate; let expired: TestCertificate;
beforeAll(async () => {
  certificates = await TlsCertificates.create();
  leaf = await certificates.selfSigned('session-leaf');
  root = await certificates.selfSigned('session-root', true);
  issued = await certificates.issued('session-issued', root);
  expired = await certificates.issued('session-expired', root, { expired: true });
  wrong = await certificates.selfSigned('session-wrong');
});
afterAll(async () => certificates?.dispose());

const fixture = (certificate: TestCertificate = leaf, trust: ControllerTlsTrust = certificate.trust) => createNodeSessionFixture(certificate, trust);

describe.skipIf(!nodeSessionSystemdAvailable)('authenticated session handshake over WSS', () => {
  test('scoped self-signed trust covers real worker startup, reconnect and controller-boot replacement', async () => {
    const f = await fixture();
    try {
      const first = f.connect(); const initial = await first.ready;
      expect((await f.accepted.at(-1)!.ready).manifests[0]?.instanceId).toBe('synthetic-instance');
      const identity = (await f.marker.read())!.identity;
      expect(() => f.coordinator.supervisor.assertAdmission(initial.lease)).toThrow();
      first.stop(); await first.closed;
      expect(initial.lease.authoritySignal.aborted).toBe(false);
      const second = f.connect(); const reattached = await second.ready;
      await f.accepted.at(-1)!.ready;
      expect(reattached.lease.session).toEqual(initial.lease.session);
      expect(reattached.connectionId).toBe(2);
      expect((await f.marker.read())!.identity).toEqual(identity);
      expect(f.processes.size).toBe(1);
      second.stop(); await second.closed;
      f.restartController();
      const third = f.connect(); const fresh = await third.ready;
      await f.accepted.at(-1)!.ready;
      expect(fresh.lease.session.logicalSessionId).not.toBe(initial.lease.session.logicalSessionId);
      expect(initial.lease.authoritySignal.aborted).toBe(true);
      expect(f.processes.size).toBe(2);
      expect(f.upgrades()).toBe(3);
    } finally { await f.dispose(); }
  }, 30_000);

  test('accepts a private CA while revocation closes an established channel and refuses fresh upgrades', async () => {
    const f = await fixture(issued, root.trust);
    try {
      const first = f.connect(); const connection = await first.ready; await f.accepted.at(-1)!.ready;
      await f.pairings.revoke(f.pairing.nodeId);
      first.socket.send(serializeNodeLeaseFrame({ type: 'node-lease-challenge', version: 1,
        session: connection.lease.session, challengeId: 'synthetic-revalidation' }));
      await first.closed;
      expect(connection.lease.signal.aborted).toBe(true);
      expect(connection.lease.authoritySignal.aborted).toBe(false);
      await expect(f.connect().ready).rejects.toThrow();
      expect(f.upgrades()).toBe(1);
      expect(f.processes.size).toBe(1);
    } finally { await f.dispose(); }
  }, 15_000);

  test('untrusted roots, hostname mismatch and expired certificates reach no authenticated HTTP request', async () => {
    for (const [certificate, trust, host] of [[leaf, wrong.trust, '127.0.0.1'], [leaf, { kind: 'system-ca' }, '127.0.0.1'],
      [leaf, leaf.trust, '127.0.0.2'], [expired, root.trust, '127.0.0.1']] as const) {
      const f = await fixture(certificate, trust);
      try {
        await expect(f.connect({ ...f.pairing, controllerUrl: f.pairing.controllerUrl.replace('127.0.0.1', host) }).ready).rejects.toThrow();
        expect(f.requests()).toBe(0); expect(f.upgrades()).toBe(0); expect(f.processes.size).toBe(0);
      } finally { await f.dispose(); }
    }
  }, 20_000);

  test('browser JWT and local bearer capability never reach node handshake dispatch', async () => {
    const f = await fixture();
    try {
      for (const credential of ['synthetic-browser-jwt', 'synthetic-local-capability']) {
        for (const pathname of ['/ws/nodes', '/ws/nodes/bulk']) {
          const url = new URL(f.pairing.controllerUrl); url.protocol = 'wss:'; url.pathname = pathname;
          const socket = createNodeClientSocket(url, { tls: controllerTlsOptions(f.pairing.trust), headers: { Authorization: `Bearer ${credential}` } });
          await rejectedSocket(socket);
        }
      }
      expect(f.requests()).toBe(4); expect(f.upgrades()).toBe(0); expect(f.bulkUpgrades()).toBe(0); expect(f.accepted).toHaveLength(0);
      expect(f.processes.size).toBe(0);
    } finally { await f.dispose(); }
  });

  test('bulk authentication requires the exact control binding and a bulk failure leaves control usable', async () => {
    const f = await fixture();
    try {
      const first = f.connect(); const connection = await first.ready;
      const controller = await f.controller(connection); const bulk = await controller.bulk;
      const foreign = await f.pairAnotherNode();
      for (const { pairing, ...binding } of [
        { pairing: f.pairing, session: { ...connection.lease.session, logicalSessionId: 'synthetic-foreign' }, connectionId: connection.connectionId },
        { pairing: f.pairing, session: connection.lease.session, connectionId: connection.connectionId + 1 },
        { pairing: foreign, session: connection.lease.session, connectionId: connection.connectionId },
      ]) {
        const socket = createNodeBulkSocket(pairing);
        const closed = Promise.withResolvers<void>();
        socket.addEventListener('open', () => socket.send(serializeNodeBulkSessionFrame({ type: 'node-bulk-session-hello', version: 1,
          ...binding, bulkAttemptId: '999' })));
        socket.addEventListener('message', () => closed.reject(new Error('Synthetic invalid bulk binding was accepted')));
        socket.addEventListener('close', () => closed.resolve());
        socket.addEventListener('error', () => closed.reject(new Error('Synthetic bulk upgrade failed before binding validation')));
        try { await withTimeout(closed.promise, 5000, () => 'Synthetic invalid bulk binding did not close'); }
        finally { socket.terminate(); }
      }
      const transfer = { ...connection.lease.session, transferId: 'synthetic-surviving-bulk' };
      const survived = Promise.withResolvers<NodeBulkReply>();
      const observe = (frame: NodeBulkSessionDataFrame) => {
        const reply = parseNodeBulkFrameText(frame.payload);
        if (reply?.type === 'node-bulk-result' && reply.requestId === 1) survived.resolve(reply);
      };
      controller.bulkReceived.add(observe);
      try {
        expect(bulk.send({ type: 'node-worker-bulk', version: 1, session: connection.lease.session,
          connectionId: connection.connectionId, instanceId: 'synthetic-instance',
          payload: serializeNodeBulkFrame({ type: 'node-bulk-cancel', version: 1, transfer, requestId: 1 }) })).toBe(true);
        expect(await withTimeout(survived.promise, 5000, () => 'Synthetic original bulk channel did not survive foreign capture'))
          .toMatchObject({ session: connection.lease.session, result: 'cancelled' });
      } finally { controller.bulkReceived.delete(observe); }
      bulk.close();
      expect(controller.signal.aborted).toBe(false);
      expect(connection.lease.authoritySignal.aborted).toBe(false);
      expect((await controller.client.service.call({ method: 'begin-output-recovery' }, controller.signal)).kind).toBe('output-recovery');
      first.stop(); await first.closed;
      const next = f.connect(); const replacement = await next.ready;
      const nextController = await f.controller(replacement);
      await nextController.bulk;
      expect(replacement.lease.session).toEqual(connection.lease.session);
      expect(replacement.connectionId).toBe(connection.connectionId + 1);
      expect(f.processes.size).toBe(1);
    } finally { await f.dispose(); }
  }, 15_000);

  test('bulk replacement retires the captured attempt while preserving control and worker ownership', async () => {
    const f = await fixture();
    try {
      const node = f.connect(); const connection = await node.ready;
      const controller = await f.controller(connection); const original = await controller.bulk;
      const originalBinding = await original.ready;
      const replacement = await withTimeout(node.replaceBulk(), 5000, () => 'Synthetic replacement bulk connection did not become ready');
      const nodeBinding = await replacement.ready;
      const current = controller.currentBulk!; const binding = await current.ready;
      expect(current).not.toBe(original);
      expect(binding.bulkAttemptId).not.toBe(originalBinding.bulkAttemptId);
      expect(nodeBinding.bulkAttemptId).toBe(binding.bulkAttemptId);
      expect(binding.session).toEqual(originalBinding.session);
      expect(binding.connectionId).toBe(originalBinding.connectionId);
      expect(originalBinding.signal.aborted).toBe(true);
      expect(binding.signal.aborted).toBe(false);
      expect(controller.signal.aborted).toBe(false);
      expect(connection.lease.authoritySignal.aborted).toBe(false);
      expect(f.processes.size).toBe(1); expect(f.upgrades()).toBe(1); expect(f.bulkUpgrades()).toBe(2);

      const transfer = { ...binding.session, transferId: 'synthetic-replacement-transfer' };
      const request: NodeBulkSessionDataFrame = { type: 'node-worker-bulk', version: 1, session: binding.session,
        connectionId: binding.connectionId, instanceId: 'synthetic-instance',
        payload: serializeNodeBulkFrame({ type: 'node-bulk-cancel', version: 1, transfer, requestId: 1 }) };
      expect(() => original.send(request)).toThrow();
      const result = Promise.withResolvers<NodeBulkReply>();
      const observe = (frame: NodeBulkSessionDataFrame) => {
        const reply = parseNodeBulkFrameText(frame.payload);
        if (reply?.type === 'node-bulk-result' && reply.requestId === 1) result.resolve(reply);
      };
      controller.bulkReceived.add(observe);
      try {
        expect(current.send(request)).toBe(true);
        expect(await withTimeout(result.promise, 5000, () => 'Synthetic replacement bulk transfer did not complete'))
          .toMatchObject({ session: binding.session, result: 'cancelled' });
      } finally { controller.bulkReceived.delete(observe); }
      expect((await controller.client.service.call({ method: 'begin-output-recovery' }, controller.signal)).kind).toBe('output-recovery');
      current.close();
      expect(binding.signal.aborted).toBe(true);
      expect(controller.signal.aborted).toBe(false);
    } finally { await f.dispose(); }
  }, 15_000);

  test('an authenticated upgrade redirect cannot forward node credentials to another origin', async () => {
    let redirectedRequests = 0;
    const target = Bun.serve({ hostname: '0.0.0.0', port: 0, tls: { cert: leaf.cert, key: leaf.key },
      fetch() { redirectedRequests++; return new Response(null, { status: 400 }); } });
    const redirect = Bun.serve({ hostname: '0.0.0.0', port: 0, tls: { cert: leaf.cert, key: leaf.key },
      fetch() { return Response.redirect(`https://127.0.0.1:${target.port}/ws/nodes`); } });
    try {
      const socket = createNodeControllerSocket({ version: 1, controllerId: 'synthetic-controller', nodeId: 'synthetic-node',
        controllerUrl: `https://127.0.0.1:${redirect.port}`, trust: leaf.trust, credential: `node.synthetic-node.${'A'.repeat(43)}` });
      await rejectedSocket(socket);
      expect(redirectedRequests).toBe(0);
    } finally { await redirect.stop(true); await target.stop(true); }
  });
});

function rejectedSocket(socket: NodeClientSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.terminate(); reject(new Error('Synthetic socket did not reject')); }, 5000);
    socket.addEventListener('error', () => { clearTimeout(timer); socket.terminate(); resolve(); }, { once: true });
    socket.addEventListener('close', () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener('open', () => { clearTimeout(timer); socket.terminate(); reject(new Error('Synthetic unexpected upgrade')); }, { once: true });
  });
}
