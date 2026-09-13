import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createNodeSessionFixture, nodeSessionSystemdAvailable } from '../../support/node-session-handshake-fixture.js';
import { createNodeHistoryRecord, historyRowContent, recoverHistoryConnection, remoteHistoryImporter } from '../../support/node-history-fixture.js';
import { TlsCertificates, type TestCertificate } from '../../support/tls-certificates.js';
import { withTimeout } from '../../support/deferred.js';

let certificates: TlsCertificates;
let certificate: TestCertificate;
beforeAll(async () => { certificates = await TlsCertificates.create(); certificate = await certificates.selfSigned('history-lifetime'); });
afterAll(async () => certificates?.dispose());

function lifetimeGate() {
  const token = randomUUID();
  const stages = new Map(['advance', 'cleanup', 'aborted', 'released'].map((name) => [name, {
    entered: Promise.withResolvers<void>(), release: Promise.withResolvers<void>(),
  }]));
  const server = Bun.serve({ hostname: '0.0.0.0', port: 0, async fetch(request) {
    if (request.headers.get('authorization') !== `Bearer ${token}`) return new Response(null, { status: 401 });
    const name = new URL(request.url).pathname.slice(1);
    const stage = stages.get(name);
    if (!stage || request.method !== 'POST') return new Response(null, { status: 404 });
    stage.entered.resolve();
    if (name === 'advance' || name === 'cleanup') await stage.release.promise;
    return new Response(null, { status: 204 });
  } });
  return { address: `http://127.0.0.1:${server.port}`, token,
    entered: (name: string) => withTimeout(stages.get(name)!.entered.promise, 5000, () => `Synthetic history never reached ${name}`),
    release(name: string) { stages.get(name)!.release.resolve(); },
    async close() { for (const stage of stages.values()) stage.release.resolve(); await server.stop(true); },
  };
}

describe.skipIf(!nodeSessionSystemdAvailable)('native history lifetime through WSS and real workers', () => {
  test.each(['held-advance', 'encoding-cleanup', 'late-invalid'] as const)('%s preserves native occupancy through actual settlement', async (mode) => {
    const gate = lifetimeGate();
    const f = await createNodeSessionFixture(certificate, certificate.trust, {
      sessionCommand: [process.execPath, '--no-env-file', '--config=/dev/null',
        fileURLToPath(new URL('../../support/node-history-lifetime-worker.ts', import.meta.url)), 'session'],
      historyTransportMemoryBytes: 32 * 1024,
      instance: { agentId: 'direct-anthropic-compatible', environment: { GARCON_TEST_HISTORY_GATE: gate.address,
        GARCON_TEST_HISTORY_TOKEN: gate.token, GARCON_TEST_HISTORY_LIFETIME: mode } },
    }).catch(async (error: unknown) => { await gate.close(); throw error; });
    try {
      const controller = await f.controller(await f.connect().ready);
      await recoverHistoryConnection(controller);
      const record = await createNodeHistoryRecord(f);
      const source = await remoteHistoryImporter(f, controller, record.instanceId);
      const caller = new AbortController();
      let bulkRows = 0;
      f.controllerBulkFrames.add((frame) => { if (frame.type === 'node-history-bulk') bulkRows++; return true; });
      const iterator = source.read(record.request, caller.signal)[Symbol.asyncIterator]();
      const reading = iterator.next().catch((error: unknown) => error);
      if (mode === 'late-invalid') {
        expect(await reading).toMatchObject({ code: 'NODE_HISTORY_SOURCE_FAILED' });
      } else {
        await gate.entered(mode === 'held-advance' ? 'advance' : 'cleanup');
        const reason = new Error('Synthetic cancellation while native history remains occupied');
        caller.abort(reason);
        expect(await reading).toBe(reason);
        await gate.entered('aborted');
        await expect(source.read(record.request, new AbortController().signal)[Symbol.asyncIterator]().next())
          .rejects.toMatchObject({ code: 'NODE_CAPACITY' });
        expect(await controller.client.service.call({ method: 'provider-auth', instanceId: record.instanceId, operation: 'status' }, controller.signal))
          .toMatchObject({ kind: 'provider-auth-status' });
        if (mode === 'held-advance') {
          gate.release('advance');
          await gate.entered('cleanup');
          await expect(source.read(record.request, new AbortController().signal)[Symbol.asyncIterator]().next())
            .rejects.toMatchObject({ code: 'NODE_CAPACITY' });
        }
        gate.release('cleanup');
      }
      await gate.entered('released');
      expect(bulkRows).toBe(0);
      const rows: string[] = [];
      for await (const batch of source.read(record.request, new AbortController().signal)) rows.push(...batch.map(historyRowContent));
      expect(rows).toEqual([record.content, 'Synthetic response']);
      expect(controller.signal.aborted).toBe(false);
      expect(f.processes.size).toBe(1);
      expect(f.historyPool.reservedBytes).toBe(0);
    } finally {
      gate.release('advance'); gate.release('cleanup');
      try { await f.dispose(); } finally { await gate.close(); }
    }
  }, 30_000);
});
