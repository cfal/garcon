import { expect, mock, test } from 'bun:test';
import { MAX_NODE_OUTPUT_BYTES, parseNodeOutputText, type AgentProducerEvent } from '@garcon/server-agent-interface';
import { AssistantMessage, BashToolUseMessage } from '../../../../common/chat-types.js';
import type { NodeOutputPermissionHandles } from '../../output-encoder.js';
import { NodeWorkerOutputPort, type NodeWorkerOutputPortOptions } from '../output-port.js';
import { parseNodeWorkerOutputRetirementText, serializeNodeWorkerOutputRetirement } from '../output-retirement.js';
import { parseNodeWorkerOutputText } from '../output-protocol.js';
import { NODE_WORKER_WRITER_LIMITS } from '../limits.js';
import { NodeWorkerWriter, type NodeWorkerSubmission } from '../writer.js';
import { session } from './lifecycle-fixture.js';

const stream = { ...session, streamId: 'synthetic-first' };
const event = (content = '界'.repeat(30_000)): AgentProducerEvent => ({ type: 'rows',
  rows: [{ message: new AssistantMessage('2026-09-09T00:00:00.000Z', content) }] });
const permission: AgentProducerEvent = {
  type: 'permission', runId: 'synthetic-run',
  lifecycle: { kind: 'requested', permissionOccurrenceId: '00000000-0000-4000-8000-000000000001',
    requestedTool: new BashToolUseMessage('2026-09-09T00:00:00.000Z', 'synthetic-tool', 'pwd'), options: [{ id: 'allow', label: 'Allow' }] },
  decision: { permissionOccurrenceId: '00000000-0000-4000-8000-000000000001', async respond() {} },
};

function fixture(limits: NodeWorkerOutputPortOptions['limits'] = {}) {
  const lifetime = new AbortController();
  let now = 0;
  let validate = () => {};
  const written: { text: string; bytes: Uint8Array; finished: PromiseWithResolvers<void> }[] = [];
  const submissions: NodeWorkerSubmission[] = [];
  const timers: { callback(): void; cancelled: boolean }[] = [];
  const failed = mock((_error: unknown) => {});
  const writer = new NodeWorkerWriter({
    write(bytes) {
      const finished = Promise.withResolvers<void>();
      written.push({ text: Buffer.from(bytes.subarray(4)).toString(), bytes, finished });
      return finished.promise;
    }, close() { for (const write of written) write.finished.resolve(); },
  }, { ...NODE_WORKER_WRITER_LIMITS, signal: lifetime.signal, scheduleTimeout: () => ({ cancel() {} }), failed });
  const port = new NodeWorkerOutputPort({ submit(...args) {
    const submission = writer.submit(...args); submissions.push(submission); return submission;
  } }, { session, instanceId: 'synthetic-instance', signal: lifetime.signal, now: () => now, validate: () => validate(), limits,
    scheduleTimeout(callback) {
      const timer = { callback, cancelled: false }; timers.push(timer);
      return { cancel() { timer.cancelled = true; } };
    }, failed });
  const install = (streamId = stream.streamId) => {
    let nextHandle = 0;
    const handles = new Set<string>();
    const permissionHandles = { createHandle: () => `synthetic-handle-${++nextHandle}`,
      register(_stream, handle) { handles.add(handle); }, retire() { handles.clear(); },
    } satisfies NodeOutputPermissionHandles;
    const cancellation = new AbortController();
    const failure = mock((_error: unknown) => {});
    const output = port.install({ ...stream, streamId }, cancellation.signal, permissionHandles, failure);
    return { output, failure, cancellation, handles, permissionHandles };
  };
  return { port, writer, written, submissions, timers, failed, lifetime, install,
    advance(ms: number) { now += ms; }, validating(callback: () => void) { validate = callback; },
    async drain(index: number) { written[index]!.finished.resolve(); await submissions[index]!.drained; await Promise.resolve(); },
    close() { port.close(); writer.close(); },
  };
}

