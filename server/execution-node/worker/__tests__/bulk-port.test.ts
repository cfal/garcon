import { expect, mock, test } from 'bun:test';
import { NODE_WIRE_VERSION } from '@garcon/server-agent-interface';
import { NodeBulkError } from '../../../execution-nodes/transport/bulk-transfers.js';
import { NodeBulkChannel, type NodeBulkReceivePort } from '../../../execution-nodes/transport/bulk-channel.js';
import { serializeNodeBulkChunk } from '../../../execution-nodes/transport/bulk-wire.js';
import { serializeNodeBulkFrame } from '../../../execution-nodes/transport/bulk-channel-wire.js';
import { NodeWorkerBulkPort } from '../bulk-port.js';
import { parseNodeWorkerBulkText } from '../bulk-protocol.js';
import { NodeWorkerWriter, type NodeWorkerWritePort } from '../writer.js';
import { session, tick } from './lifecycle-fixture.js';

const transfer = { ...session, transferId: 'synthetic-transfer' };
const chunk = serializeNodeBulkChunk(transfer, 0, new Uint8Array([1, 2, 3]));
const reply = serializeNodeBulkFrame({ type: 'node-bulk-result', command: 'node-bulk-complete', version: NODE_WIRE_VERSION, session, requestId: 1, result: 'completed' });

function fixture(maxQueuedFrames = 4) {
  const lifetime = new AbortController();
  const connection = new AbortController();
  const closed = mock(() => {});
  const failed = mock(() => {});
  const written: { text: string; drain: PromiseWithResolvers<void> }[] = [];
  const native = { async write(bytes: Uint8Array) {
    const drain = Promise.withResolvers<void>();
    written.push({ text: Buffer.from(bytes.subarray(4)).toString(), drain });
    await drain.promise;
  }, close: mock(() => {}) } satisfies NodeWorkerWritePort;
  const writer = new NodeWorkerWriter(native, { signal: lifetime.signal,
    maxFrameBytes: 4096, maxQueuedBytes: 16384, maxQueuedFrames, reservedControlBytes: 4096, reservedControlFrames: 1,
    reservedApplicationFrames: 1, reservedApplicationBytes: 1024,
    writeTimeoutMs: 1000, failed });
  const port = new NodeWorkerBulkPort(writer, { session, instanceId: 'synthetic-instance', connectionId: 1,
    signal: connection.signal, validate() { connection.signal.throwIfAborted(); }, closed });
  return { port, writer, connection, native, written, closed, failed,
    async drain(index: number) { written[index]!.drain.resolve(); await tick(); },
    async close() { port.close(); lifetime.abort(); for (const entry of written) entry.drain.resolve(); await tick(); } };
}

test('worker bulk awaits native chunk drain while control replies overtake queued data', async () => {
  const f = fixture();
  try {
    const held = f.writer.send('held', 'data', 'data');
    const pending = f.port.sendWhenWritable(chunk, f.connection.signal);
    let drained = false;
    void pending.then(() => { drained = true; });
    expect(f.port.send(reply)).toBe(true);
    await f.drain(0); await held;
    expect(parseNodeWorkerBulkText(f.written[1]!.text)?.payload).toBe(reply);
    expect(drained).toBe(false);
    await f.drain(1);
    expect(parseNodeWorkerBulkText(f.written[2]!.text)?.payload).toBe(chunk);
    expect(drained).toBe(false);
    await f.drain(2); await pending; await f.port.writable(f.connection.signal);
    expect(f.writer.bufferedBytes).toBe(0);
    expect(f.native.close).not.toHaveBeenCalled();
  } finally { await f.close(); }
});

test('bulk completion stays behind queued chunks while replies retain their reserved priority', async () => {
  const f = fixture(5);
  const complete = serializeNodeBulkFrame({ type: 'node-bulk-complete', version: NODE_WIRE_VERSION, transfer, requestId: 1 });
  try {
    const held = f.writer.send('held', 'control', 'lifecycle');
    const pending = f.port.sendWhenWritable(chunk, f.connection.signal);
    expect(f.port.send(complete)).toBe(true);
    expect(f.port.send(reply)).toBe(true);
    await f.drain(0); await held;
    expect(parseNodeWorkerBulkText(f.written[1]!.text)?.payload).toBe(reply);
    await f.drain(1);
    expect(parseNodeWorkerBulkText(f.written[2]!.text)?.payload).toBe(chunk);
    await f.drain(2); await pending;
    expect(parseNodeWorkerBulkText(f.written[3]!.text)?.payload).toBe(complete);
    await f.drain(3);
    expect(f.writer.bufferedBytes).toBe(0);
  } finally { await f.close(); }
});

