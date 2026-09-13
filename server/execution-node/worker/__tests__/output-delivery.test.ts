import { expect, mock, test } from 'bun:test';
import { MAX_NODE_OUTPUT_BYTES, parseNodeOutputText, serializeNodeOutputFrame, type ProducerStreamIdentity } from '@garcon/server-agent-interface';
import { OrderedPublicationIngress } from '../../../execution-nodes/publication-ingress.js';
import { DEFAULT_NODE_REPLAY } from '../../replay-cache.js';
import { NodeWorkerOutputDelivery, type NodeOutputDeliveryAttempt, type NodeOutputDeliveryRecord, type NodeWorkerOutputDeliveryOptions } from '../output-delivery.js';
import { session, tick } from './lifecycle-fixture.js';
import { parseNodeWorkerServiceText, serializeNodeWorkerService } from '../service-protocol.js';

const stream = { ...session, streamId: 'synthetic-stream' };
const siblingStream = { ...session, streamId: 'synthetic-sibling' };
const record = (identity: ProducerStreamIdentity, sequence: number) => serializeNodeOutputFrame({ type: 'node-output', stream: identity, sequence,
  event: { type: 'notice', runId: 'synthetic-run', content: `synthetic-${sequence}` } });

function fixture(settings: Pick<Partial<NodeWorkerOutputDeliveryOptions>, 'replay' | 'limits'> = {}) {
  const lifetime = new AbortController();
  let now = 0;
  const timers: { callback(): void; cancelled: boolean }[] = [];
  const disconnected = mock((_error: unknown) => {}); const failed = mock((_error: unknown) => {});
  const delivery = new NodeWorkerOutputDelivery({ session, instanceIds: new Set([stream, siblingStream].map((stream) => `instance-${stream.streamId}`)),
    signal: lifetime.signal, replay: { ...DEFAULT_NODE_REPLAY, maxAgeMs: 100 },
    now: () => now, validate() {}, disconnected, failed, ...settings,
    scheduleTimeout(callback) { const timer = { callback, cancelled: false }; timers.push(timer); return { cancel() { timer.cancelled = true; } }; },
  });
  const written: { record: NodeOutputDeliveryRecord; attempt: NodeOutputDeliveryAttempt; progress(): void; finished: PromiseWithResolvers<void> }[] = [];
  const sender = (record: NodeOutputDeliveryRecord, attempt: NodeOutputDeliveryAttempt, progress: () => void) => {
    const finished = Promise.withResolvers<void>();
    written.push({ record, attempt, progress, finished });
    const signal = AbortSignal.any([record.signal, attempt.signal]);
    const abort = () => finished.reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    return finished.promise.finally(() => signal.removeEventListener('abort', abort));
  };
  const install = (identity = stream) => {
    const cancellation = new AbortController(); const failure = mock((_error: unknown) => {});
    delivery.install(`instance-${identity.streamId}`, identity, cancellation.signal, failure);
    return { cancellation, failure, emit: (sequence: number) => delivery.accept(identity, record(identity, sequence), sequence) };
  };
  const live = async (streams = [stream]) => {
    const attempt = delivery.beginRecovery(sender);
    await delivery.replay(attempt, streams.map((stream) => ({ stream, afterSequence: 0 })));
    expect(delivery.resumeLive(attempt)).toBe(true);
    return attempt;
  };
  return { delivery, lifetime, written, timers, failed, disconnected, install, live, sender,
    advance(ms: number) { now += ms; },
    async drain(index: number) { written[index]!.finished.resolve(); await tick(); },
  };
}

test('physical suspension drops the aggregate live FIFO while preserving the session cache', async () => {
  const f = fixture(); const owner = f.install();
  try {
    const attempt = await f.live();
    owner.emit(1); owner.emit(2);
    expect(f.written).toHaveLength(0); expect(f.delivery.bufferedRecords).toBe(2);
    await tick(); expect(f.written).toHaveLength(1);
    const retained = f.delivery.retainedBytes;
    expect(f.delivery.suspend(attempt)).toBe(true);
    expect(attempt.signal.aborted).toBe(true);
    expect(f.delivery.bufferedRecords).toBe(0); expect(f.delivery.bufferedBytes).toBe(0);
    expect(f.delivery.retainedBytes).toBe(retained);
    await tick(); expect(f.written).toHaveLength(1);
    expect(owner.failure).not.toHaveBeenCalled(); expect(f.disconnected).not.toHaveBeenCalled();
  } finally { f.delivery.close(); }
});

