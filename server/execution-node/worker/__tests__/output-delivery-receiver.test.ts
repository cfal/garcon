import { expect, mock, test } from 'bun:test';
import { MAX_NODE_STREAM_IDENTITIES } from '../../replay-cache.js';
import { NODE_WIRE_VERSION, serializeNodeOutputFrame, type ProducerStreamIdentity } from '@garcon/server-agent-interface';
import type { NodeSessionIdentity } from '../../../../common/node-operation.js';
import { NodeOutputAssemblyBudget } from '../output-budget.js';
import { NodeWorkerOutputDeliveryReceiver } from '../output-delivery-receiver.js';
import { serializeNodeWorkerOutputDelivery } from '../output-delivery-protocol.js';
import { chunkNodeWorkerOutput } from '../output-protocol.js';
import { serializeNodeWorkerOutputRetirement } from '../output-retirement.js';
import { serializeNodeWorkerOutputSuspension } from '../service-protocol.js';
import { session } from './lifecycle-fixture.js';

const stream = { ...session, streamId: 'synthetic-stream' };
const sibling = { ...session, streamId: 'synthetic-sibling' };
const instanceId = 'synthetic-instance';
const otherInstance = 'synthetic-other-instance';

function record(identity: ProducerStreamIdentity, sequence: number, large = false): string {
  return serializeNodeOutputFrame({ type: 'node-output', stream: identity, sequence,
    event: { type: 'notice', runId: 'synthetic-run', content: large ? '界'.repeat(30_000) : 'synthetic' } });
}

function chunks(identity: ProducerStreamIdentity, sequence: number, connectionId = 1, generation = 1, large = false, instance = instanceId) {
  const { controllerBootId, nodeBootId, logicalSessionId } = identity;
  return chunkNodeWorkerOutput(instance, record(identity, sequence, large)).map((payload) => serializeNodeWorkerOutputDelivery({
    type: 'node-worker-output-delivery', version: NODE_WIRE_VERSION, session: { controllerBootId, nodeBootId, logicalSessionId }, connectionId, generation, payload,
  }));
}

function fixture(budget = new NodeOutputAssemblyBudget(200_000), identity: NodeSessionIdentity = session) {
  const lifetime = new AbortController();
  const physical = new AbortController();
  const failed = mock((_error: unknown) => {});
  const validate = mock(() => {});
  let now = 0;
  const timers: { callback(): void; cancelled: boolean }[] = [];
  const receiver = new NodeWorkerOutputDeliveryReceiver({ session: identity, instanceIds: new Set([instanceId, otherInstance]),
    signal: lifetime.signal, budget, now: () => now, failed, validate,
    scheduleTimeout(callback) { const timer = { callback, cancelled: false }; timers.push(timer); return { cancel() { timer.cancelled = true; } }; },
  });
  const install = (identity: ProducerStreamIdentity = stream, instance = instanceId) => {
    const cancellation = new AbortController(); const failed = mock((_error: unknown) => {});
    const received = mock((_serialized: string, _sequence: number) => {});
    receiver.install(instance, identity, cancellation.signal, received, failed);
    return { cancellation, received, failed };
  };
  return { receiver, lifetime, physical, budget, failed, validate, install, timers, advance(ms: number) { now += ms; } };
}

test('a fresh physical assembler starts immediately after the controller recovery cursor', () => {
  const f = fixture(); const owner = f.install();
  try {
    f.receiver.begin(3, 7, [{ stream, afterSequence: 12 }], f.physical.signal);
    const serialized = record(stream, 13, true);
    const frames = chunks(stream, 13, 3, 7, true);
    expect(f.receiver.receive(frames[0]!)).toBe('chunk');
    expect(f.budget.reservedBytes).toBe(Buffer.byteLength(serialized));
    expect(f.receiver.receive(frames[1]!)).toBe('record');
    expect(owner.received).toHaveBeenCalledWith(serialized, 13);
    expect(owner.received).toHaveBeenCalledTimes(1); expect(f.budget.reservedBytes).toBe(0);
  } finally { f.receiver.close(); }
});