test('worker bulk capacity refuses one transfer while preserving the control reservation and pipe', async () => {
  const f = fixture();
  try {
    const first = f.port.sendWhenWritable(chunk, f.connection.signal);
    const second = f.port.sendWhenWritable(chunk, f.connection.signal);
    await expect(f.port.sendWhenWritable(chunk, f.connection.signal)).rejects.toMatchObject({ code: 'NODE_CAPACITY' });
    expect(f.port.send(reply)).toBe(true);
    expect(f.port.send(reply)).toBe(false);
    const pulse = f.writer.send('pulse', 'control', 'lifecycle');
    expect(f.closed).not.toHaveBeenCalled();
    await f.drain(0);
    expect(f.written[1]!.text).toBe('pulse');
    await f.drain(1); await f.drain(2); await f.drain(3);
    await Promise.all([first, second, pulse]);
    expect(f.writer.bufferedBytes).toBe(0);
  } finally { await f.close(); }
});

test('refused chunk ACK admission preserves the shared worker and lifecycle reservation', async () => {
  const f = fixture();
  const receiver = { append: mock(() => {}), complete: mock(() => {}), cancel: mock(() => {}) } satisfies NodeBulkReceivePort;
  const channel = new NodeBulkChannel(f.port, receiver, { session, signal: f.connection.signal, validate() {} });
  try {
    const first = f.port.sendWhenWritable(chunk, f.connection.signal);
    const second = f.port.sendWhenWritable(chunk, f.connection.signal);
    void first.catch(() => {}); void second.catch(() => {});
    expect(f.port.send(reply)).toBe(true);
    channel.receive(JSON.stringify({ ...JSON.parse(chunk), type: 'node-bulk-credit-chunk' }));
    expect(receiver.append).toHaveBeenCalledTimes(1);
    expect(receiver.complete).not.toHaveBeenCalled();
    expect(f.closed).not.toHaveBeenCalled();
    expect(f.native.close).not.toHaveBeenCalled();
    const pulse = f.writer.send('pulse', 'control', 'lifecycle');
    await f.drain(0);
    expect(f.written[1]!.text).toBe('pulse');
    await f.drain(1); await f.drain(2); await f.drain(3);
    await Promise.all([first, second, pulse]);
    expect(f.port.send(reply)).toBe(true);
    await f.drain(4);
    expect(f.failed).not.toHaveBeenCalled();
  } finally { channel.close(); await f.close(); }
});

test.each(['caller', 'connection'] as const)('a %s cancellation drops queued bulk bytes without closing the shared pipe', async (kind) => {
  const f = fixture();
  try {
    const held = f.writer.send('held', 'control', 'lifecycle');
    const caller = new AbortController();
    const pending = f.port.sendWhenWritable(chunk, caller.signal).catch((error: unknown) => error);
    if (kind === 'caller') caller.abort(); else f.connection.abort();
    expect(await pending).toBeInstanceOf(Error);
    await f.drain(0); await held;
    expect(f.written).toHaveLength(1);
    const next = f.writer.send('next', 'control', 'lifecycle');
    await f.drain(1); await next;
    expect(f.native.close).not.toHaveBeenCalled();
    expect(f.closed).toHaveBeenCalledTimes(kind === 'connection' ? 1 : 0);
  } finally { await f.close(); }
});

test('transfer revocation before native submission remains local to that transfer', async () => {
  const f = fixture();
  try {
    const held = f.writer.send('held', 'control', 'lifecycle');
    let live = true;
    const pending = f.port.sendWhenWritable(chunk, f.connection.signal, () => {
      if (!live) throw new NodeBulkError('NODE_BULK_UNAVAILABLE', 'Synthetic transfer retired');
    }).catch((error: unknown) => error);
    live = false;
    await f.drain(0); await held;
    expect(await pending).toMatchObject({ code: 'NODE_BULK_UNAVAILABLE' });
    expect(f.written).toHaveLength(1);
    expect(f.closed).not.toHaveBeenCalled();
    expect(f.port.send(reply)).toBe(true);
    await f.drain(1);
  } finally { await f.close(); }
});

test('a native write failure closes the bulk channel and settles every queued chunk', async () => {
  const f = fixture();
  try {
    const first = f.port.sendWhenWritable(chunk, f.connection.signal).catch((error: unknown) => error);
    const second = f.port.sendWhenWritable(chunk, f.connection.signal).catch((error: unknown) => error);
    f.written[0]!.drain.reject(new Error('Synthetic pipe failed'));
    expect(await first).toMatchObject({ code: 'NODE_WORKER_CLOSED' });
    expect(await second).toBeInstanceOf(Error);
    await tick();
    expect(f.closed).toHaveBeenCalledTimes(1);
    expect(f.native.close).toHaveBeenCalledTimes(1);
    expect(f.failed).toHaveBeenCalledTimes(1);
    expect(f.writer.bufferedBytes).toBe(0);
  } finally { await f.close(); }
});