test('live progress extends queued delivery without extending replay retention', async () => {
  const f = fixture({ limits: { retentionMs: 100 } });
  const owner = f.install();
  const sibling = f.install(siblingStream);
  try {
    await f.live([stream, siblingStream]);
    owner.emit(1); sibling.emit(1);
    await tick();
    for (let index = 0; index < 3; index++) {
      f.advance(60);
      f.written[0]!.progress();
      f.delivery.prune();
      expect(owner.failure).not.toHaveBeenCalled();
      expect(sibling.failure).not.toHaveBeenCalled();
      expect(f.delivery.bufferedRecords).toBe(2);
    }
    expect(f.delivery.retainedBytes).toBe(0);
    await f.drain(0);
    expect(f.written[1]!.record.stream).toEqual(siblingStream);
    f.advance(60);
    await f.drain(1);
    expect(f.delivery.bufferedBytes).toBe(0);
    expect(f.disconnected).not.toHaveBeenCalled();
    expect(f.failed).not.toHaveBeenCalled();
  } finally { f.delivery.close(); }
});

test('a late progress callback cannot revive expired delivery', async () => {
  const f = fixture({ limits: { retentionMs: 100 } });
  const owner = f.install();
  try {
    await f.live();
    owner.emit(1); await tick();
    f.advance(100);
    f.written[0]!.progress();
    await tick();
    expect(owner.failure).toHaveBeenCalledWith(expect.objectContaining({ code: 'NODE_WORKER_TIMEOUT' }));
    expect(f.delivery.bufferedRecords).toBe(0);
  } finally { f.delivery.close(); }
});

test('progress from a suspended attempt cannot extend its replacement delivery', async () => {
  const f = fixture({ limits: { retentionMs: 100 } });
  const owner = f.install();
  try {
    const original = await f.live();
    owner.emit(1); await tick();
    f.advance(50);
    f.delivery.suspend(original);
    const replacement = f.delivery.beginRecovery(f.sender);
    await f.delivery.replay(replacement, [{ stream, afterSequence: 1 }]);
    expect(f.delivery.resumeLive(replacement)).toBe(true);
    owner.emit(2); await tick();
    f.advance(60);
    f.written[0]!.progress();
    f.advance(40); f.delivery.prune();
    await tick();
    expect(owner.failure).toHaveBeenCalledWith(expect.objectContaining({ code: 'NODE_WORKER_TIMEOUT' }));
    expect(f.delivery.bufferedRecords).toBe(0);
  } finally { f.delivery.close(); }
});

test('live delivery admits a near-maximum row and terminal while the first send remains charged', async () => {
  const f = fixture(); const owner = f.install();
  const content = '界'.repeat(Math.floor((MAX_NODE_OUTPUT_BYTES - 8192) / 3));
  const row = serializeNodeOutputFrame({ type: 'node-output', stream, sequence: 1, event: { type: 'rows',
    rows: [{ message: { type: 'assistant-message', timestamp: '2026-09-09T00:00:00.000Z', content }, providerMeta: null }] } });
  const terminal = serializeNodeOutputFrame({ type: 'node-output', stream, sequence: 2, event: {
    type: 'run-ended', runId: 'synthetic-run', outcome: 'finished', finalResponse: { type: 'text', text: content } } });
  const rowBytes = Buffer.byteLength(row); const terminalBytes = Buffer.byteLength(terminal);
  try {
    expect(rowBytes).toBeLessThanOrEqual(MAX_NODE_OUTPUT_BYTES); expect(terminalBytes).toBeLessThanOrEqual(MAX_NODE_OUTPUT_BYTES);
    expect(rowBytes + terminalBytes).toBeGreaterThan(24 * 1024 * 1024);
    expect(rowBytes + terminalBytes).toBeLessThanOrEqual(2 * MAX_NODE_OUTPUT_BYTES);
    await f.live(); f.delivery.accept(stream, row, 1); await tick();
    expect(f.written).toHaveLength(1);
    f.delivery.accept(stream, terminal, 2);
    expect(f.delivery.bufferedRecords).toBe(2); expect(f.delivery.bufferedBytes).toBe(rowBytes + terminalBytes);
    await f.drain(0); await f.drain(1);
    expect(f.written.map(({ record }) => record.serialized)).toEqual([row, terminal]);
    expect(f.delivery.bufferedBytes).toBe(0);
    expect(owner.failure).not.toHaveBeenCalled(); expect(f.failed).not.toHaveBeenCalled(); expect(f.disconnected).not.toHaveBeenCalled();
  } finally { f.delivery.close(); }
});

