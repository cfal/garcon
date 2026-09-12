import { expect, mock, test } from 'bun:test';
import { NodeExecutionClient, NodeExecutionServer } from '../../../execution-nodes/transport/execution-channel.js';
import type { NodeExecutionCommand } from '../../../execution-nodes/transport/execution-wire.js';
import type { NodeExecutionResult } from '../../../execution-nodes/transport/execution-receipt-wire.js';
import { NodeWorkerExecutionPort } from '../execution-port.js';
import { parseNodeWorkerExecutionText } from '../execution-protocol.js';
import { serializeNodeExecutionCancellation } from '../../../execution-nodes/transport/execution-wire.js';
import { serializeNodeExecutionReply } from '../../../execution-nodes/transport/execution-receipt-wire.js';
import { NodeWorkerWriter, type NodeWorkerWritePort } from '../writer.js';
import { NODE_WORKER_EXECUTION_LIMITS, NODE_WORKER_WRITER_LIMITS } from '../limits.js';
import { session, tick } from './lifecycle-fixture.js';

const operation = { ...session, operationId: 'synthetic-operation' };
const dispatch: NodeExecutionCommand = { method: 'dispatch', identity: operation,
  body: { ...session, transferId: 'synthetic-body' }, stream: { ...session, streamId: 'synthetic-stream' } };

test.each(['request', 'reply', 'cancel'] as const)('saturated execution %s frames leave lifecycle capacity and priority intact', async (kind) => {
  const f = fixture();
  const calls: Promise<NodeExecutionResult>[] = [];
  try {
    for (let requestId = 1; requestId <= 3; requestId += 1) {
      if (kind === 'request') calls.push(f.client.call(dispatch, new AbortController().signal));
      else expect(f.transport.send(kind === 'reply'
        ? serializeNodeExecutionReply({ type: 'node-execution-result', version: 1, session, requestId, result: { kind: 'dispatched' } })
        : serializeNodeExecutionCancellation({ type: 'node-execution-cancel', version: 1, session, requestId }))).toBe(true);
    }
    const refused = mock((_result: NodeExecutionResult) => {});
    const overflow = f.client.call(dispatch, new AbortController().signal);
    calls.push(overflow);
    void overflow.then(refused);
    await tick();
    expect(refused).toHaveBeenCalledWith({ kind: 'rejected', code: 'NODE_CAPACITY' });
    const pulse = f.writer.send('pulse', 'control');
    f.written[0]!.drained.resolve();
    await tick();
    expect(f.written[1]!.text).toBe('pulse');
    f.written[1]!.drained.resolve();
    await pulse;
    expect(f.native.close).not.toHaveBeenCalled();
  } finally { await f.close(); await Promise.all(calls); }
});

function fixture(limits = { ...NODE_WORKER_WRITER_LIMITS,
  maxFrameBytes: 4096, maxQueuedBytes: 16384, maxQueuedFrames: 4, reservedControlBytes: 4096, reservedControlFrames: 1,
  reservedUrgentFrames: 0, reservedUrgentBytes: 0, writeTimeoutMs: 1000 }) {
  const authority = new AbortController();
  const connection = new AbortController();
  const written: { text: string; drained: PromiseWithResolvers<void> }[] = [];
  const callbacks: (() => void)[] = [];
  const failed = mock(() => {});
  let onWrite: (() => void) | null = null;
  const native = { async write(bytes: Uint8Array) {
    const text = Buffer.from(bytes.subarray(4)).toString();
    const drained = Promise.withResolvers<void>();
    written.push({ text, drained });
    onWrite?.();
    await drained.promise;
  }, close: mock(() => {}) } satisfies NodeWorkerWritePort;
  const writer = new NodeWorkerWriter(native, { ...limits, signal: authority.signal, failed });
  const transport = new NodeWorkerExecutionPort(writer, { session, connectionId: 1, instanceId: 'synthetic-instance', signal: connection.signal,
    validate() { connection.signal.throwIfAborted(); }, closed() { client.close(); } });
  const client = new NodeExecutionClient(transport, { session, signal: connection.signal, validate() {},
    scheduleTimeout(callback) { callbacks.push(callback); return { cancel() {} }; } });
  const execute = mock(async (_command: NodeExecutionCommand, _signal: AbortSignal): Promise<NodeExecutionResult> => ({ kind: 'dispatched' }));
  const server = new NodeExecutionServer({ send(payload) { client.receive(payload); return true; }, close() {} }, { execute },
    { session, signal: connection.signal, validate() {} });
  const frames = () => written.flatMap(({ text }) => {
    const frame = parseNodeWorkerExecutionText(text);
    return frame ? [JSON.parse(frame.payload)] : [];
  });
  return { writer, written, native, transport, client, server, execute, connection, callbacks, frames,
    onWrite(callback: () => void) { onWrite = callback; },
    async deliver(index: number) {
      const frame = parseNodeWorkerExecutionText(written[index]!.text);
      if (frame) server.receive(frame.payload);
      written[index]!.drained.resolve();
      await tick();
    },
    async close() {
      client.close(); server.close(); authority.abort();
      for (const entry of written) entry.drained.resolve();
      await tick();
    },
  };
}

