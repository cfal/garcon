import { expect, mock, test } from 'bun:test';
import { serializeNodeBulkFrame } from '../../../execution-nodes/transport/bulk-channel-wire.js';
import { parseNodeHistoryBulkText, type NodeHistoryBulkFrame } from '../../../execution-nodes/transport/provider-history-bulk-wire.js';
import { NodeWorkerHistoryBulkPort } from '../history-bulk-port.js';
import { NodeWorkerWriter } from '../writer.js';
import { session, tick } from './lifecycle-fixture.js';

const grant = { ...session, transferId: 'synthetic-history-grant' };
const target = { identity: { ...session, operationId: 'synthetic-import' }, instanceId: 'synthetic-instance', connectionId: 1,
  bulkAttemptId: 'synthetic-bulk', sequence: 1, grant };
const frame = (operation: 'chunk' | 'complete' | 'cancel'): NodeHistoryBulkFrame => ({ ...target, type: 'node-history-bulk', version: 1,
  payload: serializeNodeBulkFrame(operation === 'chunk'
    ? { type: 'node-bulk-credit-chunk', version: 1, transfer: grant, offset: 0, data: 'YQ==' }
    : { type: operation === 'complete' ? 'node-bulk-complete' : 'node-bulk-cancel', version: 1, transfer: grant, requestId: 1 }) });

function fixture() {
  const lifetime = new AbortController(); const physical = new AbortController(); const failed = mock(() => {});
  const written: { text: string; drain: PromiseWithResolvers<void> }[] = [];
  const writer = new NodeWorkerWriter({ async write(bytes) {
    const drain = Promise.withResolvers<void>(); written.push({ text: Buffer.from(bytes.subarray(4)).toString(), drain }); await drain.promise;
  }, close() {} }, { signal: lifetime.signal, maxFrameBytes: 4096, maxQueuedBytes: 16384, maxQueuedFrames: 5,
    reservedControlBytes: 4096, reservedControlFrames: 1, reservedApplicationFrames: 1, reservedApplicationBytes: 1024,
    writeTimeoutMs: 1000, failed });
  const port = new NodeWorkerHistoryBulkPort(writer, { session, instanceId: target.instanceId, signal: lifetime.signal,
    capture(connectionId, bulkAttemptId) {
      if (connectionId !== 1 || bulkAttemptId !== target.bulkAttemptId) throw new Error('Synthetic replaced attempt');
      return { connectionId, bulkAttemptId, signal: physical.signal, validate: () => physical.signal.throwIfAborted() };
    } });
  return { writer, port, lifetime, physical, written, failed,
    async drain(index: number) { written[index]!.drain.resolve(); await tick(); },
    async close() { lifetime.abort(); for (const entry of written) entry.drain.resolve(); await tick(); } };
}

test('outbound history is available immediately, keeps completion after chunks, and preserves cancellation priority', async () => {
  const f = fixture();
  try {
    const held = f.writer.send('held', 'control', 'lifecycle');
    const chunk = f.port.sendWhenWritable(frame('chunk'), f.lifetime.signal, () => {});
    expect(f.port.send(frame('complete'))).toBe(true); expect(f.port.send(frame('cancel'))).toBe(true);
    await f.drain(0); await held;
    expect(parseNodeHistoryBulkText(f.written[1]!.text)?.payload).toBe(frame('cancel').payload);
    await f.drain(1);
    expect(parseNodeHistoryBulkText(f.written[2]!.text)?.payload).toBe(frame('chunk').payload);
    await f.drain(2); await chunk;
    expect(parseNodeHistoryBulkText(f.written[3]!.text)?.payload).toBe(frame('complete').payload);
    await f.drain(3); expect(f.writer.bufferedBytes).toBe(0); expect(f.failed).not.toHaveBeenCalled();
  } finally { await f.close(); }
});

test('history pressure leaves lifecycle capacity usable and never retires the shared worker', async () => {
  const f = fixture();
  try {
    const held = f.writer.send('held', 'data', 'data');
    const chunk = f.port.sendWhenWritable(frame('chunk'), f.lifetime.signal, () => {});
    expect(f.port.send(frame('complete'))).toBe(true); expect(f.port.send(frame('complete'))).toBe(false);
    expect(f.port.send(frame('cancel'))).toBe(true); expect(f.port.send(frame('cancel'))).toBe(false);
    const pulse = f.writer.send('pulse', 'control', 'lifecycle');
    await f.drain(0); await held; expect(f.written[1]!.text).toBe('pulse');
    for (const index of [1, 2, 3, 4]) await f.drain(index);
    await chunk; await pulse; expect(f.failed).not.toHaveBeenCalled();
  } finally { await f.close(); }
});

test.each(['caller', 'bulk'] as const)('%s cancellation prevents late history submission without closing the shared pipe', async (kind) => {
  const f = fixture(); const caller = new AbortController();
  try {
    const held = f.writer.send('held', 'control', 'lifecycle');
    const chunk = f.port.sendWhenWritable(frame('chunk'), caller.signal, () => {}).catch((error: unknown) => error);
    const reason = new Error('Synthetic history cancelled');
    (kind === 'bulk' ? f.physical : caller).abort(reason);
    expect(await chunk).toBe(reason);
    await f.drain(0); await held; expect(f.written).toHaveLength(1);
    const pulse = f.writer.send('pulse', 'control', 'lifecycle'); await f.drain(1); await pulse;
    expect(f.failed).not.toHaveBeenCalled();
  } finally { await f.close(); }
});
