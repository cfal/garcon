import { createHash } from 'node:crypto';
import { expect, mock, test } from 'bun:test';
import { serializeNodeOutputFrame, type ProducerStreamIdentity } from '@garcon/server-agent-interface';
import { NodeOutputAssemblyBudget } from '../output-budget.js';
import { NodeWorkerOutputAssembler, type NodeWorkerOutputAssemblerOptions } from '../output-assembler.js';
import { chunkNodeWorkerOutput, parseNodeWorkerOutputText, serializeNodeWorkerOutput } from '../output-protocol.js';
import { session } from './lifecycle-fixture.js';

const instance = 'synthetic-first';
const otherInstance = 'synthetic-second';
const stream = { ...session, streamId: 'synthetic-stream' };
const otherStream = { ...session, streamId: 'synthetic-other' };

function record(identity: ProducerStreamIdentity = stream, sequence = 1, content = '界'.repeat(30_000)) {
  return serializeNodeOutputFrame({ type: 'node-output', stream: identity, sequence,
    event: { type: 'notice', runId: 'synthetic-run', content } });
}

function fixture(maxBytes = 300_000, budget?: NodeOutputAssemblyBudget) {
  let validate = () => {};
  const failed = mock((_error: unknown) => {});
  let now = 0;
  const lifetime = new AbortController();
  const timers: { callback(): void; cancelled: boolean }[] = [];
  const assembler = new NodeWorkerOutputAssembler({ session, instanceIds: new Set([instance, otherInstance]),
    signal: lifetime.signal, limits: { maxBytes, maxTransferBytes: maxBytes, maxTransfers: 2, retentionMs: 100 },
    now: () => now, budget, failed, validate() { lifetime.signal.throwIfAborted(); validate(); }, scheduleTimeout(callback) {
      const timer = { callback, cancelled: false };
      timers.push(timer);
      return { cancel() { timer.cancelled = true; } };
    } });
  const install = (instanceId = instance, identity = stream) => {
    const cancellation = new AbortController();
    const received = mock((_text: string, _sequence: number) => {});
    const failed = mock((_failure: import('../output-assembler.js').NodeWorkerOutputFailure) => {});
    assembler.install(instanceId, identity, cancellation.signal, received, failed);
    return { received, failed, cancellation };
  };
  return { assembler, install, lifetime, timers, failed, advance(ms: number) { now += ms; },
    validating(callback: NodeWorkerOutputAssemblerOptions['validate']) { validate = callback; } };
}

test('assembled output reaches its captured receiver only after exact length, hash and frame validation', () => {
  const f = fixture();
  const owner = f.install();
  const serialized = record();
  const chunks = chunkNodeWorkerOutput(instance, serialized);
  try {
    expect(chunks.length).toBeGreaterThan(1);
    expect(f.assembler.receive(instance, chunks[0]!)).toBe('chunk');
    expect(f.assembler.bufferedBytes).toBe(Buffer.byteLength(serialized));
    expect(owner.received).not.toHaveBeenCalled();
    for (const chunk of chunks.slice(1)) f.assembler.receive(instance, chunk);
    expect(owner.received.mock.calls).toEqual([[serialized, 1]]);
    expect(f.assembler.bufferedBytes).toBe(0);
    const next = record(stream, 2, 'synthetic next');
    expect(f.assembler.receive(instance, chunkNodeWorkerOutput(instance, next)[0]!)).toBe('record');
    expect(owner.received).toHaveBeenLastCalledWith(next, 2);
    expect(owner.failed).not.toHaveBeenCalled();
  } finally { f.assembler.close(); }
});

test('output allocation is shared across instance pipes and pressure retires only the refused stream', () => {
  const serialized = record();
  const otherSerialized = record(otherStream);
  const f = fixture(Buffer.byteLength(serialized) + Buffer.byteLength(otherSerialized) - 1);
  const owner = f.install();
  const other = f.install(otherInstance, otherStream);
  const chunks = chunkNodeWorkerOutput(instance, serialized);
  try {
    expect(f.assembler.receive(instance, chunks[0]!)).toBe('chunk');
    expect(f.assembler.receive(otherInstance, chunkNodeWorkerOutput(otherInstance, otherSerialized)[0]!)).toBe('retired');
    expect(other.failed).toHaveBeenCalledTimes(1);
    expect(f.assembler.bufferedBytes).toBe(Buffer.byteLength(serialized));
    for (const chunk of chunks.slice(1)) f.assembler.receive(instance, chunk);
    expect(owner.received.mock.calls).toEqual([[serialized, 1]]);
    expect(owner.failed).not.toHaveBeenCalled();
    expect(f.assembler.bufferedBytes).toBe(0);
  } finally { f.assembler.close(); }
});