test('reconnect discards partial assembly while old chunks, closes and attempt tokens cannot affect replacement', () => {
  const f = fixture(); const owner = f.install();
  try {
    const old = f.receiver.begin(1, 1, [{ stream, afterSequence: 0 }], f.physical.signal);
    const before = chunks(stream, 1, 1, 1, true);
    expect(f.receiver.receive(before[0]!)).toBe('chunk');
    const replacement = new AbortController();
    const current = f.receiver.begin(2, 2, [{ stream, afterSequence: 0 }], replacement.signal);
    expect(f.budget.reservedBytes).toBe(0); expect(f.receiver.suspend(old)).toBe(false);
    expect(f.receiver.receive(before[1]!)).toBe('retired');
    const after = chunks(stream, 1, 2, 2, true);
    expect(f.receiver.receive(after[0]!)).toBe('chunk');
    f.physical.abort();
    expect(f.budget.reservedBytes).toBeGreaterThan(0);
    expect(f.receiver.receive(after[1]!)).toBe('record');
    expect(owner.received).toHaveBeenCalledTimes(1); expect(owner.failed).not.toHaveBeenCalled();
    expect(f.receiver.suspend(current)).toBe(true);
    expect(() => f.receiver.begin(2, 2, [{ stream, afterSequence: 1 }], replacement.signal)).toThrow();
  } finally { f.receiver.close(); }
});

test('attempt generations fence replay replacement on the same physical connection', () => {
  const f = fixture(); const owner = f.install();
  try {
    f.receiver.begin(1, 1, [{ stream, afterSequence: 0 }], f.physical.signal);
    f.receiver.receive(chunks(stream, 1, 1, 1, true)[0]!);
    f.receiver.begin(1, 2, [{ stream, afterSequence: 0 }], f.physical.signal);
    expect(f.budget.reservedBytes).toBe(0);
    expect(f.receiver.receive(chunks(stream, 1, 1, 1)[0]!)).toBe('retired');
    expect(f.receiver.receive(chunks(stream, 1, 1, 2)[0]!)).toBe('record');
    expect(owner.received).toHaveBeenCalledTimes(1);
  } finally { f.receiver.close(); }
});

test('suspension clears partial transit once and preserves routes across stale notices and chunks', () => {
  const f = fixture(); const owner = f.install();
  try {
    const notice = serializeNodeWorkerOutputSuspension({ type: 'node-worker-output-suspended', version: 1, session, connectionId: 1, generation: 1 });
    f.receiver.begin(1, 1, [{ stream, afterSequence: 0 }], f.physical.signal);
    const partial = chunks(stream, 1, 1, 1, true);
    f.receiver.receive(partial[0]!);
    expect(f.budget.reservedBytes).toBeGreaterThan(0);
    expect(f.receiver.receiveSuspension(notice)).toBe(true);
    expect(f.receiver.receiveSuspension(notice)).toBe(false);
    expect(f.budget.reservedBytes).toBe(0);
    expect(f.receiver.receive(partial[1]!)).toBe('retired');
    f.receiver.begin(1, 2, [{ stream, afterSequence: 0 }], f.physical.signal);
    expect(f.receiver.receiveSuspension(notice)).toBe(false);
    expect(f.receiver.receive(chunks(stream, 1, 1, 2)[0]!)).toBe('record');
    expect(owner.received).toHaveBeenCalledTimes(1); expect(owner.failed).not.toHaveBeenCalled();
    expect(f.failed).not.toHaveBeenCalled();
  } finally { f.receiver.close(); }
});

test('retirement arriving before publication installation cannot resurrect that route', () => {
  const f = fixture();
  try {
    f.receiver.receiveRetirement(serializeNodeWorkerOutputRetirement({ type: 'node-worker-output-retired', version: 1, instanceId, stream }));
    expect(() => f.install()).toThrow('rebound');
    const neighbor = f.install(sibling);
    f.receiver.begin(1, 1, [{ stream: sibling, afterSequence: 0 }], f.physical.signal);
    expect(f.receiver.receive(chunks(sibling, 1)[0]!)).toBe('record');
    expect(neighbor.failed).not.toHaveBeenCalled();
  } finally { f.receiver.close(); }
});