test('recovery sends only the captured watermark, then reads the suffix from the cache before live admission', async () => {
  const f = fixture(); const owner = f.install();
  try {
    owner.emit(1); owner.emit(2);
    const attempt = f.delivery.beginRecovery(f.sender);
    const replay = f.delivery.replay(attempt, [{ stream, afterSequence: 0 }]);
    owner.emit(3);
    expect(f.delivery.bufferedBytes).toBe(0);
    expect(f.written.map(({ record }) => record.sequence)).toEqual([1]);
    await f.drain(0); await f.drain(1);
    expect(await replay).toEqual([{ type: 'node-replay-ready', stream, afterSequence: 0, throughSequence: 2 }]);
    expect(f.delivery.resumeLive(attempt)).toBe(false);
    const suffix = f.delivery.replay(attempt, [{ stream, afterSequence: 2 }]);
    await f.drain(2); await suffix;
    expect(f.delivery.resumeLive(attempt)).toBe(true);
    owner.emit(4); await tick(); await f.drain(3);
    expect(f.written.map(({ record }) => record.sequence)).toEqual([1, 2, 3, 4]);
    expect(f.written.every(({ record }) => record.serialized === serializeNodeOutputFrame(parseNodeOutputText(record.serialized)!))).toBe(true);
  } finally { f.delivery.close(); }
});

test('cache eviction during replay retires only the missing stream and does not bypass the gap with transit bytes', async () => {
  const f = fixture(); const owner = f.install(); const sibling = f.install(siblingStream);
  try {
    owner.emit(1); owner.emit(2); f.advance(50); sibling.emit(1);
    const attempt = f.delivery.beginRecovery(f.sender);
    const replay = f.delivery.replay(attempt, [{ stream, afterSequence: 0 }, { stream: siblingStream, afterSequence: 0 }]);
    f.advance(50); await f.drain(0);
    expect(f.written).toHaveLength(2);
    expect(f.written[1]!.record.stream).toEqual(siblingStream);
    await f.drain(1);
    expect(await replay).toEqual([
      { type: 'node-replay-gap', stream, requestedAfter: 1, firstRetainedSequence: 3, lastProducedSequence: 2 },
      { type: 'node-replay-ready', stream: siblingStream, afterSequence: 0, throughSequence: 1 },
    ]);
    expect(owner.failure).toHaveBeenCalledWith(expect.objectContaining({ code: 'NODE_REPLAY_GAP' }));
    expect(sibling.failure).not.toHaveBeenCalled(); expect(f.delivery.resumeLive(attempt)).toBe(true);
  } finally { f.delivery.close(); }
});

test('disabled replay retains bounded live delivery and reports missing output after suspension', async () => {
  const f = fixture({ replay: { ...DEFAULT_NODE_REPLAY, enabled: false } }); const owner = f.install();
  try {
    const attempt = await f.live(); owner.emit(1); await tick();
    expect(f.delivery.retainedBytes).toBe(0); expect(f.delivery.bufferedBytes).toBe(Buffer.byteLength(record(stream, 1)));
    f.delivery.suspend(attempt);
    const replacement = f.delivery.beginRecovery(f.sender);
    expect(await f.delivery.replay(replacement, [{ stream, afterSequence: 0 }])).toEqual([
      { type: 'node-replay-gap', stream, requestedAfter: 0, firstRetainedSequence: 2, lastProducedSequence: 1 },
    ]);
    expect(owner.failure).toHaveBeenCalledTimes(1);
  } finally { f.delivery.close(); }
});

test('lost ACK redelivery publishes through ingress once and the relayed ACK releases the cache prefix', async () => {
  const f = fixture(); const owner = f.install(); const published: unknown[] = [];
  const ingress = new OrderedPublicationIngress({ stream, sink: { publish: (event) => published.push(event) },
    permission() { throw new Error('Unexpected permission'); } });
  let acknowledge = false;
  const sender = async (record: NodeOutputDeliveryRecord, attempt: NodeOutputDeliveryAttempt) => {
    const result = ingress.receive(parseNodeOutputText(record.serialized)!);
    expect(result.kind).toBe('ack');
    if (acknowledge && result.kind === 'ack') f.delivery.acknowledge(attempt, result.ack);
  };
  try {
    const attempt = f.delivery.beginRecovery(sender);
    await f.delivery.replay(attempt, [{ stream, afterSequence: 0 }]); f.delivery.resumeLive(attempt);
    owner.emit(1); await tick(); expect(published).toHaveLength(1); expect(f.delivery.retainedBytes).toBeGreaterThan(0);
    f.delivery.suspend(attempt); acknowledge = true;
    const recovery = f.delivery.beginRecovery(sender);
    await f.delivery.replay(recovery, [{ stream, afterSequence: 0 }]);
    expect(f.delivery.resumeLive(recovery)).toBe(true);
    expect(published).toHaveLength(1); expect(f.delivery.retainedBytes).toBe(0);
    owner.emit(2); await tick(); expect(published).toHaveLength(2); expect(f.delivery.retainedBytes).toBe(0);
  } finally { f.delivery.close(); }
});

