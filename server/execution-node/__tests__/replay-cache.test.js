import { describe, expect, test } from 'bun:test';
import { parseNodeReplayReply } from '@garcon/server-agent-interface';
import { NodeReplayCache, DEFAULT_NODE_REPLAY, MAX_NODE_STREAM_IDENTITIES } from '../replay-cache.js';

const stream = (streamId = 'stream-a') => ({
  controllerBootId: 'controller-boot-a', nodeBootId: 'node-boot-a', logicalSessionId: 'session-a', streamId,
});

function fixture(overrides = {}) {
  let now = 0;
  const cache = new NodeReplayCache({ ...DEFAULT_NODE_REPLAY, ...overrides }, () => now);
  const identity = stream();
  cache.register(identity);
  return { cache, identity, advance: (ms) => { now += ms; } };
}

describe('node output replay retention', () => {
  test('uses remote-only five-minute and aggregate 20 MiB defaults', () => {
    expect(DEFAULT_NODE_REPLAY).toEqual({ enabled: true, maxAgeMs: 300_000, maxBytes: 20 * 1024 * 1024 });
    expect(Object.isFrozen(DEFAULT_NODE_REPLAY)).toBe(true);
  });

  test('rejects invalid retention bounds and nonboolean enablement', () => {
    for (const enabled of [undefined, null, 0, 'true']) {
      expect(() => new NodeReplayCache({ ...DEFAULT_NODE_REPLAY, enabled })).toThrow('configuration');
    }
    for (const bound of [0, -1, 0.5, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => new NodeReplayCache({ ...DEFAULT_NODE_REPLAY, maxAgeMs: bound })).toThrow('configuration');
      expect(() => new NodeReplayCache({ ...DEFAULT_NODE_REPLAY, maxBytes: bound })).toThrow('configuration');
    }
    expect(() => new NodeReplayCache({ enabled: false, maxAgeMs: 1, maxBytes: 1 })).not.toThrow();
  });

  test('invalid clock readings reject appends and replay without advancing or pruning output', () => {
    const { cache, identity, advance } = fixture();
    cache.append(identity, 1, 'retained');
    advance(-1);
    for (const operation of [
      () => cache.append(identity, 2, 'invalid'), () => cache.capture(identity, 0),
      () => cache.read(identity, 1, 1), () => cache.prune(), () => cache.retainedBytes,
    ]) expect(operation).toThrow('Invalid replay clock');
    advance(1);
    expect(cache.capture(identity, 0)).toMatchObject({ type: 'node-replay-ready', throughSequence: 1 });
    expect(cache.read(identity, 1, 1)).toMatchObject({ serialized: 'retained' });
    expect(cache.retainedBytes).toBe(Buffer.byteLength('retained'));
    cache.append(identity, 2, 'valid');
    expect(cache.capture(identity, 0)).toMatchObject({ throughSequence: 2 });

    for (const invalid of [NaN, Infinity, -Infinity]) {
      let now = 0;
      const checked = new NodeReplayCache(DEFAULT_NODE_REPLAY, () => now);
      checked.register(identity);
      checked.append(identity, 1, 'retained');
      now = invalid;
      expect(() => checked.append(identity, 2, 'invalid')).toThrow('Invalid replay clock');
      expect(() => checked.prune()).toThrow('Invalid replay clock');
      now = 0;
      expect(checked.capture(identity, 0)).toMatchObject({ throughSequence: 1 });
      expect(checked.read(identity, 1, 1)).toMatchObject({ serialized: 'retained' });
      expect(checked.retainedBytes).toBe(Buffer.byteLength('retained'));
    }
  });

  test('replays immutable records through a fixed captured watermark', () => {
    const { cache, identity } = fixture();
    cache.append(identity, 1, 'first');
    cache.append(identity, 2, 'second');
    expect(cache.capture(identity, 0)).toEqual({
      type: 'node-replay-ready', stream: identity, afterSequence: 0, throughSequence: 2,
    });
    cache.append(identity, 3, 'new live suffix');
    expect(cache.read(identity, 1, 2)).toEqual({ kind: 'record', sequence: 1, serialized: 'first' });
    expect(cache.read(identity, 2, 2)).toEqual({ kind: 'record', sequence: 2, serialized: 'second' });
    expect(() => cache.read(identity, 3, 2)).toThrow('range');
    cache.acknowledge(identity, 2);
    expect(cache.retainedBytes).toBe(Buffer.byteLength('new live suffix'));
    expect(cache.capture(identity, 2)).toMatchObject({ afterSequence: 2, throughSequence: 3 });
  });

  test('enforces age at the boundary and reports an empty cache as a gap', () => {
    const { cache, identity, advance } = fixture({ maxAgeMs: 5 });
    cache.append(identity, 1, 'one');
    advance(4);
    expect(cache.capture(identity, 0).type).toBe('node-replay-ready');
    advance(1);
    expect(cache.capture(identity, 0)).toEqual({
      type: 'node-replay-gap', stream: identity, requestedAfter: 0,
      firstRetainedSequence: 2, lastProducedSequence: 1,
    });
    expect(cache.retainedBytes).toBe(0);
    expect(cache.streamCount).toBe(1);
    expect(cache.capture(identity, 1)).toMatchObject({ type: 'node-replay-ready', throughSequence: 1 });
  });

  test('evicts the oldest whole records across streams, including UTF-8 bytes', () => {
    const { cache, identity } = fixture({ maxBytes: 6 });
    const other = stream('stream-b');
    cache.register(other);
    cache.append(identity, 1, 'éé');
    cache.append(other, 1, 'bbb');
    expect(cache.retainedBytes).toBe(3);
    expect(cache.capture(identity, 0).type).toBe('node-replay-gap');
    expect(cache.read(other, 1, 1)).toMatchObject({ serialized: 'bbb' });
    cache.append(identity, 2, 'aaa');
    expect(cache.retainedBytes).toBe(6);
    expect(cache.capture(identity, 0)).toMatchObject({ firstRetainedSequence: 2, lastProducedSequence: 2 });
    cache.append(other, 2, 'b');
    expect(cache.retainedBytes).toBe(4);
    expect(cache.capture(other, 0)).toMatchObject({ firstRetainedSequence: 2 });
  });

  test('one oversized record is lost whole without retiring its live route', () => {
    const { cache, identity } = fixture({ maxBytes: 3 });
    cache.append(identity, 1, 'a');
    cache.append(identity, 2, 'oversized');
    expect(cache.retainedBytes).toBe(0);
    expect(cache.streamCount).toBe(1);
    expect(cache.capture(identity, 0)).toMatchObject({
      type: 'node-replay-gap', firstRetainedSequence: 3, lastProducedSequence: 2,
    });
    cache.append(identity, 3, 'ok');
    expect(cache.read(identity, 3, 3)).toMatchObject({ serialized: 'ok' });
  });

  test('disabled retention still sequences output and discloses loss', () => {
    const { cache, identity } = fixture({ enabled: false });
    cache.append(identity, 1, 'synthetic output');
    expect(cache.retainedBytes).toBe(0);
    expect(cache.capture(identity, 0)).toMatchObject({ type: 'node-replay-gap', lastProducedSequence: 1 });
    cache.acknowledge(identity, 1);
    expect(cache.capture(identity, 1)).toMatchObject({ type: 'node-replay-ready', throughSequence: 1 });
  });

  test('eviction during replay reports a new exact gap rather than pinning retention', () => {
    const { cache, identity, advance } = fixture({ maxAgeMs: 5 });
    cache.append(identity, 1, 'one');
    advance(1);
    cache.append(identity, 2, 'two');
    const captured = cache.capture(identity, 0);
    expect(captured.type).toBe('node-replay-ready');
    expect(cache.read(identity, 1, captured.throughSequence)).toMatchObject({ kind: 'record' });
    advance(5);
    cache.append(identity, 3, 'live');
    expect(cache.read(identity, 2, captured.throughSequence)).toMatchObject({
      type: 'node-replay-gap', requestedAfter: 1, firstRetainedSequence: 3, lastProducedSequence: 3,
    });
  });

  test('gap replies remain valid wire values for retained suffixes and all-evicted sentinels', () => {
    for (const bounds of [{ maxBytes: 2 }, { maxAgeMs: 1 }, { enabled: false }]) {
      const { cache, identity, advance } = fixture(bounds);
      cache.append(identity, 1, 'one');
      advance(1);
      cache.append(identity, 2, 'a');
      const captured = cache.capture(identity, 0);
      const duringReplay = cache.read(identity, 1, 2);
      for (const reply of [captured, duringReplay]) {
        expect(reply.type).toBe('node-replay-gap');
        expect(parseNodeReplayReply(reply)).toEqual(reply);
      }
      cache.acknowledge(identity, 2);
      const empty = cache.capture(identity, 0);
      expect(empty).toMatchObject({ firstRetainedSequence: 3, lastProducedSequence: 2 });
      expect(parseNodeReplayReply(empty)).toEqual(empty);
    }
  });

  test('rejects invalid cursors and incarnation aliases without changing retained output', () => {
    const { cache, identity } = fixture();
    cache.append(identity, 1, 'one');
    for (const cursor of [-1, 1.5, 2, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => cache.acknowledge(identity, cursor)).toThrow();
      expect(() => cache.capture(identity, cursor)).toThrow();
    }
    expect(() => cache.append(identity, 1, 'duplicate')).toThrow();
    expect(() => cache.append(identity, 3, 'gap')).toThrow();
    expect(() => cache.register(identity)).toThrow();
    expect(() => cache.capture({ ...identity, nodeBootId: 'node-boot-b' }, 0)).toThrow();
    expect(cache.read(identity, 1, 1)).toMatchObject({ serialized: 'one' });
  });

  test('retirement frees only that stream and restart retains no counters', () => {
    const { cache, identity } = fixture();
    const other = stream('stream-b');
    cache.register(other);
    cache.append(identity, 1, 'one');
    cache.append(other, 1, 'two');
    cache.retire(identity);
    cache.retire(identity);
    expect(cache.streamCount).toBe(1);
    expect(cache.retainedBytes).toBe(3);
    expect(() => cache.capture(identity, 0)).toThrow();
    cache.clear();
    expect(cache.streamCount).toBe(0);
    expect(cache.retainedBytes).toBe(0);
    expect(() => new NodeReplayCache().capture(other, 0)).toThrow();
  });

  test('a local clock regression conservatively evicts retained bytes without forgetting production', () => {
    const { cache, identity, advance } = fixture();
    advance(5);
    cache.append(identity, 1, 'one');
    advance(-1);
    expect(cache.capture(identity, 0)).toMatchObject({ type: 'node-replay-gap', lastProducedSequence: 1 });
  });

  test('retired stream identities cannot be reused even after every retained byte is freed', () => {
    const { cache, identity } = fixture();
    cache.append(identity, 1, 'one');
    cache.retire(identity);
    expect(cache.retainedBytes).toBe(0);
    expect(() => cache.register({ ...identity })).toThrow('already registered');
    cache.register({ ...identity, logicalSessionId: 'fresh-logical-session' });
    expect(cache.streamCount).toBe(1);
  });

  test('late acknowledgements are harmless and unavailable replay has a typed failure', () => {
    const { cache, identity } = fixture();
    cache.append(identity, 1, 'one');
    cache.retire(identity);
    for (const unavailable of [identity, stream('unknown')]) {
      expect(() => cache.acknowledge(unavailable, 1)).not.toThrow();
      for (const read of [() => cache.capture(unavailable, 0), () => cache.read(unavailable, 1, 1)]) {
        let failure;
        try { read(); } catch (error) { failure = error; }
        expect(failure).toMatchObject({ name: 'NodeReplayUnavailableError', code: 'NODE_REPLAY_GAP' });
      }
    }
  });

  test('namespace teardown releases metadata without permitting old grants to restart', () => {
    const { cache, identity } = fixture();
    cache.append(identity, 1, 'one');
    cache.clear();
    expect(cache.streamCount).toBe(0);
    expect(cache.retainedBytes).toBe(0);
    expect(() => cache.register(identity)).toThrow('closed');
    expect(() => cache.register(stream('fresh-stream'))).toThrow('closed');
    expect(() => cache.acknowledge(identity, 1)).not.toThrow();
  });

  test('bounds identity metadata without recycling tombstones or evicting a live publisher', () => {
    const { cache, identity } = fixture();
    cache.append(identity, 1, 'live');
    for (let index = 1; index < MAX_NODE_STREAM_IDENTITIES; index += 1) {
      const retired = stream(`retired-${index}`);
      cache.register(retired);
      cache.retire(retired);
    }
    expect(cache.streamCount).toBe(1);
    expect(cache.retainedBytes).toBe(4);
    expect(() => cache.register(stream('one-more'))).toThrow('identity limit');
    expect(() => cache.register(stream('retired-1'))).toThrow('already registered');
    cache.append(identity, 2, 'still live');
    expect(cache.read(identity, 2, 2)).toMatchObject({ serialized: 'still live' });
  });
});
