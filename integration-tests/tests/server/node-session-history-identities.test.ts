import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { NodeProviderHistoryCommand } from '../../../server/execution-nodes/transport/provider-history-wire.js';
import { createNodeSessionFixture, nodeSessionSystemdAvailable } from '../../support/node-session-handshake-fixture.js';
import { createNodeHistoryRecord, recoverHistoryConnection, remoteHistoryImporter } from '../../support/node-history-fixture.js';
import { TlsCertificates, type TestCertificate } from '../../support/tls-certificates.js';

let certificates: TlsCertificates; let certificate: TestCertificate;
beforeAll(async () => { certificates = await TlsCertificates.create(); certificate = await certificates.selfSigned('history-identities'); });
afterAll(async () => certificates?.dispose());

describe.skipIf(!nodeSessionSystemdAvailable)('history identity lifetime through WSS and both workers', () => {
  test('uninstalled cancellation allocates nothing while exact cancellation fences a delayed open across admission', async () => {
    const f = await createNodeSessionFixture(certificate);
    try {
      const controller = await f.controller(await f.connect().ready);
      const record = await createNodeHistoryRecord(f);
      const binding = await controller.historyConnection();
      const target = { method: 'provider-history-import', identity: { ...binding.session, operationId: '1' },
        instanceId: record.instanceId, connectionId: binding.connectionId, bulkAttemptId: binding.bulkAttemptId } as const;
      for (let ordinal = 1; ordinal <= 100; ordinal++) {
        expect(await controller.client.service.call({ ...target, operation: 'cancel',
          identity: { ...target.identity, operationId: String(ordinal) }, bulkAttemptId: String(Number(binding.bulkAttemptId) + 1) }, controller.signal))
          .toMatchObject({ operation: 'cancelled', settled: true });
      }
      const operation = binding.operations.allocate(binding.session, record.instanceId)!;
      expect(operation.operationId).toBe('1');
      expect(await controller.client.service.call({ ...target, operation: 'cancel' }, controller.signal))
        .toMatchObject({ operation: 'cancelled', settled: true });
      operation.release();
      await recoverHistoryConnection(controller);
      const { projectPath: _projectPath, ...chat } = record.request.chat;
      expect(await controller.client.service.call({ ...target, operation: 'open', after: 0, facet: 'native', workspaceId: 'synthetic-workspace', chat }, controller.signal))
        .toMatchObject({ operation: 'failed', code: 'NODE_HISTORY_INVALID' });
      const source = await remoteHistoryImporter(f, controller, record.instanceId);
      let rows = 0;
      for await (const batch of source.read(record.request, controller.signal)) rows += batch.length;
      expect(rows).toBe(2); expect(f.historyPool.reservedBytes).toBe(0);
    } finally { await f.dispose(); }
  }, 30_000);

  test('history and bulk ordinals survive physical replacement and reset only with logical authority', async () => {
    const f = await createNodeSessionFixture(certificate);
    const opens: Extract<NodeProviderHistoryCommand, { operation: 'open' }>[] = [];
    f.nodeFrames.add((frame) => {
      if (frame.type === 'node-worker-service-request' && frame.command.method === 'provider-history-import' && frame.command.operation === 'open') opens.push(frame.command);
      return true;
    });
    try {
      const first = f.connect(); const original = await first.ready;
      const controller = await f.controller(original); await recoverHistoryConnection(controller);
      const record = await createNodeHistoryRecord(f);
      const read = async (owner: typeof controller) => {
        const source = await remoteHistoryImporter(f, owner, record.instanceId);
        let rows = 0;
        for await (const batch of source.read(record.request, owner.signal)) rows += batch.length;
        expect(rows).toBe(2);
      };
      const binding = await controller.historyConnection();
      await read(controller);
      await first.replaceBulk();
      const replacement = await controller.historyConnection();
      expect(replacement.operations).toBe(binding.operations);
      expect(Number(replacement.bulkAttemptId)).toBeGreaterThan(Number(binding.bulkAttemptId));
      await read(controller);
      first.stop(); await first.closed;
      const second = f.connect(); const reattached = await second.ready;
      const nextController = await f.controller(reattached); await recoverHistoryConnection(nextController);
      const nextBinding = await nextController.historyConnection();
      expect(nextBinding.operations).toBe(binding.operations);
      expect(Number(nextBinding.bulkAttemptId)).toBeGreaterThan(Number(replacement.bulkAttemptId));
      await read(nextController);
      expect(opens.map((command) => [command.identity.operationId, command.after])).toEqual([['1', 0], ['2', 1], ['3', 2]]);
      second.stop(); await second.closed; f.restartController();
      const fresh = await f.connect().ready; const freshController = await f.controller(fresh); await recoverHistoryConnection(freshController);
      const freshBinding = await freshController.historyConnection();
      expect(freshBinding.operations).not.toBe(binding.operations);
      expect(binding.operations.allocate(binding.session, record.instanceId)).toBeNull();
      expect(freshBinding.operations.allocate(freshBinding.session, record.instanceId)).toMatchObject({ operationId: '1', after: 0 });
      expect(freshBinding.bulkAttemptId).toBe('1');
    } finally { await f.dispose(); }
  }, 30_000);
});
