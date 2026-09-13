import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { AgentImportedTranscriptRow } from '../../../server-agents/interface/src/index.js';
import { UserMessage } from '../../../common/chat-types.js';
import type { RemoteProviderHistoryImportService } from '../../../server/execution-nodes/remote-provider-history-import.js';
import type { ProviderHistoryImportRequest } from '../../../server/execution-nodes/provider-history-import.js';
import { parseNodeBulkFrameText } from '../../../server/execution-nodes/transport/bulk-channel-wire.js';
import { NodeHistoryReceiverPool } from '../../../server/execution-nodes/transport/provider-history-receiver-pool.js';
import { createNodeSessionFixture, nodeSessionSystemdAvailable } from '../../support/node-session-handshake-fixture.js';
import { TlsCertificates, type TestCertificate } from '../../support/tls-certificates.js';
import { createNodeHistoryRecord, historyRowContent, remoteHistoryImporter as importer, recoverHistoryConnection as recover, type NodeHistoryFixture } from '../../support/node-history-fixture.js';

let certificates: TlsCertificates; let certificate: TestCertificate;
beforeAll(async () => { certificates = await TlsCertificates.create(); certificate = await certificates.selfSigned('history-import'); });
afterAll(async () => certificates?.dispose());
const agentId = 'direct-anthropic-compatible';
const nativeRecord = (f: NodeHistoryFixture, instanceId?: string, content?: string) => createNodeHistoryRecord(f, { instanceId, content });