test('old completions and ACKs cannot complete or suspend a replacement delivery attempt', async () => {
  const f = fixture(); const owner = f.install(); const oldWrite = Promise.withResolvers<void>();
  try {
    owner.emit(1);
    const old = f.delivery.beginRecovery(() => oldWrite.promise);
    const pending = f.delivery.replay(old, [{ stream, afterSequence: 0 }]);
    const current = f.delivery.beginRecovery(f.sender);
    const replay = f.delivery.replay(current, [{ stream, afterSequence: 0 }]);
    expect(f.delivery.suspend(old)).toBe(false);
    expect(f.delivery.resumeLive(old)).toBe(false);
    expect(f.delivery.acknowledge(old, { type: 'node-output-ack', stream, throughSequence: 1 })).toBe(false);
    await f.drain(0); await replay;
    oldWrite.resolve(); expect(await pending).toBeNull();
    expect(f.delivery.resumeLive(current)).toBe(true); expect(current.signal.aborted).toBe(false);
  } finally { oldWrite.resolve(); f.delivery.close(); }
});

test('live FIFO overflow retires its source synchronously while a neighboring stream drains', async () => {
  const f = fixture({ limits: { maxRecords: 1 } }); const owner = f.install(); const sibling = f.install(siblingStream);
  sibling.failure.mockImplementation(() => { expect(() => sibling.emit(1)).toThrow(); });
  try {
    await f.live([stream, siblingStream]); owner.emit(1);
    expect(() => sibling.emit(1)).toThrow(); expect(sibling.failure).toHaveBeenCalledTimes(1);
    expect(f.delivery.bufferedRecords).toBe(1);
    expect(() => f.install(siblingStream)).toThrow();
    await tick(); await f.drain(0);
    owner.emit(2); await tick(); await f.drain(1);
    expect(owner.failure).not.toHaveBeenCalled(); expect(f.disconnected).not.toHaveBeenCalled();
  } finally { f.delivery.close(); }
});

test('stream retirement cancels its in-flight record without disconnecting its sibling', async () => {
  const f = fixture(); const owner = f.install(); const sibling = f.install(siblingStream);
  try {
    await f.live([stream, siblingStream]); owner.emit(1); sibling.emit(1); await tick();
    owner.cancellation.abort(); await tick();
    expect(f.written[0]!.record.signal.aborted).toBe(true);
    expect(f.written[1]!.record.stream).toEqual(siblingStream);
    await f.drain(1); expect(f.delivery.bufferedBytes).toBe(0);
    expect(owner.failure).not.toHaveBeenCalled(); expect(sibling.failure).not.toHaveBeenCalled();
    expect(f.disconnected).not.toHaveBeenCalled();
  } finally { f.delivery.close(); }
});

test('a blocked live record expires without retaining a native send or failing a newer stream', async () => {
  const f = fixture({ limits: { retentionMs: 100 } }); const owner = f.install(); const sibling = f.install(siblingStream);
  try {
    await f.live([stream, siblingStream]); owner.emit(1); await tick();
    f.advance(50); sibling.emit(1); f.advance(50);
    for (const timer of [...f.timers]) if (!timer.cancelled) timer.callback();
    await tick(); expect(f.written[1]!.record.stream).toEqual(siblingStream);
    await f.drain(1);
    expect(owner.failure).toHaveBeenCalledWith(expect.objectContaining({ code: 'NODE_WORKER_TIMEOUT' }));
    expect(sibling.failure).not.toHaveBeenCalled(); expect(f.disconnected).not.toHaveBeenCalled();
  } finally { f.delivery.close(); }
});

test('a failing physical sender suspends delivery while leaving logical output and cached history usable', async () => {
  const f = fixture(); const owner = f.install();
  try {
    const attempt = await f.live(); owner.emit(1); await tick();
    f.written[0]!.finished.reject(new Error('Synthetic socket failure')); await tick();
    expect(attempt.signal.aborted).toBe(true); expect(f.delivery.bufferedBytes).toBe(0);
    expect(f.delivery.retainedBytes).toBeGreaterThan(0);
    owner.emit(2);
    expect(owner.failure).not.toHaveBeenCalled(); expect(f.disconnected).toHaveBeenCalledTimes(1);
    expect(f.written).toHaveLength(1);
  } finally { f.delivery.close(); }
});