test('logical routes cannot rebind and retain their immutable instance after retirement and reconnect', () => {
  const f = fixture(); f.install();
  try {
    expect(() => f.install(stream, otherInstance)).toThrow('rebound');
    f.receiver.retire(stream);
    expect(() => f.install()).toThrow('rebound');
    f.receiver.begin(1, 1, [], f.physical.signal);
    expect(f.receiver.receive(chunks(stream, 1)[0]!)).toBe('retired');
    expect(() => f.receiver.receive(chunks(stream, 1, 1, 1, false, otherInstance)[0]!)).toThrow('NODE_WORKER_PROTOCOL');
  } finally { f.receiver.close(); }
});

test('all live routes require one valid recovery cursor before replacing the physical attempt', () => {
  const f = fixture(); const owner = f.install(); f.install(sibling);
  const positions = [{ stream, afterSequence: 0 }, { stream: sibling, afterSequence: 0 }];
  try {
    f.receiver.begin(1, 1, positions, f.physical.signal);
    for (const cursors of [[], positions.slice(0, 1), [...positions, positions[0]!],
      [{ stream, afterSequence: -1 }, positions[1]!], [{ stream, afterSequence: 1.5 }, positions[1]!]]) {
      expect(() => f.receiver.begin(2, 2, cursors, f.physical.signal)).toThrow();
    }
    expect(f.receiver.receive(chunks(stream, 1)[0]!)).toBe('record');
    expect(owner.received).toHaveBeenCalledTimes(1);
  } finally { f.receiver.close(); }
});

test('logical retirement releases an abandoned record before a same-instance sibling arrives', () => {
  const f = fixture(); const owner = f.install(); const neighbor = f.install(sibling);
  const retired = serializeNodeWorkerOutputRetirement({ type: 'node-worker-output-retired', version: NODE_WIRE_VERSION, instanceId, stream });
  owner.failed.mockImplementation(() => { f.receiver.receiveRetirement(retired); });
  try {
    f.receiver.begin(1, 1, [{ stream, afterSequence: 0 }, { stream: sibling, afterSequence: 0 }], f.physical.signal);
    f.receiver.receive(chunks(stream, 1, 1, 1, true)[0]!);
    f.receiver.receiveRetirement(retired);
    expect(f.budget.reservedBytes).toBe(0); expect(owner.failed).toHaveBeenCalledTimes(1);
    expect(f.receiver.receive(chunks(sibling, 1)[0]!)).toBe('record');
    expect(neighbor.failed).not.toHaveBeenCalled(); expect(neighbor.received).toHaveBeenCalledTimes(1);
    expect(f.receiver.receive(chunks(stream, 1, 1, 1, true)[1]!)).toBe('retired');
  } finally { f.receiver.close(); }
});

test('logical retirement applies while disconnected without retiring a sibling publication route', () => {
  const f = fixture(); const owner = f.install(); const neighbor = f.install(sibling);
  try {
    f.receiver.receiveRetirement(serializeNodeWorkerOutputRetirement({ type: 'node-worker-output-retired', version: NODE_WIRE_VERSION, instanceId, stream }));
    f.receiver.begin(2, 3, [{ stream: sibling, afterSequence: 0 }], f.physical.signal);
    expect(f.receiver.receive(chunks(sibling, 1, 2, 3)[0]!)).toBe('record');
    expect(owner.failed).toHaveBeenCalledTimes(1); expect(neighbor.failed).not.toHaveBeenCalled();
  } finally { f.receiver.close(); }
});