test('synchronous emission snapshots bytes and permissions before writing any lazy chunks', async () => {
  const f = fixture();
  const owner = f.install();
  try {
    const original = event('synthetic original');
    owner.output.emit(original); owner.output.forOperation(() => true).emit(permission);
    expect(f.written).toHaveLength(0);
    expect(owner.handles.size).toBe(1);
    expect(owner.output.producedSequence).toBe(2);
    if (original.type === 'rows' && original.rows[0]!.message instanceof AssistantMessage) original.rows[0]!.message.content = 'changed';
    await Promise.resolve();
    expect(f.written).toHaveLength(1);
    const first = parseNodeWorkerOutputText(f.written[0]!.text)!;
    expect(parseNodeOutputText(Buffer.from(first.chunk.data, 'base64').toString())).toMatchObject({ sequence: 1,
      event: { rows: [{ message: { content: 'synthetic original' } }] } });
    await f.drain(0); await f.drain(1);
    expect(f.port.bufferedBytes).toBe(0);
    expect(f.port.bufferedRecords).toBe(0);
  } finally { f.close(); }
});

test('a near-maximum row and matching terminal are admitted synchronously before any chunk drains', async () => {
  const f = fixture(); const owner = f.install();
  const content = '界'.repeat(Math.floor((MAX_NODE_OUTPUT_BYTES - 8192) / 3));
  try {
    owner.output.emit(event(content));
    const rowBytes = f.port.bufferedBytes;
    owner.output.emit({ type: 'run-ended', runId: 'synthetic-run', outcome: 'finished', finalResponse: { type: 'text', text: content } });
    const combined = f.port.bufferedBytes;
    expect(rowBytes).toBeLessThanOrEqual(MAX_NODE_OUTPUT_BYTES);
    expect(combined - rowBytes).toBeLessThanOrEqual(MAX_NODE_OUTPUT_BYTES);
    expect(combined).toBeGreaterThan(24 * 1024 * 1024);
    expect(combined).toBeLessThanOrEqual(2 * MAX_NODE_OUTPUT_BYTES);
    expect(f.port.bufferedRecords).toBe(2); expect(owner.output.producedSequence).toBe(2);
    expect(f.written).toHaveLength(0); expect(owner.output.retired).toBe(false);
    await Promise.resolve();
    expect(f.written).toHaveLength(1);
    expect(parseNodeWorkerOutputText(f.written[0]!.text)!.descriptor.byteLength).toBe(rowBytes);
    expect(f.port.bufferedBytes).toBe(combined);
    expect(owner.failure).not.toHaveBeenCalled(); expect(f.failed).not.toHaveBeenCalled();
  } finally { f.close(); }
});

test('one outstanding chunk leaves lifecycle frames ahead of the rest of the record and preserves FIFO order', async () => {
  const f = fixture(); const first = f.install(); const second = f.install('synthetic-second');
  try {
    first.output.emit(event()); second.output.emit(event('synthetic sibling'));
    await Promise.resolve();
    expect(f.submissions).toHaveLength(1);
    const pulse = f.writer.send('synthetic pulse', 'control', 'lifecycle');
    f.written[0]!.finished.resolve(); await f.submissions[0]!.drained;
    expect(f.written[1]!.text).toBe('synthetic pulse');
    f.written[1]!.finished.resolve(); await pulse;
    expect(f.written).toHaveLength(3);
    f.written[2]!.finished.resolve(); await f.submissions[1]!.drained; await Promise.resolve();
    expect(parseNodeWorkerOutputText(f.written[3]!.text)!.stream.streamId).toBe('synthetic-second');
    f.written[3]!.finished.resolve(); await f.submissions[2]!.drained; await Promise.resolve();
    expect(f.port.bufferedBytes).toBe(0);
    expect(first.failure).not.toHaveBeenCalled(); expect(second.failure).not.toHaveBeenCalled();
  } finally { f.close(); }
});

test.each(['bytes', 'count'] as const)('%s overflow synchronously retires only the refused stream without a sequence hole', async (limit) => {
  const f = fixture(limit === 'bytes' ? { maxBytes: 1000 } : { maxRecords: 1 });
  const first = f.install(); const second = f.install('synthetic-second');
  try {
    first.output.emit(event('small'));
    expect(() => second.output.emit(limit === 'bytes' ? event() : permission)).toThrow();
    expect(second.output.producedSequence).toBe(0);
    expect(second.handles.size).toBe(0);
    expect(second.failure).toHaveBeenCalledTimes(1);
    expect(first.output.producedSequence).toBe(1);
    await Promise.resolve();
    expect(parseNodeWorkerOutputRetirementText(f.written[0]!.text)?.stream.streamId).toBe('synthetic-second');
    await f.drain(0); await f.drain(1);
    first.output.emit(event('fresh')); await Promise.resolve(); await f.drain(2);
    expect(first.output.producedSequence).toBe(2);
    expect(first.failure).not.toHaveBeenCalled(); expect(f.failed).not.toHaveBeenCalled();
  } finally { f.close(); }
});

