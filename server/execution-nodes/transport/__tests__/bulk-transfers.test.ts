import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { NodeBulkTransfers, type NodeBulkLimits } from '../bulk-transfers.js';
import { MAX_NODE_BULK_CHUNK_BYTES, MAX_NODE_BULK_FRAME_BYTES, parseNodeBulkChunkText, parseNodeBulkDescriptor, parseNodeBulkIdentity, serializeNodeBulkChunk } from '../bulk-wire.js';

const stores: NodeBulkTransfers[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
const session = { controllerBootId: 'synthetic-controller', nodeBootId: 'synthetic-node', logicalSessionId: 'synthetic-session' };
function descriptor(bytes: Uint8Array) { return { byteLength: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') }; }
function fixture(limits: Partial<NodeBulkLimits> = {}) {
  let elapsed = 0;
  const authority = new AbortController();
  const grant = new AbortController();
  const owner = Object.freeze({});
  const timers: { callback(): void; cancelled: boolean }[] = [];
  const transfers = new NodeBulkTransfers({ session, authoritySignal: authority.signal,
    limits: { maxTransfers: 2, maxBytes: 16, maxTransferBytes: 8, retentionMs: 100, ...limits }, now: () => elapsed,
    scheduleTimeout(callback) {
      const timer = { callback, cancelled: false };
      timers.push(timer);
      return { cancel() { timer.cancelled = true; } };
    },
  });
  stores.push(transfers);
  return { authority, grant, owner, transfers, timers, advance(ms: number) { elapsed += ms; } };
}

test('wire chunks assemble only complete hash-verified bytes under their captured grant', () => {
  const f = fixture();
  const bytes = Buffer.from('syntheti');
  const identity = f.transfers.reserve(f.owner, descriptor(bytes), f.grant.signal);
  for (let offset = 0; offset < bytes.length; offset += 3) {
    const text = serializeNodeBulkChunk(identity, offset, bytes.subarray(offset, offset + 3));
    const message = parseNodeBulkChunkText(text);
    if (!message) throw new Error('Synthetic chunk rejected');
    expect(f.transfers.append(message.transfer, message.offset, Buffer.from(message.data, 'base64')))
      .toBe(Math.min(offset + 3, bytes.length));
  }
  expect(() => f.transfers.take(identity, f.owner)).toThrow('incomplete');
  expect(f.transfers.complete(identity)).toMatchObject({ receivedBytes: 8, phase: 'complete' });
  expect(f.transfers.complete(identity).phase).toBe('complete');
  expect(f.transfers.take(identity, f.owner)).toEqual(new Uint8Array(bytes));
  expect(f.transfers.status(identity)).toBeNull();
  expect(f.transfers.reservedBytes).toBe(0);
  expect(f.timers.every((timer) => timer.cancelled)).toBe(true);
  expect(() => f.transfers.append(identity, 0, bytes)).toThrow('unavailable');
});

test('reserves aggregate declared bytes and entry capacity before receiving any chunk', () => {
  const f = fixture();
  const bytes = Buffer.from('syntheti');
  const first = f.transfers.reserve(f.owner, descriptor(bytes), f.grant.signal);
  const second = f.transfers.reserve(f.owner, descriptor(bytes), f.grant.signal);
  expect(f.transfers.reservedBytes).toBe(16);
  expect(f.transfers.transferCount).toBe(2);
  expect(() => f.transfers.reserve(f.owner, descriptor(Buffer.alloc(0)), f.grant.signal)).toThrow('capacity');
  f.transfers.cancel(first, f.owner);
  const next = f.transfers.reserve(f.owner, descriptor(bytes), f.grant.signal);
  expect(next.transferId).not.toBe(first.transferId);
  expect(f.transfers.status(first)).toBeNull();
  expect(f.transfers.status(second)).toMatchObject({ phase: 'receiving' });
});

test('a declared length greater than remaining capacity is refused before any allocation grant', () => {
  const f = fixture({ maxTransfers: 4, maxBytes: 12 });
  f.transfers.reserve(f.owner, descriptor(Buffer.alloc(8)), f.grant.signal);
  expect(() => f.transfers.reserve(f.owner, descriptor(Buffer.alloc(5)), f.grant.signal)).toThrow('capacity');
  expect(f.transfers.transferCount).toBe(1);
  expect(f.transfers.reservedBytes).toBe(8);
});

test('expired receiving and completed transfers disappear before a delayed timer runs', () => {
  const f = fixture();
  const bytes = Buffer.from('data');
  const receiving = f.transfers.reserve(f.owner, descriptor(bytes), f.grant.signal);
  const completed = f.transfers.reserve(f.owner, descriptor(bytes), f.grant.signal);
  f.transfers.append(completed, 0, bytes);
  f.transfers.complete(completed);
  f.advance(100);
  expect(() => f.transfers.take(completed, f.owner)).toThrow('unavailable');
  expect(f.transfers.status(receiving)).toBeNull();
  expect(f.transfers.reservedBytes).toBe(0);
});

test('continuous progress renews the idle deadline and completion leaves a full window to claim bytes', () => {
  const f = fixture();
  const bytes = Buffer.from('data');
  const receiving = f.transfers.reserve(f.owner, descriptor(bytes), f.grant.signal);
  const idle = f.transfers.reserve(f.owner, descriptor(bytes), f.grant.signal);
  for (let offset = 0; offset < bytes.length; offset += 1) {
    f.advance(90);
    f.transfers.append(receiving, offset, bytes.subarray(offset, offset + 1));
  }
  expect(f.transfers.status(idle)).toBeNull();
  f.advance(90);
  f.transfers.complete(receiving);
  f.advance(99);
  expect(f.transfers.take(receiving, f.owner)).toEqual(bytes);
  expect(f.transfers.reservedBytes).toBe(0);
});

test('invalid chunks and repeated completion do not keep abandoned reservations alive', () => {
  const f = fixture();
  const bytes = Buffer.from('data');
  const partial = f.transfers.reserve(f.owner, descriptor(bytes), f.grant.signal);
  const complete = f.transfers.reserve(f.owner, descriptor(bytes), f.grant.signal);
  f.transfers.append(complete, 0, bytes);
  f.transfers.complete(complete);
  f.advance(90);
  expect(() => f.transfers.append(partial, 1, bytes)).toThrow();
  f.transfers.complete(complete);
  f.advance(10);
  expect(f.transfers.status(partial)).toBeNull();
  expect(f.transfers.status(complete)).toBeNull();
});

test('partial or corrupt content cannot become available and corrupt completion drops its reservation', () => {
  const f = fixture();
  const bytes = Buffer.from('data');
  const identity = f.transfers.reserve(f.owner, descriptor(bytes), f.grant.signal);
  f.transfers.append(identity, 0, Buffer.from('da'));
  expect(() => f.transfers.complete(identity)).toThrow('incomplete');
  expect(f.transfers.status(identity)).toMatchObject({ phase: 'receiving', receivedBytes: 2 });
  f.transfers.append(identity, 2, Buffer.from('no'));
  expect(() => f.transfers.complete(identity)).toThrow('incomplete');
  expect(f.transfers.status(identity)).toBeNull();
  expect(f.transfers.reservedBytes).toBe(0);
});

test('chunk gaps, duplicate offsets and overruns cannot change already received bytes', () => {
  const f = fixture();
  const bytes = Buffer.from('data');
  const identity = f.transfers.reserve(f.owner, descriptor(bytes), f.grant.signal);
  expect(() => f.transfers.append(identity, 1, bytes)).toThrow('incomplete');
  f.transfers.append(identity, 0, bytes.subarray(0, 2));
  expect(() => f.transfers.append(identity, 0, bytes.subarray(0, 2))).toThrow('incomplete');
  expect(() => f.transfers.append(identity, 2, bytes)).toThrow('incomplete');
  expect(f.transfers.status(identity)?.receivedBytes).toBe(2);
  f.transfers.append(identity, 2, bytes.subarray(2));
  f.transfers.complete(identity);
  expect(f.transfers.take(identity, f.owner)).toEqual(new Uint8Array(bytes));
});

test('a caller mutation cannot alter retained bytes or their descriptor', () => {
  const f = fixture();
  const bytes = Buffer.from('data');
  const description = descriptor(bytes);
  const identity = f.transfers.reserve(f.owner, description, f.grant.signal);
  description.sha256 = '0'.repeat(64);
  description.byteLength = 7;
  f.transfers.append(identity, 0, bytes);
  bytes.fill(0);
  f.transfers.complete(identity);
  expect(Buffer.from(f.transfers.take(identity, f.owner)).toString()).toBe('data');
});

test.each(['controllerBootId', 'nodeBootId', 'logicalSessionId'] as const)('foreign %s is refused without affecting the current grant', (key) => {
  const f = fixture();
  const identity = f.transfers.reserve(f.owner, descriptor(Buffer.alloc(0)), f.grant.signal);
  expect(() => f.transfers.status({ ...identity, [key]: 'synthetic-foreign' })).toThrow('unavailable');
  expect(f.transfers.status(identity)).not.toBeNull();
});

test('one operation cannot consume or cancel another operation\'s registered bytes', () => {
  const f = fixture();
  const bytes = Buffer.from('data');
  const identity = f.transfers.reserve(f.owner, descriptor(bytes), f.grant.signal);
  f.transfers.append(identity, 0, bytes);
  f.transfers.complete(identity);
  expect(() => f.transfers.take(identity, {})).toThrow('unavailable');
  expect(() => f.transfers.cancel(identity, {})).toThrow('unavailable');
  expect(f.transfers.status(identity)?.phase).toBe('complete');
});

test.each(['grant', 'authority'] as const)('%s cancellation clears private transfer bytes and prevents later use', (kind) => {
  const f = fixture();
  const identity = f.transfers.reserve(f.owner, descriptor(Buffer.from('data')), f.grant.signal);
  f.transfers.append(identity, 0, Buffer.from('da'));
  f[kind].abort();
  expect(f.transfers.reservedBytes).toBe(0);
  expect(() => f.transfers.take(identity, f.owner)).toThrow('unavailable');
  if (kind === 'grant') expect(f.transfers.status(identity)).toBeNull();
  else expect(() => f.transfers.status(identity)).toThrow('unavailable');
  expect(f.timers[0]!.cancelled).toBe(true);
});

test('taking transfers ownership and later grant cancellation does not erase handed-off bytes', () => {
  const f = fixture();
  const bytes = Buffer.from('data');
  const identity = f.transfers.reserve(f.owner, descriptor(bytes), f.grant.signal);
  f.transfers.append(identity, 0, bytes);
  f.transfers.complete(identity);
  const received = f.transfers.take(identity, f.owner);
  f.grant.abort();
  f.authority.abort();
  expect(received).toEqual(new Uint8Array(bytes));
});

test('a clock regression retires every old transfer without extending its lifetime', () => {
  const f = fixture();
  f.advance(1);
  const identity = f.transfers.reserve(f.owner, descriptor(Buffer.alloc(0)), f.grant.signal);
  f.advance(-1);
  expect(() => f.transfers.status(identity)).toThrow('unavailable');
  f.advance(2);
  expect(f.transfers.reservedBytes).toBe(0);
  expect(() => f.transfers.reserve(f.owner, descriptor(Buffer.alloc(0)), f.grant.signal)).toThrow('unavailable');
});

test('strict chunk codec bounds actual bytes and rejects malformed identities, offsets and noncanonical base64', () => {
  const identity = { ...session, transferId: 'synthetic-transfer' };
  const maximum = Buffer.alloc(MAX_NODE_BULK_CHUNK_BYTES, 255);
  const text = serializeNodeBulkChunk(identity, 0, maximum);
  expect(Buffer.byteLength(text)).toBeLessThan(MAX_NODE_BULK_FRAME_BYTES);
  const decoded = parseNodeBulkChunkText(text);
  expect(decoded?.data).toBe(maximum.toString('base64'));
  const valid = JSON.parse(text);
  for (const invalid of [
    { ...valid, extra: true }, { ...valid, offset: -1 }, { ...valid, offset: 1.1 },
    { ...valid, transfer: { ...identity, extra: true } },
    { ...valid, data: 'ZB==' }, { ...valid, data: 'ZA=' }, { ...valid, data: 'Z A=' },
    { ...valid, data: Buffer.alloc(MAX_NODE_BULK_CHUNK_BYTES + 1).toString('base64') },
  ]) expect(parseNodeBulkChunkText(JSON.stringify(invalid))).toBeNull();
  expect(parseNodeBulkChunkText(' '.repeat(MAX_NODE_BULK_FRAME_BYTES + 1))).toBeNull();
  expect(parseNodeBulkIdentity({ ...identity, projectPath: '/synthetic/path' })).toBeNull();
  expect(parseNodeBulkDescriptor({ byteLength: 0, sha256: 'x'.repeat(64) })).toBeNull();
  expect(parseNodeBulkDescriptor({ byteLength: 1.1, sha256: '0'.repeat(64) })).toBeNull();
});


test('chunk padding admits exactly canonical zero bits for both padding lengths', () => {
  const frame = JSON.parse(serializeNodeBulkChunk({ ...session, transferId: 'synthetic-transfer' }, 0, Buffer.from('a')));
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  for (const [index, char] of Array.from(alphabet).entries()) {
    expect(parseNodeBulkChunkText(JSON.stringify({ ...frame, data: `A${char}==` })) !== null).toBe(index % 16 === 0);
    expect(parseNodeBulkChunkText(JSON.stringify({ ...frame, data: `AA${char}=` })) !== null).toBe(index % 4 === 0);
  }
});

test('an expiry callback contains clock failure while retiring its transfer namespace', () => {
  const f = fixture();
  f.advance(1);
  const identity = f.transfers.reserve(f.owner, descriptor(Buffer.alloc(0)), f.grant.signal);
  f.advance(-1);
  expect(() => f.timers[0]!.callback()).not.toThrow();
  f.advance(2);
  expect(f.transfers.reservedBytes).toBe(0);
  expect(() => f.transfers.status(identity)).toThrow('unavailable');
});