test.each(['offset', 'transfer', 'descriptor', 'hash', 'sequence', 'inner identity'] as const)(
  'output %s corruption retires its stream without publishing partial content', (cause) => {
    const f = fixture();
    const owner = f.install();
    const other = f.install(otherInstance, otherStream);
    const chunks = chunkNodeWorkerOutput(instance, record());
    const first = parseNodeWorkerOutputText(chunks[0]!)!;
    let second = parseNodeWorkerOutputText(chunks[1]!)!;
    try {
      f.assembler.receive(instance, chunks[0]!);
      if (cause === 'offset') second = { ...second, chunk: { ...second.chunk, offset: 0 } };
      if (cause === 'transfer') second = { ...second, chunk: { ...second.chunk, transfer: { ...second.chunk.transfer, transferId: 'synthetic-replacement' } } };
      if (cause === 'descriptor') second = { ...second, descriptor: { ...second.descriptor, sha256: '0'.repeat(64) } };
      if (cause === 'hash') second = { ...second, chunk: { ...second.chunk, data: Buffer.alloc(Buffer.from(second.chunk.data, 'base64').length, 120).toString('base64') } };
      if (cause === 'sequence') second = { ...second, sequence: 3 };
      if (cause === 'inner identity') {
        f.assembler.retire(stream);
        const thirdStream = { ...session, streamId: 'synthetic-third' };
        const third = f.install(instance, thirdStream);
        for (const text of chunks) {
          const frame = parseNodeWorkerOutputText(text)!;
          expect(f.assembler.receive(instance, serializeNodeWorkerOutput({ ...frame, stream: thirdStream })))
            .toBe(text === chunks.at(-1) ? 'retired' : 'chunk');
        }
        expect(third.received).not.toHaveBeenCalled();
        expect(third.failed).toHaveBeenCalledTimes(1);
      } else {
        expect(f.assembler.receive(instance, serializeNodeWorkerOutput(second))).toBe('retired');
        expect(owner.failed).toHaveBeenCalledTimes(1);
      }
      expect(f.assembler.receive(instance, serializeNodeWorkerOutput(first))).toBe('retired');
      expect(owner.received).not.toHaveBeenCalled();
      expect(f.assembler.bufferedBytes).toBe(0);
      expect(f.assembler.receive(otherInstance, chunkNodeWorkerOutput(otherInstance, record(otherStream, 1, 'synthetic'))[0]!)).toBe('record');
      expect(other.received).toHaveBeenCalledTimes(1);
    } finally { f.assembler.close(); }
  },
);

test('foreign instance and session frames cannot allocate or disturb an installed stream', () => {
  const f = fixture();
  const owner = f.install();
  try {
    const text = chunkNodeWorkerOutput(instance, record())[0]!;
    const frame = parseNodeWorkerOutputText(text)!;
    expect(() => f.assembler.receive(otherInstance, text)).toThrow();
    expect(() => f.assembler.receive(otherInstance, serializeNodeWorkerOutput({ ...frame, instanceId: otherInstance }))).toThrow();
    expect(() => f.assembler.receive(instance, chunkNodeWorkerOutput(instance, record({ ...stream, logicalSessionId: 'foreign' }))[0]!)).toThrow();
    expect(f.assembler.bufferedBytes).toBe(0);
    expect(owner.failed).not.toHaveBeenCalled();
    expect(owner.received).not.toHaveBeenCalled();
  } finally { f.assembler.close(); }
});

test('partial output expires without another incoming frame and notifies its owner once', () => {
  const f = fixture();
  const owner = f.install();
  try {
    const chunks = chunkNodeWorkerOutput(instance, record());
    f.assembler.receive(instance, chunks[0]!);
    f.advance(100);
    for (const timer of f.timers) if (!timer.cancelled) timer.callback();
    expect(f.assembler.bufferedBytes).toBe(0);
    expect(owner.failed).toHaveBeenCalledTimes(1);
    expect(owner.received).not.toHaveBeenCalled();
    expect(f.assembler.receive(instance, chunks[1]!)).toBe('retired');
    f.assembler.prune();
    expect(owner.failed).toHaveBeenCalledTimes(1);
  } finally { f.assembler.close(); }
});

test.each(['stream', 'session'] as const)('%s retirement cancels pending allocation without reopening its owner', (kind) => {
  const f = fixture();
  const owner = f.install();
  try {
    const chunks = chunkNodeWorkerOutput(instance, record());
    f.assembler.receive(instance, chunks[0]!);
    if (kind === 'stream') owner.cancellation.abort(); else f.lifetime.abort();
    expect(f.assembler.bufferedBytes).toBe(0);
    expect(f.timers.every((timer) => timer.cancelled)).toBe(true);
    expect(owner.received).not.toHaveBeenCalled();
    expect(owner.failed).not.toHaveBeenCalled();
    expect(() => f.install()).toThrow();
  } finally { f.assembler.close(); }
});

