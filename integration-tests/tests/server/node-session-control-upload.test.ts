import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { NODE_WIRE_VERSION } from '../../../server-agents/interface/src/index.js';
import { serializeNodeBulkFrame } from '../../../server/execution-nodes/transport/bulk-channel-wire.js';
import { serializeNodeExecutionBody } from '../../../server/execution-nodes/transport/execution-body-wire.js';
import { claudeText } from '../../support/fake-claude-model.js';
import { nodeSessionSystemdAvailable } from '../../support/node-session-handshake-fixture.js';
import { createNodeSessionOutputFixture } from '../../support/node-session-output-fixture.js';
import { startScriptedClaudeTestEnvironment } from '../../support/scripted-claude.js';
import { TlsCertificates, type TestCertificate } from '../../support/tls-certificates.js';

let certificates: TlsCertificates;
let certificate: TestCertificate;
beforeAll(async () => { certificates = await TlsCertificates.create(); certificate = await certificates.selfSigned('control-upload'); });
afterAll(async () => certificates?.dispose());

describe.skipIf(!nodeSessionSystemdAvailable)('exact control upload cancellation through WSS and native workers', () => {
  test('cancelling a prepared Claude steer revokes partial and complete bulk bodies', async () => {
    const provider = await startScriptedClaudeTestEnvironment();
    const held = provider.model.scriptHeldTurn([claudeText('synthetic original turn completed')]);
    const f = await createNodeSessionOutputFixture(certificate, { instance: { agentId: 'claude', environment: provider.serverEnvironment } });
    const source = new AbortController();
    try {
      await f.recover();
      const output = await f.install('synthetic-upload-source', { signal: source.signal, emit() {} });
      const configuration = { model: 'haiku', thinkingMode: 'low' as const, permissionMode: 'default' as const,
        settings: { ownerId: 'claude', schemaVersion: 1, values: {} }, endpoint: null };
      const started = await f.start(output, '1789000000000017', 'synthetic-upload-run', configuration, 'synthetic original input');
      expect(started.result).toEqual({ kind: 'dispatched' });
      await held.requested;
      const client = f.controller.client.execution('synthetic-instance');
      for (const complete of [false, true]) {
        const prepared = await client.call({ method: 'prepare-steer', identity: started.identity }, f.signal);
        if (prepared.kind !== 'control-prepared' || prepared.preparation.kind !== 'ready') throw new Error('Synthetic steer unavailable');
        const controlId = prepared.preparation.ticket.controlId;
        const bytes = serializeNodeExecutionBody({ kind: 'steer', input: 'synthetic unsent guidance', clientMessageId: 'synthetic-message' });
        const reserved = await f.controller.client.service.call({ method: 'reserve-body', instanceId: 'synthetic-instance',
          identity: started.identity, kind: 'steer', controlId,
          descriptor: { byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } }, f.signal);
        if (reserved.kind !== 'body-reserved') throw new Error('Synthetic upload unavailable');
        await f.bulk.sendChunk(serializeNodeBulkFrame({ type: 'node-bulk-chunk', version: NODE_WIRE_VERSION,
          transfer: reserved.transfer, offset: 0, data: Buffer.from(complete ? bytes : bytes.subarray(0, 2)).toString('base64') }), f.signal);
        if (complete) await f.bulk.complete(reserved.transfer, f.signal);
        expect(await client.call({ method: 'cancel-control', identity: started.identity, controlId }, f.signal))
          .toEqual({ kind: 'control-cancelled', cancelled: true });
        await expect(f.bulk.complete(reserved.transfer, f.signal)).rejects.toMatchObject({ code: 'NODE_BULK_UNAVAILABLE' });
        expect(await client.call({ method: 'status', identity: started.identity }, f.signal)).toMatchObject({ kind: 'status',
          receipt: { phase: 'dispatched', runId: 'synthetic-upload-run', abort: null,
            control: { outcome: { kind: 'failed', outcome: 'not-sent' } } } });
      }
      held.release();
      expect(await f.waitFor(output, event => event.type === 'run-ended')).toMatchObject({ outcome: 'finished' });
      expect(provider.model.requests()).toHaveLength(1);
      expect(f.failures).toEqual([]);
      provider.model.assertSettled();
    } finally { held.release(); source.abort(); await f.dispose(); provider.dispose(); }
  }, 60_000);
});
