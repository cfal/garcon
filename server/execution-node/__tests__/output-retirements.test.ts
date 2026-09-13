import { expect, test } from 'bun:test';
import { NodeOutputRetirements } from '../output-retirements.js';
import { MAX_NODE_STREAM_IDENTITIES } from '../replay-cache.js';
import { session, tick } from '../worker/__tests__/lifecycle-fixture.js';
import type { NodeWorkerOutputRetirement } from '../worker/output-retirement.js';

const retirement = (streamId = 'synthetic-stream'): NodeWorkerOutputRetirement => ({
  type: 'node-worker-output-retired', reason: 'output-retired', version: 1, instanceId: 'synthetic-instance', stream: { ...session, streamId },
});
function fixture() {
  const authority = new AbortController();
  const retained = new NodeOutputRetirements({ session, instanceIds: new Set(['synthetic-instance', 'synthetic-other']), signal: authority.signal });
  return { authority, retained };
}

test('lost physical delivery retains immutable retirements for every replacement connection', async () => {
  const f = fixture();
  const first = { ...retirement(), stream: { ...retirement().stream } };
  const captured = f.retained.record(first);
  first.stream.streamId = 'synthetic-mutated';
  f.retained.record(retirement('synthetic-second'));
  expect(f.retained.record(retirement())).toBe(captured);
  const failed: string[] = [];
  await expect(f.retained.replay(async (frame) => {
    failed.push(frame.stream.streamId);
    throw new Error('Synthetic socket loss');
  }, new AbortController().signal)).rejects.toThrow('Synthetic socket loss');
  expect(failed).toEqual(['synthetic-stream']);
  for (let attempt = 0; attempt < 2; attempt++) {
    const received: string[] = [];
    await f.retained.replay(async (frame) => { received.push(frame.stream.streamId); }, new AbortController().signal);
    expect(received).toEqual(['synthetic-stream', 'synthetic-second']);
  }
  f.authority.abort();
});

test('an offline replay-gap retirement retains its original cause across duplicate fences and physical loss', async () => {
  const f = fixture();
  const frame: NodeWorkerOutputRetirement = { ...retirement(), reason: 'replay-gap' };
  try {
    const captured = f.retained.record(frame);
    expect(f.retained.record(retirement())).toBe(captured);
    await expect(f.retained.replay(async () => { throw new Error('Synthetic socket loss'); }, new AbortController().signal))
      .rejects.toThrow('Synthetic socket loss');
    const received: NodeWorkerOutputRetirement[] = [];
    await f.retained.replay(async (frame) => { received.push(frame); }, new AbortController().signal);
    expect(received).toEqual([frame]);
  } finally { f.authority.abort(); }
});

test('a retirement observed during replay reaches the same barrier before it completes', async () => {
  const f = fixture();
  f.retained.record(retirement());
  const received: string[] = [];
  await f.retained.replay(async (frame) => {
    received.push(frame.stream.streamId);
    if (received.length === 1) f.retained.record(retirement('synthetic-second'));
  }, new AbortController().signal);
  expect(received).toEqual(['synthetic-stream', 'synthetic-second']);
  f.authority.abort();
});

test('cancelled native sends remain single-flight until settlement without losing retained metadata', async () => {
  const f = fixture();
  f.retained.record(retirement());
  const physical = new AbortController();
  const sent = Promise.withResolvers<void>();
  const replay = f.retained.replay(async () => sent.promise, physical.signal);
  await tick();
  physical.abort(new Error('Synthetic physical cancellation'));
  let received = 0;
  const replacement = f.retained.replay(async () => { received++; }, new AbortController().signal);
  await tick(); expect(received).toBe(0);
  sent.resolve();
  await expect(replay).rejects.toThrow('Synthetic physical cancellation');
  await replacement;
  expect(received).toBe(1);
  f.authority.abort();
});

test('logical retirement closes replay and rejects late native completion', async () => {
  const f = fixture();
  f.retained.record(retirement());
  const sent = Promise.withResolvers<void>();
  const replay = f.retained.replay(async () => sent.promise, new AbortController().signal);
  f.authority.abort();
  sent.resolve();
  await expect(replay).rejects.toMatchObject({ code: 'NODE_WORKER_CLOSED' });
  await expect(f.retained.replay(async () => {}, new AbortController().signal)).rejects.toMatchObject({ code: 'NODE_WORKER_CLOSED' });
  expect(() => f.retained.record(retirement('synthetic-late'))).toThrow();
});

test('foreign sessions and changed stream ownership cannot corrupt retained retirement routing', () => {
  const f = fixture();
  f.retained.record(retirement());
  expect(() => f.retained.record({ ...retirement(), instanceId: 'synthetic-other' })).toThrow();
  expect(() => f.retained.record({ ...retirement(), instanceId: 'synthetic-unknown' })).toThrow();
  expect(() => f.retained.record({ ...retirement(), stream: { ...session, streamId: 'synthetic-next', logicalSessionId: 'synthetic-foreign' } })).toThrow();
  f.authority.abort();
});

test('the permanent stream identity bound rejects overflow while preserving every recorded retirement', async () => {
  const f = fixture();
  for (let i = 0; i < MAX_NODE_STREAM_IDENTITIES; i++) f.retained.record(retirement(`synthetic-${i}`));
  expect(() => f.retained.record(retirement('synthetic-overflow'))).toThrow();
  expect(() => f.retained.record(retirement('synthetic-0'))).not.toThrow();
  let received = 0;
  await f.retained.replay(async () => { received++; }, new AbortController().signal);
  expect(received).toBe(MAX_NODE_STREAM_IDENTITIES);
  f.authority.abort();
});