test('retirement observer reentry cannot emit or retain a permission capability', () => {
  const f = fixture({ maxBytes: 100 }); const owner = f.install();
  owner.failure.mockImplementation(() => {
    expect(owner.handles.size).toBe(0);
    expect(() => owner.output.emit(permission)).toThrow('retired');
    owner.output.retire();
  });
  try {
    expect(() => owner.output.emit(permission)).toThrow();
    expect(owner.failure).toHaveBeenCalledTimes(1);
    expect(f.port.bufferedBytes).toBe(0);
  } finally { f.close(); }
});

test('cancellation releases raw records and later chunks while native bytes stay charged until drain', async () => {
  const f = fixture(); const owner = f.install();
  try {
    owner.output.emit(event()); await Promise.resolve();
    const nativeBytes = f.writer.bufferedBytes;
    owner.cancellation.abort();
    await f.submissions[0]!.drained.catch(() => {}); await Promise.resolve();
    expect(f.port.bufferedBytes).toBe(0);
    expect(f.writer.bufferedBytes).toBe(nativeBytes + Buffer.byteLength(serializeNodeWorkerOutputRetirement({
      type: 'node-worker-output-retired', version: 1, instanceId: 'synthetic-instance', stream })) + 4);
    expect(f.written).toHaveLength(1);
    f.written[0]!.finished.resolve(); await Promise.resolve();
    expect(parseNodeWorkerOutputRetirementText(f.written[1]!.text)?.stream).toEqual(stream);
    await f.drain(1);
    expect(f.writer.bufferedBytes).toBe(0);
    expect(owner.failure).not.toHaveBeenCalled();
  } finally { f.close(); }
});

test('queue residence expires during a stalled write without retiring a newer sibling', async () => {
  const f = fixture({ retentionMs: 100 }); const owner = f.install(); const sibling = f.install('synthetic-second');
  try {
    owner.output.emit(event()); await Promise.resolve();
    f.advance(50); sibling.output.emit(event('fresh'));
    f.advance(50); for (const timer of [...f.timers]) if (!timer.cancelled) timer.callback();
    await f.submissions[0]!.drained.catch(() => {}); await Promise.resolve();
    expect(owner.failure).toHaveBeenCalledWith(expect.objectContaining({ code: 'NODE_WORKER_TIMEOUT' }));
    expect(sibling.failure).not.toHaveBeenCalled();
    f.written[0]!.finished.resolve(); await Promise.resolve();
    expect(parseNodeWorkerOutputRetirementText(f.written[1]!.text)?.stream).toEqual(stream);
    await f.drain(1);
    expect(parseNodeWorkerOutputText(f.written[2]!.text)!.stream.streamId).toBe('synthetic-second');
    await f.drain(2);
    expect(f.port.bufferedBytes).toBe(0);
  } finally { f.close(); }
});

test.each(['native failure', 'authority loss'] as const)('%s fences all instance output before notifying observers', async (cause) => {
  const f = fixture(); const first = f.install(); const second = f.install('synthetic-second');
  first.failure.mockImplementation(() => { expect(second.output.retired).toBe(true); });
  try {
    first.output.emit(event()); second.output.emit(permission); await Promise.resolve();
    if (cause === 'native failure') f.written[0]!.finished.reject(new Error('Synthetic pipe failure'));
    else { f.validating(() => { throw new Error('Synthetic lease loss'); }); expect(() => f.port.prune()).toThrow(); }
    await f.submissions[0]!.drained.catch(() => {}); await Promise.resolve();
    expect(first.output.retired).toBe(true); expect(second.output.retired).toBe(true);
    expect(second.handles.size).toBe(0);
    expect(first.failure).toHaveBeenCalledTimes(1); expect(second.failure).toHaveBeenCalledTimes(1);
    expect(f.port.bufferedBytes).toBe(0);
    expect(f.failed).toHaveBeenCalled();
  } finally { f.close(); }
});