test('a throwing completed-record receiver retires its stream after releasing assembly bytes', () => {
  const f = fixture();
  const owner = f.install();
  owner.received.mockImplementation(() => { throw new Error('Synthetic receiver failure'); });
  try {
    expect(f.assembler.receive(instance, chunkNodeWorkerOutput(instance, record(stream, 1, 'synthetic'))[0]!)).toBe('retired');
    expect(owner.received).toHaveBeenCalledTimes(1);
    expect(owner.failed).toHaveBeenCalledTimes(1);
    expect(f.assembler.bufferedBytes).toBe(0);
  } finally { f.assembler.close(); }
});

test('unknown and retired streams are ignored without allocation, while a wrong installed instance is fatal', () => {
  const f = fixture();
  try {
    const text = chunkNodeWorkerOutput(instance, record())[0]!;
    expect(f.assembler.receive(instance, text)).toBe('retired');
    const owner = f.install(); owner.cancellation.abort();
    expect(f.assembler.receive(instance, text)).toBe('retired');
    const frame = parseNodeWorkerOutputText(text)!;
    expect(() => f.assembler.receive(otherInstance, serializeNodeWorkerOutput({ ...frame, instanceId: otherInstance }))).toThrow();
    expect(f.assembler.bufferedBytes).toBe(0);
    expect(f.failed).not.toHaveBeenCalled();
  } finally { f.assembler.close(); }
});

test('each instance has at most one partial record and capacity refusal identifies the arriving stream', () => {
  const f = fixture(); const first = f.install(); const second = f.install(instance, otherStream);
  try {
    const chunks = chunkNodeWorkerOutput(instance, record());
    f.assembler.receive(instance, chunks[0]!);
    const refused = chunkNodeWorkerOutput(instance, record(otherStream))[0]!;
    expect(f.assembler.receive(instance, refused)).toBe('retired');
    expect(second.failed).toHaveBeenCalledWith({ instanceId: instance, stream: otherStream, sequence: 1,
      transfer: parseNodeWorkerOutputText(refused)!.chunk.transfer, cause: expect.objectContaining({ code: 'NODE_CAPACITY' }) });
    for (const chunk of chunks.slice(1)) f.assembler.receive(instance, chunk);
    expect(first.received).toHaveBeenCalledTimes(1);
    expect(first.failed).not.toHaveBeenCalled();
  } finally { f.assembler.close(); }
});

test('assemblers share a process byte budget and retirement releases only its own charge', () => {
  const budget = new NodeOutputAssemblyBudget(100_000);
  const first = fixture(300_000, budget); const second = fixture(300_000, budget);
  const owner = first.install(); const other = second.install(otherInstance, otherStream);
  try {
    const chunks = chunkNodeWorkerOutput(instance, record());
    first.assembler.receive(instance, chunks[0]!);
    expect(budget.reservedBytes).toBe(Buffer.byteLength(record()));
    expect(second.assembler.receive(otherInstance, chunkNodeWorkerOutput(otherInstance, record(otherStream))[0]!)).toBe('retired');
    expect(other.failed).toHaveBeenCalledTimes(1);
    expect(budget.reservedBytes).toBe(Buffer.byteLength(record()));
    owner.cancellation.abort();
    expect(budget.reservedBytes).toBe(0);
    const replacement = { ...stream, streamId: 'synthetic-replacement' };
    const next = second.install(otherInstance, replacement);
    for (const chunk of chunkNodeWorkerOutput(otherInstance, record(replacement))) second.assembler.receive(otherInstance, chunk);
    expect(next.received).toHaveBeenCalledTimes(1);
    expect(budget.reservedBytes).toBe(0);
  } finally { first.assembler.close(); second.assembler.close(); }
});

