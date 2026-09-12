import { expect, mock, test } from 'bun:test';
import { NODE_WIRE_VERSION } from '@garcon/server-agent-interface';
import { NodeExecutionClient, NodeExecutionServer } from '../execution-channel.js';
import { NodeBulkChannel } from '../bulk-channel.js';
import { serializeNodeBulkFrame } from '../bulk-channel-wire.js';
import { serializeNodeExecutionCall, type NodeExecutionCommand } from '../execution-wire.js';
import { serializeNodeExecutionReply } from '../execution-receipt-wire.js';
import { NodeSocketWriter, type NodeSocketPort } from '../socket-writer.js';

const session = { controllerBootId: 'synthetic-controller', nodeBootId: 'synthetic-node', logicalSessionId: 'synthetic-session' };
const prepare = { method: 'prepare', location: { nodeId: 'synthetic-node', instanceId: 'synthetic-instance', workspaceId: 'synthetic-workspace' },
  request: { kind: 'start', chatId: '1789000000000001', runId: 'synthetic-run',
    configuration: { model: 'x'.repeat(350), settings: null, endpoint: null } } } satisfies NodeExecutionCommand;

function fixture(maxDrainWaiters = 32) {
  let buffered = 0;
  let maximum = 0;
  const physical = new AbortController();
  const frames: string[] = [];
  const timers: { callback(): void; cancelled: boolean }[] = [];
  const port = { open: true, get bufferedBytes() { return buffered; }, bufferedFrameBytes: (length: number) => length + 4,
    send(text: string) { frames.push(text); buffered += Buffer.byteLength(text) + 4; maximum = Math.max(maximum, buffered); return true; },
    terminate: mock(() => {}),
  } satisfies NodeSocketPort;
  const writer = new NodeSocketWriter(port, { signal: physical.signal, maxFrameBytes: 2048, maxBufferedBytes: 4096,
    reservedControlBytes: 1024, maxDrainWaiters, drainTimeoutMs: 1000, schedulePoll: () => ({ cancel() {} }) });
  const options = { session, signal: physical.signal, validate() { physical.signal.throwIfAborted(); },
    scheduleTimeout(callback: () => void) { const timer = { callback, cancelled: false }; timers.push(timer); return { cancel() { timer.cancelled = true; } }; } };
  return { writer, port, physical, frames, timers, options, buffer(bytes: number) { buffered = bytes; writer.drain(); }, maximum: () => maximum };
}

test('socket capacity refuses only unsent execution calls, preserves pending work, and never cancels a refused request', async () => {
  const f = fixture();
  const client = new NodeExecutionClient(f.writer, f.options);
  try {
    f.buffer(3072);
    const first = client.call(prepare, f.physical.signal);
    const caller = new AbortController();
    expect(await client.call(prepare, caller.signal)).toEqual({ kind: 'rejected', code: 'NODE_CAPACITY' });
    expect(f.frames).toHaveLength(1);
    caller.abort();
    expect(f.frames).toHaveLength(1);
    expect(f.port.terminate).not.toHaveBeenCalled();
    client.receive(serializeNodeExecutionReply({ type: 'node-execution-result', version: NODE_WIRE_VERSION, session, requestId: 1, result: { kind: 'unknown' } }));
    expect(await first).toEqual({ kind: 'unknown' });
    f.buffer(0);
    const next = client.call(prepare, f.physical.signal);
    expect(JSON.parse(f.frames[1]!).requestId).toBe(3);
    f.timers[1]!.callback();
    expect(f.frames).toHaveLength(2);
    client.receive(serializeNodeExecutionReply({ type: 'node-execution-result', version: NODE_WIRE_VERSION, session, requestId: 3, result: { kind: 'unknown' } }));
    expect(await next).toEqual({ kind: 'unknown' });
    expect(f.maximum()).toBeLessThanOrEqual(4096);
  } finally { client.close(); }
});

