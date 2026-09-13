import { immediateNodeReplies } from '../../../execution-nodes/transport/reply-port.js';
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
import { NodeSessionSocketWriter } from '../../../execution-nodes/transport/session-socket-writer.js';
import { NodeDeadline } from '../../../execution-nodes/deadline.js';

const operation = { ...session, operationId: 'synthetic-operation' };
const dispatch: NodeExecutionCommand = { method: 'dispatch', identity: operation,
  body: { ...session, transferId: 'synthetic-body' }, stream: { ...session, streamId: 'synthetic-stream' } };

test('expiry during synchronous socket materialization preserves other in-flight execution calls', async () => {
  const lifetime = new AbortController();
  const held = Promise.withResolvers<NodeExecutionResult>();
  const payloads: string[] = [];
  let elapsedMs = 0;
  let expire: (() => void) | null = null;
  const closed = mock(() => {});
  const send = (text: string) => {
    const frame = parseNodeWorkerExecutionText(text);
    if (!frame) throw new Error('Missing synthetic execution frame');
    payloads.push(frame.payload);
    server.receive(frame.payload);
    return true;
  };
  const socket = new NodeSessionSocketWriter({ send, sendData: send, sendApplication: send }, lifetime.signal);
  const port = new NodeWorkerExecutionPort({ submit(source, priority, authority, admission) {
    return socket.submit(source, priority, { ...authority, validate() {
      authority.validate();
      const callback = expire; expire = null; callback?.();
    } }, admission);
  } }, { session, connectionId: 1, instanceId: 'synthetic-instance', signal: lifetime.signal, validate() {}, closed });
  const client = new NodeExecutionClient(port, { session, signal: lifetime.signal, validate() {} });
  const execute = mock(async (): Promise<NodeExecutionResult> => ({ kind: 'dispatched' }));
  execute.mockImplementationOnce(() => held.promise);
  const server = new NodeExecutionServer(immediateNodeReplies({ send(text) { client.receive(text); return true; }, close: closed }),
    { execute }, { session, signal: lifetime.signal, validate() {} });
  try {
    const first = client.call(dispatch, lifetime.signal);
    const deadline = new NodeDeadline(10, { read: () => ({ elapsedMs, discontinuity: false }) });
    expire = () => { elapsedMs = 10; };
    expect(await client.call(dispatch, lifetime.signal, deadline)).toEqual({ kind: 'unknown' });
    expect(closed).not.toHaveBeenCalled();
    expect(payloads).toHaveLength(1);
    held.resolve({ kind: 'dispatched' });
    expect(await first).toEqual({ kind: 'dispatched' });
    expect(await client.call(dispatch, lifetime.signal)).toEqual({ kind: 'dispatched' });
    expect(execute).toHaveBeenCalledTimes(2);
  } finally { held.resolve({ kind: 'unknown' }); client.close(); server.close(); lifetime.abort(); }
});

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
    const pulse = f.writer.send('pulse', 'control', 'lifecycle');
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
  reservedApplicationFrames: 0, reservedApplicationBytes: 0, writeTimeoutMs: 1000 }) {
  const authority = new AbortController();
  const connection = new AbortController();
  const written: { text: string; drained: PromiseWithResolvers<void> }[] = [];
  const callbacks: (() => void)[] = [];
  let elapsedMs = 0;
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
    createClock: () => ({ read: () => ({ elapsedMs, discontinuity: false }) }),
    scheduleTimeout(callback) { callbacks.push(callback); return { cancel() {} }; } });
  const execute = mock(async (_command: NodeExecutionCommand, _signal: AbortSignal): Promise<NodeExecutionResult> => ({ kind: 'dispatched' }));
  const server = new NodeExecutionServer(immediateNodeReplies({ send(payload) { client.receive(payload); return true; }, close() {} }), { execute },
    { session, signal: connection.signal, validate() {} });
  const frames = () => written.flatMap(({ text }) => {
    const frame = parseNodeWorkerExecutionText(text);
    return frame ? [JSON.parse(frame.payload)] : [];
  });
  return { writer, written, native, transport, client, server, execute, connection, callbacks, frames,
    advance(milliseconds: number) { elapsedMs += milliseconds; },
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

test.each(['abort', 'status', 'release'] as const)('reserved %s admission reaches the receiver after an earlier queued request', async (method) => {
  const f = fixture({ ...NODE_WORKER_WRITER_LIMITS, maxFrameBytes: 4096, maxQueuedBytes: 16384, maxQueuedFrames: 4,
    reservedControlBytes: 4096, reservedControlFrames: 1, reservedApplicationBytes: 1024, reservedApplicationFrames: 1 });
  const expected: NodeExecutionResult = method === 'abort' ? { kind: 'abort-result', requested: true }
    : method === 'release' ? { kind: 'released' } : { kind: 'status', receipt: null };
  f.execute.mockImplementation(async (command) => command.method === 'dispatch'
    ? { kind: 'dispatched' } : expected);
  try {
    const hold = f.writer.send('hold', 'data', 'data');
    const first = f.client.call(dispatch, f.connection.signal);
    expect(await f.client.call(dispatch, f.connection.signal)).toEqual({ kind: 'rejected', code: 'NODE_CAPACITY' });
    const control = f.client.call({ method, identity: operation }, f.connection.signal);
    const pulse = f.writer.send('pulse', 'control', 'lifecycle');
    await f.deliver(0); await hold;
    expect(f.written[1]!.text).toBe('pulse');
    await f.deliver(1); await pulse;
    await f.deliver(2);
    expect(await first).toEqual({ kind: 'dispatched' });
    await f.deliver(3);
    expect(await control).toEqual(expected);
    expect(f.execute.mock.calls.map(([command]) => command.method)).toEqual(['dispatch', method]);
    expect(f.frames().map((frame) => frame.requestId)).toEqual([1, 3]);
    expect(f.native.close).not.toHaveBeenCalled();
  } finally { await f.close(); }
});

test('an expired queued execution never enters native submission before its delayed timeout callback', async () => {
  const f = fixture();
  try {
    const hold = f.writer.send('hold', 'data', 'data');
    const pending = f.client.call(dispatch, new AbortController().signal);
    f.advance(10_000);
    await f.deliver(0); await hold;
    expect(await pending).toEqual({ kind: 'unknown' });
    expect(f.frames()).toEqual([]);
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.writer.bufferedBytes).toBe(0);
    f.callbacks[0]!();
    const successor = f.client.call(dispatch, new AbortController().signal);
    await f.deliver(1);
    expect(await successor).toEqual({ kind: 'dispatched' });
    expect(f.frames().map((frame) => frame.requestId)).toEqual([2]);
    expect(f.native.close).not.toHaveBeenCalled();
  } finally { await f.close(); }
});