describe.skipIf(!nodeSessionSystemdAvailable)('native history through WSS and both production worker hops', () => {
  test('an immediate history import waits for the node to install its physical bulk attempt', async () => {
    const attaching = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
    const f = await createNodeSessionFixture(certificate, certificate.trust, {
      beforeBulkAttachment: () => { attaching.resolve(); return release.promise; },
    });
    try {
      const controller = await f.controller(await f.connect().ready); await recover(controller);
      const record = await nativeRecord(f);
      await attaching.promise;
      let settled = false; let available = false;
      const reading = importer(f, controller, record.instanceId).then((source) => { available = true; return collect(source, record.request); })
        .then((rows) => { settled = true; return rows; }, (error: unknown) => { settled = true; throw error; });
      void reading.catch(() => {});
      expect(await controller.client.service.call({ method: 'provider-auth', instanceId: record.instanceId, operation: 'status' }, controller.signal))
        .toMatchObject({ kind: 'provider-auth-status' });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(available).toBe(false); expect(settled).toBe(false);
      release.resolve();
      expect((await reading).map(historyRowContent)).toEqual([record.content, 'Synthetic response']);
      expect(controller.signal.aborted).toBe(false); expect(f.historyPool.reservedBytes).toBe(0);
    } finally { release.resolve(); await f.dispose(); }
  }, 30_000);

  test('replacement during held installation fences the old attempt before its callback resumes', async () => {
    const attaching = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>(); let attempts = 0;
    const f = await createNodeSessionFixture(certificate, certificate.trust, {
      async beforeBulkAttachment() { if (++attempts === 1) { attaching.resolve(); await release.promise; } },
    });
    try {
      const node = f.connect(); const controller = await f.controller(await node.ready); await recover(controller);
      const record = await nativeRecord(f); await attaching.promise;
      const old = controller.historyConnection().catch((error: unknown) => error);
      await node.replaceBulk(); expect(await old).toBeInstanceOf(Error);
      release.resolve();
      const source = await importer(f, controller, record.instanceId);
      expect((await collect(source, record.request)).map(historyRowContent)).toEqual([record.content, 'Synthetic response']);
      expect(controller.signal.aborted).toBe(false); expect(f.processes.size).toBe(1);
    } finally { release.resolve(); await f.dispose(); }
  }, 30_000);

  test('large rows use credited reverse bulk and colliding native IDs remain instance-qualified', async () => {
    const root = await mkdtemp(path.join(homedir(), 'garcon-history-profiles-'));
    const profiles = ['first', 'second'].map((id) => ({ id: `synthetic-${id}`, agentId, label: id, homeDirectory: path.join(root, id),
      environment: {}, workspaceIds: ['synthetic-workspace'], maxOperations: 1 }));
    const f = await createNodeSessionFixture(certificate, certificate.trust, { instances: profiles });
    try {
      const controller = await f.controller(await f.connect().ready); await recover(controller);
      const first = await nativeRecord(f, profiles[0]!.id, 'Synthetic first '.repeat(25_000));
      const second = await nativeRecord(f, profiles[1]!.id, 'Synthetic second');
      let chunks = 0;
      f.controllerBulkFrames.add((frame) => {
        if (frame.type === 'node-history-bulk' && parseNodeBulkFrameText(frame.payload)?.type === 'node-bulk-credit-chunk') chunks++;
        return true;
      });
      const rows = await Promise.all([first, second].map(async (record) => collect(await importer(f, controller, record.instanceId), record.request)));
      expect(rows[0]![0]!.message).toBeInstanceOf(UserMessage);
      expect(rows[0]!.map(historyRowContent)).toEqual([first.content, 'Synthetic response']);
      expect(rows[1]!.map(historyRowContent)).toEqual([second.content, 'Synthetic response']);
      expect(chunks).toBeGreaterThan(4); expect(f.historyPool.reservedBytes).toBe(0);
      expect(controller.signal.aborted).toBe(false);
    } finally { await f.dispose(); await rm(root, { recursive: true, force: true }); }
  }, 30_000);

  test.each(['opened', 'row', 'transferred', 'eof'] as const)('a lost %s service reply never reports successful import', async (operation) => {
    const f = await createNodeSessionFixture(certificate);
    try {
      const controller = await f.controller(await f.connect().ready); await recover(controller);
      const record = await nativeRecord(f); const source = await importer(f, controller, record.instanceId);
      const dropped = Promise.withResolvers<void>(); const caller = new AbortController();
      f.controllerFrames.add((frame) => {
        if (frame.type === 'node-worker-service-result' && frame.result.kind === 'provider-history-result' && frame.result.operation === operation) {
          dropped.resolve(); return false;
        }
        return true;
      });
      let yielded = false;
      const iterator = source.read(record.request, caller.signal)[Symbol.asyncIterator]();
      if (operation === 'eof') {
        expect((await iterator.next()).value).toHaveLength(1);
        expect((await iterator.next()).value).toHaveLength(1);
      }
      const reading = iterator.next().then(() => { yielded = true; }, (error: unknown) => error);
      await dropped.promise; expect(yielded).toBe(false);
      if (operation === 'transferred') expect(f.historyPool.reservedBytes).toBeGreaterThan(0);
      const reason = new Error('Synthetic lost history reply'); caller.abort(reason);
      expect(await reading).toBe(reason); expect(yielded).toBe(false); expect(f.historyPool.reservedBytes).toBe(0);
      expect(await controller.client.service.call({ method: 'provider-auth', instanceId: record.instanceId, operation: 'status' }, controller.signal))
        .toMatchObject({ kind: 'provider-auth-status' });
    } finally { await f.dispose(); }
  }, 30_000);

  test('saturated bulk admission loses one row without starving control or retiring the worker', async () => {
    const f = await createNodeSessionFixture(certificate);
    let pressure: ReturnType<typeof f.holdBulkSocketAdmission> | null = null;
    try {
      const controller = await f.controller(await f.connect().ready); await recover(controller);
      const record = await nativeRecord(f); const source = await importer(f, controller, record.instanceId);
      const binding = await controller.historyConnection();
      pressure = f.holdBulkSocketAdmission();
      let received = 0;
      f.controllerBulkFrames.add((frame) => { if (frame.type === 'node-history-bulk') received++; return true; });
      const reading = collect(source, record.request).catch((error: unknown) => error);
      await pressure.refused;
      expect(received).toBe(0);
      expect(await controller.client.service.call({ method: 'provider-auth', instanceId: record.instanceId, operation: 'status' }, controller.signal))
        .toMatchObject({ kind: 'provider-auth-status' });
      pressure.release();
      expect(await reading).toMatchObject({ code: 'NODE_HISTORY_UNAVAILABLE' });
      expect(binding.signal.aborted).toBe(false); expect(controller.signal.aborted).toBe(false);
      expect(f.processes.size).toBe(1); expect(f.historyPool.reservedBytes).toBe(0);
      expect((await collect(source, record.request)).map(historyRowContent)).toEqual([record.content, 'Synthetic response']);
    } finally { pressure?.release(); await f.dispose(); }
  }, 30_000);

  test.each(['node-bulk-credit-chunk', 'node-bulk-chunk-ack', 'node-bulk-complete', 'node-bulk-result'] as const)
  ('a lost %s bulk boundary never yields a row and cancellation preserves the connection', async (lost) => {
    const f = await createNodeSessionFixture(certificate);
    try {
      const controller = await f.controller(await f.connect().ready); await recover(controller);
      const record = await nativeRecord(f); const source = await importer(f, controller, record.instanceId);
      const dropped = Promise.withResolvers<void>(); const caller = new AbortController();
      const interception = lost === 'node-bulk-chunk-ack' || lost === 'node-bulk-result' ? f.nodeBulkFrames : f.controllerBulkFrames;
      const intercept: Parameters<typeof interception.add>[0] = (frame) => {
        if (frame.type !== 'node-history-bulk') return true;
        const payload = parseNodeBulkFrameText(frame.payload)!;
        if (payload.type !== lost || payload.type === 'node-bulk-result' && payload.command !== 'node-bulk-complete') return true;
        dropped.resolve(); return false;
      };
      interception.add(intercept);
      let yielded = false;
      const iterator = source.read(record.request, caller.signal)[Symbol.asyncIterator]();
      const reading = iterator.next().then(() => { yielded = true; }, (error: unknown) => error);
      await dropped.promise; expect(yielded).toBe(false);
      const reason = new Error('Synthetic missing bulk frame'); caller.abort(reason);
      expect(await reading).toBe(reason); expect(yielded).toBe(false);
      expect(f.historyPool.reservedBytes).toBe(0); expect(controller.signal.aborted).toBe(false);
      interception.delete(intercept);
      expect((await collect(source, record.request)).map(historyRowContent)).toEqual([record.content, 'Synthetic response']);
      expect(f.processes.size).toBe(1);
    } finally { await f.dispose(); }
  }, 30_000);

  test('two real instance workers receive shares of the node budget rather than its full amount', async () => {
    const root = await mkdtemp(path.join(homedir(), 'garcon-history-quotas-'));
    const profiles = ['first', 'second'].map((id) => ({ id: `synthetic-${id}`, agentId, label: id, homeDirectory: path.join(root, id),
      environment: {}, workspaceIds: ['synthetic-workspace'], maxOperations: 1 }));
    try {
      for (const count of [1, 2]) {
        const f = await createNodeSessionFixture(certificate, certificate.trust, { instances: profiles.slice(0, count), historyTransportMemoryBytes: 32 * 1024 });
        try {
          const controller = await f.controller(await f.connect().ready); await recover(controller);
          for (const profile of profiles.slice(0, count)) {
            const record = await nativeRecord(f, profile.id, 'Synthetic '.repeat(250));
            const reading = collect(await importer(f, controller, profile.id), record.request);
            if (count === 1) expect((await reading).map(historyRowContent)).toEqual([record.content, 'Synthetic response']);
            else await expect(reading).rejects.toMatchObject({ code: 'NODE_CAPACITY' });
          }
          expect(f.historyPool.reservedBytes).toBe(0); expect(controller.signal.aborted).toBe(false);
        } finally { await f.dispose(); }
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 30_000);

  test('bulk-only replacement fails the old cursor while a fresh explicit import reads from the beginning', async () => {
    const f = await createNodeSessionFixture(certificate);
    try {
      const node = f.connect(); const connection = await node.ready;
      const controller = await f.controller(connection); await recover(controller);
      const record = await nativeRecord(f); const source = await importer(f, controller, record.instanceId);
      const held = Promise.withResolvers<void>();
      const intercept = (frame: Parameters<Parameters<typeof f.controllerBulkFrames.add>[0]>[0]) => {
        if (frame.type === 'node-history-bulk') { held.resolve(); return false; } return true;
      };
      f.controllerBulkFrames.add(intercept);
      const reading = collect(source, record.request).catch((error: unknown) => error);
      await held.promise; await node.replaceBulk();
      expect(await reading).toBeInstanceOf(Error);
      f.controllerBulkFrames.delete(intercept);
      expect(controller.signal.aborted).toBe(false); expect(f.processes.size).toBe(1);
      expect((await collect(await importer(f, controller, record.instanceId), record.request)).map(historyRowContent))
        .toEqual([record.content, 'Synthetic response']);
      expect(f.historyPool.reservedBytes).toBe(0);
    } finally { await f.dispose(); }
  }, 30_000);

  test.each(['node', 'controller'] as const)('a small %s allocation fails the whole import with typed capacity refusal', async (endpoint) => {
    const f = await createNodeSessionFixture(certificate, certificate.trust, endpoint === 'node'
      ? { historyTransportMemoryBytes: 1024 } : { controllerHistoryPool: new NodeHistoryReceiverPool(1024) });
    try {
      const controller = await f.controller(await f.connect().ready); await recover(controller);
      const record = await nativeRecord(f, 'synthetic-instance', 'Synthetic '.repeat(1000));
      await expect(collect(await importer(f, controller, record.instanceId), record.request)).rejects.toMatchObject({ code: 'NODE_CAPACITY' });
      expect(f.historyPool.reservedBytes).toBe(0); expect(controller.signal.aborted).toBe(false);
    } finally { await f.dispose(); }
  }, 30_000);
});

async function collect(service: RemoteProviderHistoryImportService, request: ProviderHistoryImportRequest) {
  const rows: AgentImportedTranscriptRow[] = [];
  for await (const batch of service.read(request, new AbortController().signal)) { expect(batch).toHaveLength(1); rows.push(...batch); }
  return rows;
}