test('concurrent large calls and repeated timeout cancellation cannot overrun or poison the native socket', async () => {
  const f = fixture();
  const client = new NodeExecutionClient(f.writer, f.options);
  try {
    for (let wave = 0; wave < 4; wave += 1) {
      const pending = Array.from({ length: 40 }, () => client.call(prepare, f.physical.signal));
      for (const timer of f.timers) if (!timer.cancelled) timer.callback();
      const results = await Promise.all(pending);
      expect(results.every((result) => result.kind === 'unknown' || result.kind === 'rejected' && result.code === 'NODE_CAPACITY')).toBe(true);
      expect(results.some((result) => result.kind === 'rejected' && result.code === 'NODE_CAPACITY')).toBe(true);
      expect(f.maximum()).toBeLessThanOrEqual(4096);
      expect(f.port.terminate).not.toHaveBeenCalled();
    }
  } finally { client.close(); }
});

test('a refused execution reply leaves the operation unknown and the physical channel available', async () => {
  const f = fixture();
  const executed = Promise.withResolvers<void>();
  const server = new NodeExecutionServer(f.writer, { async execute() { executed.resolve(); return { kind: 'unknown' }; } }, f.options);
  try {
    f.buffer(4096);
    server.receive(serializeNodeExecutionCall({ type: 'node-execution-request', version: NODE_WIRE_VERSION, session, requestId: 1, command: prepare }));
    await executed.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.frames).toHaveLength(0);
    expect(f.port.terminate).not.toHaveBeenCalled();
    f.buffer(0);
    server.receive(serializeNodeExecutionCall({ type: 'node-execution-request', version: NODE_WIRE_VERSION, session, requestId: 2, command: prepare }));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.frames).toHaveLength(1);
    expect(JSON.parse(f.frames[0]!).requestId).toBe(2);
  } finally { server.close(); }
});

test('a bulk completion reply uses reserved bytes even while outgoing data is saturated', async () => {
  const f = fixture();
  const complete = mock(() => {});
  const channel = new NodeBulkChannel(f.writer, { append() {}, complete, cancel() {} }, f.options);
  try {
    await f.writer.sendWhenWritable('x'.repeat(2048), f.physical.signal, () => {});
    await f.writer.sendWhenWritable('x'.repeat(1016), f.physical.signal, () => {});
    expect(f.port.bufferedBytes).toBe(3072);
    channel.receive(serializeNodeBulkFrame({ type: 'node-bulk-complete', version: NODE_WIRE_VERSION, requestId: 1,
      transfer: { ...session, transferId: 'synthetic-transfer' } }));
    expect(complete).toHaveBeenCalledTimes(1);
    expect(JSON.parse(f.frames[2]!).type).toBe('node-bulk-result');
    expect(f.maximum()).toBeLessThanOrEqual(4096);
    expect(f.port.terminate).not.toHaveBeenCalled();
  } finally { channel.close(); }
});

test('bulk request and waiter exhaustion stay local to the transfer', async () => {
  const f = fixture(1);
  const channel = new NodeBulkChannel(f.writer, { append() {}, complete() {}, cancel() {} }, f.options);
  try {
    f.buffer(4096);
    const transfer = { ...session, transferId: 'synthetic-transfer' };
    await expect(channel.complete(transfer, f.physical.signal)).rejects.toMatchObject({ code: 'NODE_CAPACITY' });
    expect(f.frames).toHaveLength(0);
    const first = channel.sendChunk(JSON.stringify({ type: 'node-bulk-chunk', version: NODE_WIRE_VERSION, transfer,
      offset: 0, data: 'eA==' }), f.physical.signal);
    await expect(channel.sendChunk(JSON.stringify({ type: 'node-bulk-chunk', version: NODE_WIRE_VERSION,
      transfer: { ...transfer, transferId: 'synthetic-other' }, offset: 0, data: 'eA==' }), f.physical.signal))
      .rejects.toMatchObject({ code: 'NODE_CAPACITY' });
    expect(f.port.terminate).not.toHaveBeenCalled();
    f.buffer(0);
    await first;
    expect(f.frames).toHaveLength(1);
  } finally { channel.close(); }
});
