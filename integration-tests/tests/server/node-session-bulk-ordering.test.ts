import { createHash } from 'node:crypto';
import { expect, spyOn, test } from 'bun:test';
import { NODE_WIRE_VERSION } from '../../../server-agents/interface/src/index.js';
import { parseNodeBulkFrameText, serializeNodeBulkFrame, type NodeBulkReply } from '../../../server/execution-nodes/transport/bulk-channel-wire.js';
import { serializeNodeExecutionBody } from '../../../server/execution-nodes/transport/execution-body-wire.js';
import { Deferred, withTimeout } from '../../support/deferred.js';
import { nodeSessionSystemdAvailable } from '../../support/node-session-handshake-fixture.js';
import { createNodeSessionOutputFixture } from '../../support/node-session-output-fixture.js';
import { TlsCertificates } from '../../support/tls-certificates.js';

test.skipIf(!nodeSessionSystemdAvailable)('urgent bulk cancellation can pass queued completion across WSS and worker pipes', async () => {
  const certificates = await TlsCertificates.create();
  const certificate = await certificates.selfSigned('bulk-order');
  const f = await createNodeSessionOutputFixture(certificate);
  const release = new Deferred<void>();
  const draining = new Deferred<void>();
  const queuedComplete = new Deferred<void>();
  const queuedCancel = new Deferred<void>();
  const lateComplete = new Deferred<void>();
  const replies: NodeBulkReply[] = [];
  const restores: (() => void)[] = [];
  let admitting: Promise<void> | undefined;
  let completing: Promise<unknown> | undefined;
  let cancelling: Promise<void> | undefined;
  try {
    await f.recover();
    const client = f.controller.client.execution('synthetic-instance');
    const prepared = await client.call({ method: 'prepare',
      location: { nodeId: f.host.pairing.nodeId, instanceId: 'synthetic-instance', workspaceId: 'synthetic-workspace' },
      request: { kind: 'start', chatId: '1789000000000018', runId: 'synthetic-bulk-run', configuration: {
        model: 'synthetic-model', permissionMode: 'default', thinkingMode: 'none', settings: null, endpoint: null,
      } },
    }, f.signal);
    if (prepared.kind !== 'prepared') throw new Error(`Synthetic preparation failed: ${JSON.stringify(prepared)}`);
    const bytes = serializeNodeExecutionBody({ kind: 'execution', input: { prompt: 'synthetic input', attachments: [], carriedContext: null } });
    const reserved = await f.controller.client.service.call({ method: 'reserve-body', instanceId: 'synthetic-instance',
      identity: prepared.ticket.identity, kind: 'execution', controlId: null,
      descriptor: { byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') },
    }, f.signal);
    if (reserved.kind !== 'body-reserved') throw new Error('Synthetic reservation failed');
    await f.bulk.sendChunk(serializeNodeBulkFrame({ type: 'node-bulk-chunk', version: NODE_WIRE_VERSION,
      transfer: reserved.transfer, offset: 0, data: Buffer.from(bytes).toString('base64') }), f.signal);

    const child = [...f.host.processes.values()][0]!;
    const flush = child.stdin.flush.bind(child.stdin);
    const heldFlush = spyOn(child.stdin, 'flush').mockImplementation(async () => {
      const result = await flush();
      draining.resolve();
      await release.promise;
      return result;
    });
    restores.push(() => heldFlush.mockRestore());
    const peer = f.host.coordinator.peer(f.connection);
    const forward = peer.forward.bind(peer);
    const observed = spyOn(peer, 'forward').mockImplementation((frame, signal) => {
      const submitted = forward(frame, signal);
      if (frame.type === 'node-worker-bulk') {
        const payload = parseNodeBulkFrameText(frame.payload);
        if (payload?.type === 'node-bulk-complete') queuedComplete.resolve();
        if (payload?.type === 'node-bulk-cancel') queuedCancel.resolve();
      }
      return submitted;
    });
    restores.push(() => observed.mockRestore());
    f.controller.bulkReceived.add(frame => {
      const payload = parseNodeBulkFrameText(frame.payload);
      if (payload?.type !== 'node-bulk-result') return;
      replies.push(payload);
      if (payload.command === 'node-bulk-complete') lateComplete.resolve();
    });
    admitting = peer.admit(f.connection.connectionId);
    void admitting.catch(() => {});
    await withTimeout(draining.promise, 5000, () => 'Synthetic native write did not enter drain');
    const caller = new AbortController();
    completing = f.bulk.complete(reserved.transfer, caller.signal).catch((error: unknown) => error);
    await withTimeout(queuedComplete.promise, 5000, () => 'WSS completion did not reach worker queue');
    caller.abort(new Error('Synthetic upload cancellation'));
    expect(await completing).toBe(caller.signal.reason);
    cancelling = f.bulk.cancel(reserved.transfer);
    void cancelling.catch(() => {});
    await withTimeout(queuedCancel.promise, 5000, () => 'WSS cancellation did not reach worker queue');
    expect(replies).toEqual([]);
    release.resolve();
    await admitting;
    await withTimeout(cancelling, 5000, () => 'Bulk cancellation was not confirmed');
    await withTimeout(lateComplete.promise, 5000, () => 'Late bulk completion was not answered');
    expect(replies).toMatchObject([
      { command: 'node-bulk-cancel', requestId: 1, result: 'cancelled' },
      { command: 'node-bulk-complete', requestId: 1, result: 'NODE_BULK_UNAVAILABLE' },
    ]);
    expect(f.connection.lease.authoritySignal.aborted).toBe(false);
    expect(f.controller.signal.aborted).toBe(false);
    expect(await client.call({ method: 'status', identity: prepared.ticket.identity }, f.signal))
      .toMatchObject({ kind: 'status', receipt: { phase: 'prepared' } });
    expect(await client.call({ method: 'release', identity: prepared.ticket.identity }, f.signal))
      .toEqual({ kind: 'released' });
    expect(f.failures).toEqual([]);
  } finally {
    release.resolve();
    for (const restore of restores) restore();
    await Promise.allSettled([admitting, completing, cancelling]);
    await f.dispose();
    await certificates.dispose();
  }
}, 30_000);