test('production limits deliver a full channel reply burst without dropping replies', async () => {
  const f = fixture(NODE_WORKER_WRITER_LIMITS);
  const total = NODE_WORKER_EXECUTION_LIMITS.maxRequests + NODE_WORKER_EXECUTION_LIMITS.reservedControlRequests;
  try {
    for (let requestId = 1; requestId <= total; requestId += 1) {
      expect(f.transport.send(serializeNodeExecutionReply({ type: 'node-execution-result', version: 1,
        session, requestId, result: { kind: 'status', receipt: null } }))).toBe(true);
    }
    const pulse = f.writer.send('pulse', 'control');
    await f.deliver(0);
    expect(f.written[1]!.text).toBe('pulse');
    await f.deliver(1); await pulse;
    for (let index = 2; index <= total; index += 1) await f.deliver(index);
    expect(f.frames().map((frame) => frame.requestId)).toEqual(Array.from({ length: total }, (_, index) => index + 1));
    expect(f.writer.bufferedBytes).toBe(0);
    expect(f.native.close).not.toHaveBeenCalled();
  } finally { await f.close(); }
});

test.each(['cancel', 'timeout'] as const)('worker request %s before submission sends neither mutation nor cancellation', async (cause) => {
  const f = fixture();
  const cancellation = new AbortController();
  try {
    const hold = f.writer.send('hold', 'data');
    const first = f.client.call(dispatch, cancellation.signal);
    if (cause === 'cancel') cancellation.abort(); else f.callbacks[0]!();
    expect(await first).toEqual({ kind: 'unknown' });
    const next = f.client.call(dispatch, new AbortController().signal);
    await f.deliver(0); await hold;
    expect(f.frames().map((frame) => [frame.type, frame.requestId])).toEqual([['node-execution-request', 2]]);
    await f.deliver(1);
    expect(await next).toEqual({ kind: 'dispatched' });
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(f.native.close).not.toHaveBeenCalled();
  } finally { await f.close(); }
});

test('a submitted worker request gets exactly one cancellation and never a mutation retry', async () => {
  const f = fixture();
  const cancellation = new AbortController();
  try {
    const pending = f.client.call(dispatch, cancellation.signal);
    cancellation.abort();
    expect(await pending).toEqual({ kind: 'unknown' });
    await f.deliver(0);
    expect(f.frames().map((frame) => [frame.type, frame.requestId])).toEqual([
      ['node-execution-request', 1], ['node-execution-cancel', 1],
    ]);
    await f.deliver(1);
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(f.native.close).not.toHaveBeenCalled();
  } finally { await f.close(); }
});

test('cancellation inside native submission still sends the exact request cancellation once', async () => {
  const f = fixture();
  const cancellation = new AbortController();
  try {
    f.onWrite(() => cancellation.abort());
    expect(await f.client.call(dispatch, cancellation.signal)).toEqual({ kind: 'unknown' });
    await f.deliver(0);
    await f.deliver(1);
    expect(f.frames().map((frame) => frame.type)).toEqual(['node-execution-request', 'node-execution-cancel']);
  } finally { await f.close(); }
});

test('a replaced physical connection drops queued commands while preserving the shared worker pipe', async () => {
  const f = fixture();
  try {
    const hold = f.writer.send('hold', 'data');
    const first = f.client.call(dispatch, new AbortController().signal);
    f.connection.abort();
    expect(await first).toEqual({ kind: 'unknown' });
    await f.deliver(0); await hold;
    expect(f.frames()).toEqual([]);
    const next = f.writer.send('next', 'control');
    await f.deliver(1); await next;
    expect(f.native.close).not.toHaveBeenCalled();
    expect(f.writer.bufferedBytes).toBe(0);
  } finally { await f.close(); }
});

test('worker queue capacity rejects only the definitely unsent call and leaves no later cancellation', async () => {
  const f = fixture();
  const cancellation = new AbortController();
  try {
    const fills = Array.from({ length: 4 }, () => f.writer.send('fill', 'control'));
    expect(await f.client.call(dispatch, cancellation.signal)).toEqual({ kind: 'rejected', code: 'NODE_CAPACITY' });
    cancellation.abort();
    for (let index = 0; index < fills.length; index++) await f.deliver(index);
    await Promise.all(fills);
    expect(f.frames()).toEqual([]);
    const next = f.client.call(dispatch, new AbortController().signal);
    await f.deliver(4);
    expect(await next).toEqual({ kind: 'dispatched' });
    expect(f.frames()[0].requestId).toBe(2);
    expect(f.native.close).not.toHaveBeenCalled();
  } finally { await f.close(); }
});