test('one maximum-size Unicode record admits without materializing hundreds of writer frames', async () => {
  const f = fixture(); const owner = f.install();
  try {
    const base = event('x'); owner.output.emit(base);
    await Promise.resolve();
    const first = parseNodeWorkerOutputText(f.written[0]!.text)!;
    const overhead = first.descriptor.byteLength - 1;
    await f.drain(0);
    const length = MAX_NODE_OUTPUT_BYTES - overhead;
    const content = '界'.repeat(Math.floor(length / 3)) + 'x'.repeat(length % 3);
    owner.output.emit(event(content));
    expect(f.port.bufferedBytes).toBe(MAX_NODE_OUTPUT_BYTES);
    expect(f.submissions).toHaveLength(1);
    await Promise.resolve();
    expect(f.submissions).toHaveLength(2);
    expect(f.writer.bufferedBytes).toBeLessThan(100_000);
    expect(() => owner.output.emit(event(content + 'x'))).toThrow();
    expect(owner.output.producedSequence).toBe(2);
    expect(owner.output.retired).toBe(true);
  } finally { f.close(); }
});

test('refusing a critical retirement notice fails the entire instance port before sibling output can continue', async () => {
  const f = fixture(); const owner = f.install(); const sibling = f.install('synthetic-second');
  const pending: Promise<unknown>[] = [];
  try {
    owner.output.emit(event()); sibling.output.emit(permission); await Promise.resolve();
    const available = NODE_WORKER_WRITER_LIMITS.maxQueuedFrames - NODE_WORKER_WRITER_LIMITS.reservedControlFrames - NODE_WORKER_WRITER_LIMITS.reservedApplicationFrames - 1;
    for (let i = 0; i < available; i += 1) pending.push(f.writer.send('x', 'data', 'data').catch((error: unknown) => error));
    for (let i = 0; i < 8; i += 1) pending.push(f.writer.send('x', 'urgent', 'application').catch((error: unknown) => error));
    owner.cancellation.abort();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(sibling.output.retired).toBe(true); expect(sibling.handles.size).toBe(0);
    expect(f.failed).toHaveBeenCalledWith(expect.objectContaining({ code: 'NODE_WORKER_CAPACITY' }));
    expect(() => sibling.output.emit(event('late'))).toThrow('retired');
  } finally { f.close(); await Promise.all(pending); }
});

test('a parent retirement cancels only its exact stream and does not echo a control back', async () => {
  const f = fixture(); const owner = f.install(); const sibling = f.install('synthetic-second');
  try {
    const notice = serializeNodeWorkerOutputRetirement({ type: 'node-worker-output-retired', version: 1,
      instanceId: 'synthetic-instance', stream });
    expect(() => f.port.receiveRetirement(notice.replace('synthetic-instance', 'synthetic-other'))).toThrow();
    expect(owner.output.retired).toBe(false);
    f.port.receiveRetirement(notice); f.port.receiveRetirement(notice);
    expect(owner.output.retired).toBe(true); expect(f.submissions).toHaveLength(0);
    expect(sibling.output.retired).toBe(false);
    sibling.output.emit(event('sibling')); await Promise.resolve(); await f.drain(0);
    expect(f.failed).not.toHaveBeenCalled();
  } finally { f.close(); }
});

test('retirement bursts drain ahead of healthy sibling data without filling the urgent queue', async () => {
  const f = fixture({ retentionMs: 100 });
  const owners = Array.from({ length: 100 }, (_, i) => f.install(`synthetic-expiring-${i}`));
  const sibling = f.install('synthetic-fresh');
  try {
    for (const owner of owners) owner.output.emit(event('synthetic queued record'));
    await Promise.resolve();
    f.advance(50); sibling.output.emit(event('synthetic fresh record'));
    f.advance(50); f.port.prune();
    await f.submissions[0]!.drained.catch(() => {}); await Promise.resolve();
    expect(sibling.output.retired).toBe(false); expect(f.failed).not.toHaveBeenCalled();
    expect(f.submissions.length).toBeLessThanOrEqual(2);
    f.written[0]!.finished.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    for (let i = 1; i <= owners.length; i += 1) {
      expect(parseNodeWorkerOutputRetirementText(f.written[i]!.text)).not.toBeNull();
      f.written[i]!.finished.resolve();
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const last = f.written.at(-1)!;
    expect(parseNodeWorkerOutputText(last.text)!.stream.streamId).toBe('synthetic-fresh');
    last.finished.resolve(); await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.port.bufferedBytes).toBe(0); expect(f.writer.bufferedBytes).toBe(0);
    expect(sibling.failure).not.toHaveBeenCalled(); expect(f.failed).not.toHaveBeenCalled();
  } finally { f.close(); }
});
