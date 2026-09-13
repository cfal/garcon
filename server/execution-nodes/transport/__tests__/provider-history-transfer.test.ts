import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { AssistantMessage } from '../../../../common/chat-types.js';
import { parseNodeBulkFrameText } from '../bulk-channel-wire.js';
import type { NodeHistoryBulkFrame } from '../provider-history-bulk-wire.js';
import { NodeHistoryBulkSender } from '../provider-history-sender.js';
import { NodeHistoryBulkReceiver } from '../provider-history-receiver.js';
import { NodeHistoryMemoryBudget } from '../provider-history-memory.js';
import { encodeNodeHistoryRow } from '../provider-history-row.js';

const session = { controllerBootId: 'synthetic-controller', nodeBootId: 'synthetic-node', logicalSessionId: 'synthetic-session' };
const target = { identity: { ...session, operationId: '1' }, instanceId: 'synthetic-instance', connectionId: 1,
  bulkAttemptId: '1' };
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });

function fixture() {
  const lifetime = new AbortController();
  const memory = new NodeHistoryMemoryBudget(32 * 1024 * 1024);
  const timers = new Set<() => void>();
  const sent: string[] = [];
  let downstream: (frame: NodeHistoryBulkFrame) => void = (frame) => receiver.receive(frame);
  let upstream: (frame: NodeHistoryBulkFrame) => boolean = (frame) => { sender.receive(frame); return true; };
  const sender = new NodeHistoryBulkSender({
    send: (frame) => { sent.push(parseNodeBulkFrameText(frame.payload)!.type); downstream(frame); return true; },
    sendWhenWritable: async (frame, signal, validate) => {
      signal.throwIfAborted(); validate(); sent.push(parseNodeBulkFrameText(frame.payload)!.type); downstream(frame);
    },
  }, { session, signal: lifetime.signal, memory, limits: { maxTransfers: 1, maxBytes: 2 * 1024 * 1024, maxTransferBytes: 2 * 1024 * 1024 },
    scheduleTimeout(callback) { timers.add(callback); return { cancel: () => timers.delete(callback) }; } });
  const receiver = new NodeHistoryBulkReceiver(memory, { session, authoritySignal: lifetime.signal,
    limits: { maxTransfers: 2, maxBytes: 2 * 1024 * 1024, maxTransferBytes: 2 * 1024 * 1024 } });
  const port = { send: (frame: NodeHistoryBulkFrame) => upstream(frame),
    sendWhenWritable: async (frame: NodeHistoryBulkFrame) => { upstream(frame); } };
  const validate = () => lifetime.signal.throwIfAborted();
  cleanup.push(() => { lifetime.abort(); sender.close(); receiver.close(); });
  function row(content = 'Synthetic history row', sequence = 1) {
    const original = { message: new AssistantMessage('2026-01-01T00:00:00.000Z', content), providerMeta: { sequence } };
    const encoded = encodeNodeHistoryRow(original, memory);
    cleanup.push(() => encoded.release());
    const descriptor = { byteLength: encoded.bytes.byteLength, sha256: createHash('sha256').update(encoded.bytes).digest('hex') };
    const reservation = receiver.reserve(target, sequence, descriptor, port, lifetime.signal, validate);
    const send = (signal = lifetime.signal) => sender.transfer({ ...target, sequence, grant: reservation.grant }, descriptor, encoded.bytes, signal, validate);
    return { original, reservation, send, encoded };
  }
  return { row, sender, receiver, memory, sent, timers, lifetime,
    sendDown: (frame: NodeHistoryBulkFrame) => receiver.receive(frame),
    sendUp: (frame: NodeHistoryBulkFrame) => sender.receive(frame),
    downstream(receive: typeof downstream) { downstream = receive; },
    upstream(receive: typeof upstream) { upstream = receive; },
  };
}

test('a row larger than a control frame crosses credited chunks and reconstructs message classes', async () => {
  const f = fixture(); const r = f.row('Synthetic '.repeat(40_000));
  await r.send(); await r.reservation.verified;
  expect(f.memory.reservedBytes).toBe(2 * r.encoded.bytes.byteLength);
  const decoded = r.reservation.take();
  expect(decoded).toEqual(r.original); expect(decoded.message).toBeInstanceOf(AssistantMessage);
  expect(f.sent.filter((type) => type === 'node-bulk-credit-chunk').length).toBeGreaterThan(1);
  expect(f.sent.at(-1)).toBe('node-bulk-complete');
  expect(f.receiver.reservedBytes).toBe(0); expect(f.receiver.transferCount).toBe(0);
  r.encoded.release(); expect(f.memory.reservedBytes).toBe(0); expect(f.timers.size).toBe(0);
});

test('end-to-end append credit stops the next chunk and shared sender capacity rejects another row', async () => {
  const f = fixture(); const first = f.row('Synthetic '.repeat(20_000)); const second = f.row('Synthetic second', 2);
  let held: NodeHistoryBulkFrame | null = null;
  f.upstream((frame) => { held = frame; return true; });
  const sending = first.send(); await tick();
  expect(f.sent).toEqual(['node-bulk-credit-chunk']);
  await expect(second.send()).rejects.toMatchObject({ code: 'NODE_CAPACITY' });
  expect(f.sent).toEqual(['node-bulk-credit-chunk']);
  f.upstream((frame) => { f.sendUp(frame); return true; }); f.sendUp(held!);
  await sending; expect(first.reservation.take()).toEqual(first.original);
  await second.send(); expect(second.reservation.take()).toEqual(second.original);
});