test.each(['starting offset', 'UTF-8', 'truncated tail'] as const)('%s corruption fails only its exact output stream', (cause) => {
  const f = fixture(); const owner = f.install(); const sibling = f.install(otherInstance, otherStream);
  try {
    let frames = chunkNodeWorkerOutput(instance, record()).map((text) => parseNodeWorkerOutputText(text)!);
    if (cause === 'starting offset') frames = [frames[1]!];
    if (cause === 'UTF-8') {
      const bytes = Buffer.concat(frames.map((frame) => Buffer.from(frame.chunk.data, 'base64')));
      bytes[10] = 0xff;
      const descriptor = { byteLength: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') };
      frames = frames.map((frame) => ({ ...frame, descriptor, chunk: { ...frame.chunk,
        data: bytes.subarray(frame.chunk.offset, frame.chunk.offset + Buffer.from(frame.chunk.data, 'base64').length).toString('base64') } }));
    }
    if (cause === 'truncated tail') frames = frames.map((frame) => ({ ...frame,
      descriptor: { ...frame.descriptor, byteLength: frame.descriptor.byteLength + 1 } }));
    for (const frame of frames) f.assembler.receive(instance, serializeNodeWorkerOutput(frame));
    if (cause === 'truncated tail') { f.advance(100); f.assembler.prune(); }
    expect(owner.failed).toHaveBeenCalledTimes(1); expect(owner.received).not.toHaveBeenCalled();
    expect(f.assembler.bufferedBytes).toBe(0);
    for (const chunk of chunkNodeWorkerOutput(otherInstance, record(otherStream))) f.assembler.receive(otherInstance, chunk);
    expect(sibling.received).toHaveBeenCalledTimes(1);
    expect(sibling.failed).not.toHaveBeenCalled();
  } finally { f.assembler.close(); }
});

test('lease loss after chunk assembly escapes stream failure handling', () => {
  const f = fixture(); const owner = f.install(); let checks = 0;
  const error = new Error('Synthetic lease lost');
  f.validating(() => { if (++checks === 2) throw error; });
  try {
    expect(() => f.assembler.receive(instance, chunkNodeWorkerOutput(instance, record(stream, 1, 'small'))[0]!)).toThrow(error);
    expect(owner.failed).not.toHaveBeenCalled(); expect(owner.received).not.toHaveBeenCalled();
  } finally { f.assembler.close(); }
});

test('asynchronous lease loss fails the whole assembly owner and releases its shared allocations', () => {
  const budget = new NodeOutputAssemblyBudget(300_000);
  const f = fixture(300_000, budget); const owner = f.install();
  try {
    f.assembler.receive(instance, chunkNodeWorkerOutput(instance, record())[0]!);
    const error = new Error('Synthetic lease lost'); f.validating(() => { throw error; });
    for (const timer of [...f.timers]) if (!timer.cancelled) timer.callback();
    expect(f.failed).toHaveBeenCalledWith(error); expect(budget.reservedBytes).toBe(0);
    expect(owner.failed).not.toHaveBeenCalled(); expect(owner.received).not.toHaveBeenCalled();
  } finally { f.assembler.close(); }
});

test('completed-record receiver retirement and failure observer reentry cannot deliver twice', () => {
  const f = fixture(); const owner = f.install();
  const text = chunkNodeWorkerOutput(instance, record(stream, 1, 'small'))[0]!;
  owner.received.mockImplementation(() => { f.assembler.retire(stream); throw new Error('Synthetic receiver teardown'); });
  try {
    expect(f.assembler.receive(instance, text)).toBe('retired');
    expect(f.assembler.receive(instance, text)).toBe('retired');
    expect(owner.received).toHaveBeenCalledTimes(1); expect(owner.failed).not.toHaveBeenCalled();
    expect(f.assembler.bufferedBytes).toBe(0);
  } finally { f.assembler.close(); }
});

test('accessor-triggered expiry releases its shared reservation and instance slot exactly once', () => {
  const budget = new NodeOutputAssemblyBudget(300_000);
  const f = fixture(300_000, budget); const owner = f.install();
  try {
    f.assembler.receive(instance, chunkNodeWorkerOutput(instance, record())[0]!);
    f.advance(100);
    expect(f.assembler.bufferedBytes).toBe(0);
    expect(budget.reservedBytes).toBe(0);
    expect(owner.failed).toHaveBeenCalledTimes(1);
    const other = f.install(instance, otherStream);
    for (const chunk of chunkNodeWorkerOutput(instance, record(otherStream))) f.assembler.receive(instance, chunk);
    expect(other.received).toHaveBeenCalledTimes(1);
    expect(owner.failed).toHaveBeenCalledTimes(1);
  } finally { f.assembler.close(); }
});

test('authority failure in the assembly error path closes every allocation synchronously', () => {
  const budget = new NodeOutputAssemblyBudget(300_000);
  const f = fixture(300_000, budget); const owner = f.install(); const chunks = chunkNodeWorkerOutput(instance, record());
  try {
    f.assembler.receive(instance, chunks[0]!);
    let checks = 0; const failure = new Error('Synthetic authority lost');
    f.validating(() => { if (++checks === 2) throw failure; });
    const next = parseNodeWorkerOutputText(chunks[1]!)!;
    expect(() => f.assembler.receive(instance, serializeNodeWorkerOutput({ ...next, chunk: { ...next.chunk, offset: 0 } }))).toThrow(failure);
    expect(budget.reservedBytes).toBe(0); expect(f.failed).toHaveBeenCalledWith(failure);
    expect(owner.failed).not.toHaveBeenCalled();
  } finally { f.assembler.close(); }
});