test('unknown retirement at exhausted identity capacity cannot fail an existing publication route', () => {
  const f = fixture(); const owner = f.install();
  try {
    for (let i = 1; i < MAX_NODE_STREAM_IDENTITIES; i++) f.receiver.receiveRetirement(serializeNodeWorkerOutputRetirement({
      type: 'node-worker-output-retired', version: NODE_WIRE_VERSION, instanceId, stream: { ...stream, streamId: `retired-${i}` },
    }));
    expect(() => f.install(sibling)).toThrow('identity');
    expect(() => f.receiver.receiveRetirement(serializeNodeWorkerOutputRetirement({
      type: 'node-worker-output-retired', version: NODE_WIRE_VERSION, instanceId, stream: sibling,
    }))).not.toThrow();
    f.receiver.begin(1, 1, [{ stream, afterSequence: 0 }], f.physical.signal);
    expect(f.receiver.receive(chunks(stream, 1)[0]!)).toBe('record');
    expect(owner.failed).not.toHaveBeenCalled(); expect(f.failed).not.toHaveBeenCalled();
  } finally { f.receiver.close(); }
});

test('a shared assembly budget bounds two logical sessions and isolates capacity failure', () => {
  const budget = new NodeOutputAssemblyBudget(100_000);
  const f = fixture(budget); const owner = f.install();
  const secondSession = { ...session, logicalSessionId: 'synthetic-second-session' };
  const secondStream = { ...secondSession, streamId: stream.streamId };
  const g = fixture(budget, secondSession); const other = g.install(secondStream);
  try {
    f.receiver.begin(1, 1, [{ stream, afterSequence: 0 }], f.physical.signal);
    g.receiver.begin(1, 1, [{ stream: secondStream, afterSequence: 0 }], g.physical.signal);
    const first = chunks(stream, 1, 1, 1, true);
    expect(f.receiver.receive(first[0]!)).toBe('chunk');
    expect(g.receiver.receive(chunks(secondStream, 1, 1, 1, true)[0]!)).toBe('retired');
    expect(other.failed).toHaveBeenCalledWith(expect.objectContaining({ code: 'NODE_CAPACITY' }));
    expect(owner.failed).not.toHaveBeenCalled(); expect(g.failed).not.toHaveBeenCalled();
    expect(f.receiver.receive(first[1]!)).toBe('record'); expect(budget.reservedBytes).toBe(0);
  } finally { f.receiver.close(); g.receiver.close(); }
});

test('an uncertain publication retires only its route and cannot be retried after reconnect', () => {
  const f = fixture(); const owner = f.install(); const neighbor = f.install(sibling);
  const error = new Error('Synthetic uncertain publication'); owner.received.mockImplementation(() => { throw error; });
  try {
    f.receiver.begin(1, 1, [{ stream, afterSequence: 0 }, { stream: sibling, afterSequence: 0 }], f.physical.signal);
    expect(f.receiver.receive(chunks(stream, 1)[0]!)).toBe('retired'); expect(owner.failed).toHaveBeenCalledWith(error);
    f.receiver.begin(2, 2, [{ stream: sibling, afterSequence: 0 }], f.physical.signal);
    expect(f.receiver.receive(chunks(stream, 1, 2, 2)[0]!)).toBe('retired');
    expect(f.receiver.receive(chunks(sibling, 1, 2, 2)[0]!)).toBe('record');
    expect(owner.received).toHaveBeenCalledTimes(1); expect(neighbor.failed).not.toHaveBeenCalled();
  } finally { f.receiver.close(); }
});

test('authority failure releases shared assembly immediately and reports the logical session once', () => {
  const f = fixture(); f.install();
  try {
    f.receiver.begin(1, 1, [{ stream, afterSequence: 0 }], f.physical.signal);
    f.receiver.receive(chunks(stream, 1, 1, 1, true)[0]!);
    const error = new Error('Synthetic authority loss'); f.validate.mockImplementation(() => { throw error; });
    expect(() => f.receiver.receive(chunks(stream, 1)[0]!)).toThrow(error);
    expect(f.budget.reservedBytes).toBe(0); expect(f.failed).toHaveBeenCalledTimes(1);
    expect(f.failed).toHaveBeenCalledWith(error);
  } finally { f.receiver.close(); }
});