test('refused ACK admission fails only that transfer on its credit deadline', async () => {
  const f = fixture(); const r = f.row();
  f.upstream((frame) => {
    if (parseNodeBulkFrameText(frame.payload)!.type === 'node-bulk-chunk-ack') return false;
    f.sendUp(frame); return true;
  });
  const sending = r.send().catch((error: unknown) => error); await tick();
  expect(f.timers.size).toBe(1);
  for (const expire of [...f.timers]) expire();
  expect(await sending).toMatchObject({ code: 'NODE_BULK_UNAVAILABLE' });
  await expect(r.reservation.verified).rejects.toThrow();
  expect(f.lifetime.signal.aborted).toBe(false);
  f.upstream((frame) => { f.sendUp(frame); return true; });
  const next = f.row('Synthetic next', 2); await next.send(); expect(next.reservation.take()).toEqual(next.original);
});

test('a lost completion reply leaves verification distinct from sender completion', async () => {
  const f = fixture(); const r = f.row();
  f.upstream((frame) => {
    const payload = parseNodeBulkFrameText(frame.payload)!;
    if (payload.type !== 'node-bulk-result' || payload.command !== 'node-bulk-complete') f.sendUp(frame);
    return true;
  });
  let completed = false;
  const sending = r.send().then(() => { completed = true; }, (error: unknown) => error);
  await r.reservation.verified; await tick();
  expect(f.memory.reservedBytes).toBe(3 * r.encoded.bytes.byteLength);
  expect(completed).toBe(false); expect(f.receiver.reservedBytes).toBeGreaterThan(0);
  for (const expire of [...f.timers]) expire();
  expect(await sending).toMatchObject({ code: 'NODE_BULK_UNAVAILABLE' });
  expect(f.memory.reservedBytes).toBe(r.encoded.bytes.byteLength);
  expect(f.receiver.reservedBytes).toBe(0); expect(completed).toBe(false);
  r.reservation.close(); expect(f.receiver.reservedBytes).toBe(0);
});

test('same-grant stale import and bulk-attempt envelopes cannot append or acknowledge a current row', async () => {
  const f = fixture(); const r = f.row();
  let chunk: NodeHistoryBulkFrame | null = null;
  let ack: NodeHistoryBulkFrame | null = null;
  f.downstream((frame) => { chunk = frame; });
  f.upstream((frame) => { ack = frame; return true; });
  const sending = r.send(); await tick();
  f.sendDown({ ...chunk!, bulkAttemptId: '9' });
  f.sendDown({ ...chunk!, identity: { ...target.identity, operationId: '9' } });
  expect(ack).toBeNull();
  f.sendDown(chunk!); expect(ack).not.toBeNull();
  f.sendUp({ ...ack!, bulkAttemptId: '9' }); await tick();
  expect(f.sent).toEqual(['node-bulk-credit-chunk']);
  f.downstream((frame) => f.sendDown(frame)); f.upstream((frame) => { f.sendUp(frame); return true; });
  f.sendUp(ack!); await sending;
  expect(r.reservation.take()).toEqual(r.original);
});

test('corrupt encoded bytes fail hash verification without yielding a normalized row', async () => {
  const f = fixture(); const r = f.row();
  const cancellation = Promise.withResolvers<void>();
  f.downstream((frame) => {
    const payload = parseNodeBulkFrameText(frame.payload)!;
    if (payload.type === 'node-bulk-credit-chunk') {
      const bytes = Buffer.from(payload.data, 'base64'); bytes[0] = bytes[0]! ^ 1;
      f.sendDown({ ...frame, payload: JSON.stringify({ ...payload, data: bytes.toString('base64') }) });
    } else {
      f.sendDown(frame);
      if (payload.type === 'node-bulk-cancel') cancellation.resolve();
    }
  });
  const sending = r.send().catch((error: unknown) => error);
  await expect(r.reservation.verified).rejects.toThrow();
  await cancellation.promise;
  expect(f.receiver.reservedBytes).toBe(0);
  expect(f.memory.reservedBytes).toBe(2 * r.encoded.bytes.byteLength);
  expect(f.timers.size).toBe(1);
  for (const expire of [...f.timers]) expire();
  expect(await sending).toMatchObject({ code: 'NODE_BULK_INVALID' });
  expect(f.memory.reservedBytes).toBe(r.encoded.bytes.byteLength);
  expect(() => r.reservation.take()).toThrow(); expect(f.receiver.reservedBytes).toBe(0);
  expect(f.lifetime.signal.aborted).toBe(false);
});

test('sender upload snapshot shares encoder credit and returns it on caller cancellation', async () => {
  const f = fixture(); const r = f.row();
  const caller = new AbortController();
  const chunk = Promise.withResolvers<void>();
  f.downstream(() => chunk.resolve());
  const sending = r.send(caller.signal).catch((error: unknown) => error);
  await chunk.promise;
  expect(f.memory.reservedBytes).toBe(3 * r.encoded.bytes.byteLength);
  const reason = new Error('Synthetic transfer cancellation');
  caller.abort(reason);
  expect(await sending).toBe(reason);
  expect(f.memory.reservedBytes).toBe(2 * r.encoded.bytes.byteLength);
  r.reservation.close(); r.encoded.release();
  expect(f.memory.reservedBytes).toBe(0);
  expect(f.lifetime.signal.aborted).toBe(false);
});

test('insufficient shared credit refuses an upload snapshot before sending any bytes', async () => {
  const f = fixture(); const r = f.row();
  const occupied = f.memory.reserve(f.memory.maxBytes - f.memory.reservedBytes - r.encoded.bytes.byteLength + 1);
  try {
    const before = f.memory.reservedBytes;
    await expect(r.send()).rejects.toMatchObject({ code: 'NODE_CAPACITY' });
    expect(f.sent).toEqual([]);
    expect(f.memory.reservedBytes).toBe(before);
  } finally { occupied.release(); }
  await r.send();
  expect(r.reservation.take()).toEqual(r.original);
});
