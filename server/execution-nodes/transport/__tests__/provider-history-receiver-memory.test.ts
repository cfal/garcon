import { afterEach, expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { NODE_WIRE_VERSION } from '@garcon/server-agent-interface';
import { AssistantMessage } from '../../../../common/chat-types.js';
import type { NodeHistoryBulkPort } from '../provider-history-bulk-channel.js';
import { NodeHistoryMemoryBudget } from '../provider-history-memory.js';
import { NodeHistoryBulkReceiver, type NodeHistoryRowReservation } from '../provider-history-receiver.js';
import { NodeHistoryReceiverPool } from '../provider-history-receiver-pool.js';
import type { NodeBulkTransfersOptions } from '../bulk-transfers.js';
import type { NodeBulkFrame } from '../bulk-channel-wire.js';

const session = { controllerBootId: 'synthetic-controller', nodeBootId: 'synthetic-node', logicalSessionId: 'synthetic-session' };
const target = { identity: { ...session, operationId: 'synthetic-import' }, instanceId: 'synthetic-instance', connectionId: 1,
  bulkAttemptId: 'synthetic-attempt' };
const port = { send: () => true, sendWhenWritable: async () => {} } satisfies NodeHistoryBulkPort;
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });
const descriptor = (bytes: Uint8Array) => ({ byteLength: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') });
const encoded = () => Buffer.from(JSON.stringify({ message: new AssistantMessage('2026-01-01T00:00:00.000Z', 'Synthetic row') }));

function fixture(memoryBytes: number, options: Partial<NodeBulkTransfersOptions> = {}) {
  const memory = new NodeHistoryMemoryBudget(memoryBytes);
  const authority = new AbortController();
  const caller = new AbortController();
  const receiver = new NodeHistoryBulkReceiver(memory, { session, authoritySignal: authority.signal, ...options });
  cleanup.push(() => { receiver.close(); expect(memory.reservedBytes).toBe(0); });
  const reserve = (bytes: Uint8Array) => receiver.reserve(target, 1, descriptor(bytes), port, caller.signal, () => {});
  const deliver = (reservation: NodeHistoryRowReservation, bytes: Uint8Array) => {
    const send = (payload: NodeBulkFrame) => receiver.receive({ ...target, type: 'node-history-bulk', version: NODE_WIRE_VERSION,
      sequence: 1, grant: reservation.grant, payload: JSON.stringify(payload) });
    send({ type: 'node-bulk-credit-chunk', version: NODE_WIRE_VERSION, transfer: reservation.grant,
      offset: 0, data: Buffer.from(bytes).toString('base64') });
    send({ type: 'node-bulk-complete', version: NODE_WIRE_VERSION, transfer: reservation.grant, requestId: 1 });
  };
  return { memory, authority, caller, receiver, reserve, deliver };
}

test('different nodes and replacement connections use one controller pool', () => {
  const pool = new NodeHistoryReceiverPool(300);
  const lifetime = new AbortController();
  const otherSession = { ...session, nodeBootId: 'synthetic-other-node', logicalSessionId: 'synthetic-other-session' };
  const first = pool.createReceiver(session, lifetime.signal);
  const second = pool.createReceiver(otherSession, lifetime.signal);
  const replacement = pool.createReceiver(session, lifetime.signal);
  cleanup.push(() => { lifetime.abort(); expect(pool.reservedBytes).toBe(0); });
  const bytes = new Uint8Array(200);
  const reserve = (receiver: NodeHistoryBulkReceiver, identity = target.identity) =>
    receiver.reserve({ ...target, identity }, 1, descriptor(bytes), port, lifetime.signal, () => {});
  const held = reserve(first);
  expect(pool.reservedBytes).toBe(200);
  expect(() => reserve(second, { ...otherSession, operationId: 'synthetic-other-import' }))
    .toThrow(expect.objectContaining({ code: 'NODE_CAPACITY' }));
  expect(() => reserve(replacement)).toThrow(expect.objectContaining({ code: 'NODE_CAPACITY' }));
  expect(second.transferCount).toBe(0);
  expect(replacement.transferCount).toBe(0);
  held.close();
  expect(pool.reservedBytes).toBe(0);
  reserve(second, { ...otherSession, operationId: 'synthetic-other-import' });
  expect(pool.reservedBytes).toBe(200);
});

test('raw receive memory is reserved before a grant exists and raw-limit refusal releases it', () => {
  const f = fixture(1000, { limits: { maxBytes: 200, maxTransferBytes: 200 } });
  const original = f.memory.reserve.bind(f.memory);
  const observed: number[] = [];
  const reservation = spyOn(f.memory, 'reserve').mockImplementation((bytes) => {
    observed.push(f.receiver.transferCount);
    return original(bytes);
  });
  try {
    f.reserve(new Uint8Array(150));
    expect(f.memory.reservedBytes).toBe(150);
    expect(() => f.reserve(new Uint8Array(150))).toThrow(expect.objectContaining({ code: 'NODE_CAPACITY' }));
    expect(observed).toEqual([0, 1]);
    expect(f.memory.reservedBytes).toBe(150);
    expect(f.receiver.transferCount).toBe(1);
  } finally { reservation.mockRestore(); }
});

test('configured row capacity fails before installing a receiving grant', () => {
  const f = fixture(100);
  expect(() => f.reserve(new Uint8Array(101))).toThrow(expect.objectContaining({ code: 'NODE_CAPACITY' }));
  expect(f.receiver.transferCount).toBe(0);
  expect(f.memory.reservedBytes).toBe(0);
});

for (const ending of ['caller', 'authority', 'close'] as const) {
  test(`receive-buffer reservation releases on ${ending} cancellation without caller consumption`, async () => {
    const f = fixture(1000);
    const row = f.reserve(new Uint8Array(200));
    expect(f.memory.reservedBytes).toBe(200);
    if (ending === 'close') row.close();
    else f[ending].abort();
    await expect(row.verified).rejects.toThrow();
    expect(f.memory.reservedBytes).toBe(0);
    expect(f.receiver.transferCount).toBe(0);
    row.close();
    expect(f.memory.reservedBytes).toBe(0);
  });
}

test('raw-grant expiry releases the shared pool even while the import caller is idle', async () => {
  let now = 0;
  const timers = new Set<() => void>();
  const f = fixture(1000, { now: () => now, limits: { retentionMs: 10 }, scheduleTimeout(callback) {
    timers.add(callback); return { cancel: () => timers.delete(callback) };
  } });
  const row = f.reserve(new Uint8Array(200));
  now = 10;
  for (const expire of [...timers]) expire();
  expect(f.memory.reservedBytes).toBe(0);
  await expect(row.verified).rejects.toThrow();
  expect(f.receiver.transferCount).toBe(0);
  expect(timers.size).toBe(0);
  expect(f.caller.signal.aborted).toBe(false);
});

test('verified bytes stay charged through decode and successful ownership transfer releases transport memory', async () => {
  const bytes = encoded();
  const f = fixture(32 * 1024);
  const row = f.reserve(bytes);
  f.deliver(row, bytes);
  await row.verified;
  expect(f.memory.reservedBytes).toBe(bytes.byteLength);
  const original = JSON.parse;
  const parsing = spyOn(JSON, 'parse').mockImplementation((text, reviver) => {
    expect(f.memory.reservedBytes).toBeGreaterThan(8 * bytes.byteLength);
    return original(text, reviver);
  });
  try { expect(row.take().message).toBeInstanceOf(AssistantMessage); }
  finally { parsing.mockRestore(); }
  expect(f.memory.reservedBytes).toBe(0);
  expect(f.receiver.transferCount).toBe(0);
});

test('dense rows can exhaust decode credit before JSON parsing without leaking their raw reservation', async () => {
  const bytes = Buffer.from(JSON.stringify({ message: new AssistantMessage('2026-01-01T00:00:00.000Z', 'Synthetic'),
    providerMeta: { values: Array(100).fill(null) } }));
  const f = fixture(bytes.byteLength * 9);
  const row = f.reserve(bytes);
  f.deliver(row, bytes);
  await row.verified;
  const parsing = spyOn(JSON, 'parse');
  try {
    expect(() => row.take()).toThrow(expect.objectContaining({ code: 'NODE_CAPACITY' }));
    expect(parsing).not.toHaveBeenCalled();
  } finally { parsing.mockRestore(); }
  expect(f.memory.reservedBytes).toBe(0);
  expect(f.receiver.transferCount).toBe(0);
});

test('a malformed verified row releases both decode and raw-buffer reservations', async () => {
  const f = fixture(32 * 1024);
  const bytes = Buffer.from('{"message":');
  const row = f.reserve(bytes);
  f.deliver(row, bytes);
  await row.verified;
  expect(() => row.take()).toThrow(expect.objectContaining({ code: 'NODE_HISTORY_INVALID' }));
  expect(f.memory.reservedBytes).toBe(0);
  expect(f.receiver.transferCount).toBe(0);
});

test('hash failure releases the raw allocation before any normalized row can escape', async () => {
  const f = fixture(32 * 1024);
  const bytes = encoded();
  const row = f.reserve(bytes);
  bytes[0] ^= 1;
  f.deliver(row, bytes);
  await expect(row.verified).rejects.toThrow();
  expect(() => row.take()).toThrow();
  expect(f.memory.reservedBytes).toBe(0);
  expect(f.receiver.transferCount).toBe(0);
});
