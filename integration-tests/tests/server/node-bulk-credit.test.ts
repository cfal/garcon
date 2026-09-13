import { createHash } from 'node:crypto';
import { expect, spyOn, test } from 'bun:test';
import { parseNodeBulkFrameText } from '../../../server/execution-nodes/transport/bulk-channel-wire.js';
import { MAX_NODE_BULK_CHUNK_BYTES, serializeNodeBulkChunk } from '../../../server/execution-nodes/transport/bulk-wire.js';
import { serializeNodeExecutionBody } from '../../../server/execution-nodes/transport/execution-body-wire.js';
import { createNodeSessionOutputFixture } from '../../support/node-session-output-fixture.js';
import { nodeSessionSystemdAvailable } from '../../support/node-session-handshake-fixture.js';
import { TlsCertificates } from '../../support/tls-certificates.js';

test.skipIf(!nodeSessionSystemdAvailable)('receiver chunk credit crosses both workers and WSS without blocking control', async () => {
  const certificates = await TlsCertificates.create();
  const f = await createNodeSessionOutputFixture(await certificates.selfSigned('bulk-credit'));
  try {
    await f.recover();
    const client = f.controller.client.execution('synthetic-instance');
    const prepared = await client.call({ method: 'prepare', location: { nodeId: f.host.pairing.nodeId,
      instanceId: 'synthetic-instance', workspaceId: 'synthetic-workspace' },
    request: { kind: 'start', chatId: '1000000000000000', runId: 'synthetic-run', configuration: {
      model: 'synthetic-model', settings: null, thinkingMode: 'none', endpoint: { credential: null,
        selection: { apiProviderId: 'synthetic-provider', endpointId: 'synthetic-endpoint', providerLabel: 'Synthetic',
          protocol: 'anthropic-messages', model: 'synthetic-model', isLocal: true, baseUrl: 'http://127.0.0.1:9', capabilities: null, headers: {} } },
    } } }, f.signal);
    if (prepared.kind !== 'prepared') throw new Error('Synthetic preparation failed');
    const bytes = serializeNodeExecutionBody({ kind: 'execution', input: {
      prompt: 'x'.repeat(MAX_NODE_BULK_CHUNK_BYTES * 3), attachments: [], carriedContext: null,
    } });
    const reserved = await f.controller.client.service.call({ method: 'reserve-body', instanceId: 'synthetic-instance',
      identity: prepared.ticket.identity, kind: 'execution', controlId: null,
      descriptor: { byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } }, f.signal);
    if (reserved.kind !== 'body-reserved') throw new Error('Synthetic bulk reservation failed');
    const received = f.bulk.receive.bind(f.bulk);
    const held = Promise.withResolvers<string>();
    let hold = true;
    const intercept = spyOn(f.bulk, 'receive').mockImplementation((text) => {
      if (hold && parseNodeBulkFrameText(text)?.type === 'node-bulk-chunk-ack') { held.resolve(text); return; }
      received(text);
    });
    try {
      let advanced = false;
      const first = f.bulk.sendChunkWithCredit(serializeNodeBulkChunk(reserved.transfer, 0,
        bytes.subarray(0, MAX_NODE_BULK_CHUNK_BYTES)), f.signal).then(() => { advanced = true; });
      const ack = await held.promise;
      expect(parseNodeBulkFrameText(ack)).toMatchObject({ type: 'node-bulk-chunk-ack',
        transfer: reserved.transfer, nextOffset: MAX_NODE_BULK_CHUNK_BYTES });
      expect(advanced).toBe(false);
      expect(await f.controller.client.service.call({ method: 'provider-auth', instanceId: 'synthetic-instance', operation: 'status' },
        f.signal)).toMatchObject({ kind: 'provider-auth-status' });
      expect(await client.call({ method: 'status', identity: prepared.ticket.identity }, f.signal)).toMatchObject({ kind: 'status' });
      expect(advanced).toBe(false);
      hold = false; received(ack); await first;
      for (let offset = MAX_NODE_BULK_CHUNK_BYTES; offset < bytes.length; offset += MAX_NODE_BULK_CHUNK_BYTES) {
        await f.bulk.sendChunkWithCredit(serializeNodeBulkChunk(reserved.transfer, offset,
          bytes.subarray(offset, offset + MAX_NODE_BULK_CHUNK_BYTES)), f.signal);
      }
      await f.bulk.complete(reserved.transfer, f.signal);
      expect(await client.call({ method: 'release', identity: prepared.ticket.identity }, f.signal))
        .toEqual({ kind: 'released' });
      expect(f.failures).toEqual([]);
    } finally { intercept.mockRestore(); }
  } finally { await f.dispose(); await certificates.dispose(); }
}, 20_000);