test('queued execution encodes its remaining budget at native submission and keeps its captured command', async () => {
  const f = fixture();
  const command = { ...dispatch, identity: { ...dispatch.identity } };
  try {
    const hold = f.writer.send('hold', 'data', 'data');
    const pending = f.client.call(command, new AbortController().signal);
    command.identity.operationId = 'synthetic-mutated';
    f.advance(4321);
    await f.deliver(0); await hold;
    expect(f.frames()).toMatchObject([{ timeoutMs: 5679, command: { identity: operation } }]);
    await f.deliver(1);
    expect(await pending).toEqual({ kind: 'dispatched' });
    expect(f.execute.mock.calls[0]![0]).toEqual(dispatch);
    expect(f.writer.bufferedBytes).toBe(0);
    expect(f.native.close).not.toHaveBeenCalled();
  } finally { await f.close(); }
});

test('production limits deliver a full channel reply burst without dropping replies', async () => {
  const f = fixture(NODE_WORKER_WRITER_LIMITS);
  const total = NODE_WORKER_EXECUTION_LIMITS.maxRequests + NODE_WORKER_EXECUTION_LIMITS.reservedControlRequests;
  try {
    for (let requestId = 1; requestId <= total; requestId += 1) {
      expect(f.transport.send(serializeNodeExecutionReply({ type: 'node-execution-result', version: 1,
        session, requestId, result: { kind: 'status', receipt: null } }))).toBe(true);
    }
    const pulse = f.writer.send('pulse', 'control', 'lifecycle');
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
    const hold = f.writer.send('hold', 'data', 'data');
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
    const hold = f.writer.send('hold', 'data', 'data');
    const first = f.client.call(dispatch, new AbortController().signal);
    f.connection.abort();
    expect(await first).toEqual({ kind: 'unknown' });
    await f.deliver(0); await hold;
    expect(f.frames()).toEqual([]);
    const next = f.writer.send('next', 'control', 'lifecycle');
    await f.deliver(1); await next;
    expect(f.native.close).not.toHaveBeenCalled();
    expect(f.writer.bufferedBytes).toBe(0);
  } finally { await f.close(); }
});

test('worker queue capacity rejects only the definitely unsent call and leaves no later cancellation', async () => {
  const f = fixture();
  const cancellation = new AbortController();
  try {
    const fills = Array.from({ length: 4 }, () => f.writer.send('fill', 'control', 'lifecycle'));
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