test('an empty stream installed during recovery does not stall an already recovered session', async () => {
  const f = fixture(); f.install();
  try {
    const attempt = f.delivery.beginRecovery(f.sender);
    await f.delivery.replay(attempt, [{ stream, afterSequence: 0 }]);
    const neighbor = f.install(siblingStream);
    expect(f.delivery.resumeLive(attempt)).toBe(true);
    neighbor.emit(1); await tick(); await f.drain(0);
    expect(f.written[0]!.record.stream).toEqual(siblingStream);
  } finally { f.delivery.close(); }
});

test('a retired cursor returns its exact gap while a healthy sibling completes the same recovery round', async () => {
  const f = fixture(); const owner = f.install(); const neighbor = f.install(siblingStream);
  try {
    owner.emit(1); owner.emit(2); neighbor.emit(1); owner.cancellation.abort();
    const attempt = f.delivery.beginRecovery(f.sender);
    const replay = f.delivery.replay(attempt, [{ stream, afterSequence: 1 }, { stream: siblingStream, afterSequence: 0 }]);
    void replay.catch(() => {});
    await tick();
    expect(f.written).toHaveLength(1); await f.drain(0);
    expect(await replay).toEqual([
      { type: 'node-replay-gap', stream, requestedAfter: 1, firstRetainedSequence: 3, lastProducedSequence: 2 },
      { type: 'node-replay-ready', stream: siblingStream, afterSequence: 0, throughSequence: 1 },
    ]);
    expect(f.delivery.resumeLive(attempt)).toBe(true); expect(neighbor.failure).not.toHaveBeenCalled();
  } finally { f.delivery.close(); }
});

test('an ACK arriving after stream retirement is inert on the current physical attempt', async () => {
  const f = fixture(); const owner = f.install();
  try {
    const attempt = await f.live(); owner.emit(1); await tick(); await f.drain(0);
    owner.cancellation.abort();
    expect(f.delivery.acknowledge(attempt, { type: 'node-output-ack', stream, throughSequence: 1 })).toBe(false);
    expect(f.disconnected).not.toHaveBeenCalled(); expect(f.failed).not.toHaveBeenCalled();
  } finally { f.delivery.close(); }
});

test('invalid live cursors and unknown ACKs fail with a private protocol error', async () => {
  const f = fixture(); f.install();
  try {
    const attempt = f.delivery.beginRecovery(f.sender);
    await expect(f.delivery.replay(attempt, [{ stream, afterSequence: 1 }])).rejects.toMatchObject({ code: 'NODE_WORKER_PROTOCOL' });
    expect(() => f.delivery.acknowledge(attempt, { type: 'node-output-ack', stream: siblingStream, throughSequence: 0 }))
      .toThrow('NODE_WORKER_PROTOCOL');
  } finally { f.delivery.close(); }
});

test('output installation rejects unconfigured instances before consuming a stream identity', () => {
  const f = fixture();
  try {
    expect(() => f.delivery.install('unconfigured-instance', stream, f.lifetime.signal, () => {})).toThrow('NODE_WORKER_PROTOCOL');
    expect(() => f.install()).not.toThrow();
  } finally { f.delivery.close(); }
});

test.each([0, 2])('retired output caught up at sequence %d returns an encodable empty replay range', async (produced) => {
  const f = fixture(); const owner = f.install();
  try {
    for (let sequence = 1; sequence <= produced; sequence++) owner.emit(sequence);
    owner.cancellation.abort();
    const attempt = f.delivery.beginRecovery(f.sender);
    const ranges = await f.delivery.replay(attempt, [{ stream, afterSequence: produced }]);
    expect(ranges).toEqual([{ type: 'node-replay-ready', stream, afterSequence: produced, throughSequence: produced }]);
    const result = { kind: 'output-replayed', ranges: ranges! } as const;
    expect(parseNodeWorkerServiceText(serializeNodeWorkerService({ type: 'node-worker-service-result', version: 1,
      session, connectionId: 1, requestId: 1, result }))).toMatchObject({ result });
    expect(f.delivery.resumeLive(attempt)).toBe(true);
  } finally { f.delivery.close(); }
});

test('ACK cursors beyond produced output use the private protocol error', async () => {
  const f = fixture(); const owner = f.install();
  try {
    owner.emit(1); const attempt = f.delivery.beginRecovery(f.sender);
    for (const throughSequence of [-1, 0.5, 2, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => f.delivery.acknowledge(attempt, { type: 'node-output-ack', stream, throughSequence })).toThrow('NODE_WORKER_PROTOCOL');
    }
  } finally { f.delivery.close(); }
});
