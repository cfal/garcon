import { expect, mock, test } from 'bun:test';
import { MAX_EXECUTION_IDENTITY_LENGTH } from '../../../../common/execution-location.js';
import { NODE_CHALLENGE_INTERVAL_MS, NODE_CONTROLLER_LEASE_MS } from '../../../execution-node/supervisor.js';
import { MAX_NODE_LEASE_FRAME_BYTES, serializeNodeLeaseFrame } from '../lease-wire.js';
import { NodeSocketWriter, NODE_SOCKET_PROTOCOL_ALLOWANCE_BYTES, type NodeSocketPort } from '../socket-writer.js';

function fixture(maxBufferedBytes = 20) {
  let bufferedBytes = 0;
  let open = true;
  let now = 0;
  let scheduled: (() => void) | null = null;
  const intervals: number[] = [];
  const physical = new AbortController();
  const port = {
    get open() { return open; }, get bufferedBytes() { return bufferedBytes; },
    bufferedFrameBytes: (length: number) => length + 2,
    send: mock((serialized: string) => { bufferedBytes += Buffer.byteLength(serialized) + 2; return true; }),
    terminate: mock(() => { open = false; }),
  } satisfies NodeSocketPort;
  const writer = new NodeSocketWriter(port, { signal: physical.signal, maxFrameBytes: 8, maxBufferedBytes, reservedControlBytes: 10, reservedLifecycleBytes: 4,
    maxDrainWaiters: 2, drainTimeoutMs: 100, now: () => now,
    schedulePoll(callback, delayMs) { intervals.push(delayMs); scheduled = callback; return { cancel() { scheduled = null; } }; },
  });
  return { writer, port, physical, intervals, buffer(bytes: number) { bufferedBytes = bytes; },
    advance(ms: number) { now += ms; }, tick() { const callback = scheduled; scheduled = null; callback?.(); },
    scheduled: () => scheduled !== null,
  };
}

test('socket writes count actual UTF-8 bytes and reject overflow before sending another frame', () => {
  const f = fixture();
  f.writer.send('éééé');
  f.writer.send('12345678');
  expect(f.writer.send('x')).toBe(false);
  expect(f.port.send).toHaveBeenCalledTimes(2);
  expect(f.port.terminate).not.toHaveBeenCalled();
  f.writer.close();
});

test('synchronous data refusal preserves the control reserve and never queues a retry', () => {
  const f = fixture();
  expect(f.writer.sendData('éééé')).toBe(true);
  expect(f.writer.sendData('x')).toBe(false);
  expect(f.writer.send('12345678')).toBe(true);
  expect(f.port.send.mock.calls).toEqual([['éééé'], ['12345678']]);
  f.buffer(0); f.writer.drain();
  expect(f.port.send).toHaveBeenCalledTimes(2);
  expect(f.port.terminate).not.toHaveBeenCalled();
  f.writer.close();
});

test('application traffic uses reserved headroom while preserving framed lifecycle capacity', () => {
  const f = fixture(40);
  try {
    f.buffer(30);
    expect(f.writer.sendData('x')).toBe(false);
    expect(f.writer.sendApplication('next')).toBe(true);
    expect(f.port.bufferedBytes).toBe(36);
    expect(f.writer.sendApplication('x')).toBe(false);
    expect(f.writer.send('go')).toBe(true);
    expect(f.port.bufferedBytes).toBe(40);
    expect(f.port.send.mock.calls).toEqual([['next'], ['go']]);
    expect(f.port.terminate).not.toHaveBeenCalled();
  } finally { f.writer.close(); }
});

test.each(['node-lease-challenge', 'node-lease-renewal'] as const)('the 4 KiB lifecycle reserve fits a legal %s burst with framing', (type) => {
  const maxBufferedBytes = 64 * 1024;
  const reservedLifecycleBytes = 4 * 1024;
  let bufferedBytes = maxBufferedBytes - reservedLifecycleBytes;
  const port = { open: true, get bufferedBytes() { return bufferedBytes; },
    bufferedFrameBytes: (length: number) => length + 14,
    send: mock((text: string) => { bufferedBytes += Buffer.byteLength(text) + 14; return true; }), terminate: mock(() => {}),
  } satisfies NodeSocketPort;
  const writer = new NodeSocketWriter(port, { signal: new AbortController().signal,
    maxFrameBytes: MAX_NODE_LEASE_FRAME_BYTES, maxBufferedBytes, reservedControlBytes: 16 * 1024, reservedLifecycleBytes,
    maxDrainWaiters: 1, drainTimeoutMs: 100, schedulePoll: () => ({ cancel() {} }) });
  const identity = 'x'.repeat(MAX_EXECUTION_IDENTITY_LENGTH);
  const session = { controllerBootId: identity, nodeBootId: identity, logicalSessionId: identity };
  const burst = Math.ceil(NODE_CONTROLLER_LEASE_MS / NODE_CHALLENGE_INTERVAL_MS);
  try {
    expect(writer.sendApplication('x')).toBe(false);
    for (let index = 0; index < burst; index++) {
      expect(writer.send(serializeNodeLeaseFrame({ type, version: 1, session,
        challengeId: String(index).padStart(MAX_EXECUTION_IDENTITY_LENGTH, 'x') }))).toBe(true);
    }
    expect(port.send).toHaveBeenCalledTimes(burst);
    expect(bufferedBytes).toBeLessThanOrEqual(maxBufferedBytes);
    expect(port.terminate).not.toHaveBeenCalled();
  } finally { writer.close(); }
});

test('application writable waiting sends after enough partial drain and retains lifecycle headroom', async () => {
  const f = fixture(40);
  try {
    f.buffer(40);
    const sent = f.writer.sendApplicationWhenWritable('next', f.physical.signal, () => {});
    f.buffer(31); f.writer.drain(); await Promise.resolve();
    expect(f.port.send).not.toHaveBeenCalled();
    f.buffer(30); f.writer.drain(); await sent;
    expect(f.port.bufferedBytes).toBe(36);
    expect(f.writer.sendData('x')).toBe(false);
    expect(f.writer.send('go')).toBe(true);
    expect(f.port.send.mock.calls).toEqual([['next'], ['go']]);
  } finally { f.writer.close(); }
});

test('cancelling an application writable wait prevents delivery after later drainage', async () => {
  const f = fixture(40);
  const caller = new AbortController();
  try {
    f.buffer(40);
    const sent = f.writer.sendApplicationWhenWritable('next', caller.signal, () => {}).catch((error: unknown) => error);
    caller.abort();
    expect(await sent).toBe(caller.signal.reason);
    f.buffer(0); f.writer.drain(); await Promise.resolve();
    expect(f.port.send).not.toHaveBeenCalled();
    expect(f.port.terminate).not.toHaveBeenCalled();
  } finally { f.writer.close(); }
});

test('drain observes the physical queue without retransmitting accepted frames', async () => {
  const f = fixture();
  f.writer.send('synthet');
  const drained = f.writer.drained(f.physical.signal);
  let settled = false;
  void drained.then(() => { settled = true; });
  f.tick();
  await Promise.resolve();
  expect(settled).toBe(false);
  f.buffer(0);
  f.writer.drain();
  await drained;
  expect(f.port.send).toHaveBeenCalledTimes(1);
  expect(f.scheduled()).toBe(true);
  f.writer.close();
});

test('idle native protocol growth is observed both before the first application write and after full drain', () => {
  for (const priorWrite of [false, true]) {
    const f = fixture();
    if (priorWrite) { f.writer.send('synthet'); f.buffer(0); f.writer.drain(); }
    const sent = f.port.send.mock.calls.length;
    f.buffer(20 + NODE_SOCKET_PROTOCOL_ALLOWANCE_BYTES + 1);
    f.tick();
    expect(f.port.send).toHaveBeenCalledTimes(sent);
    expect(f.port.terminate).toHaveBeenCalledTimes(1);
    expect(f.scheduled()).toBe(false);
    expect(() => f.writer.send('next')).toThrow('unavailable');
  }
});

test('a small idle protocol backlog expires without a waiter or application write', () => {
  const f = fixture();
  f.buffer(131);
  f.tick();
  f.advance(99); f.tick();
  expect(f.port.terminate).not.toHaveBeenCalled();
  f.advance(1); f.tick();
  expect(f.port.send).not.toHaveBeenCalled();
  expect(f.port.terminate).toHaveBeenCalledTimes(1);
  expect(f.scheduled()).toBe(false);
});

test('idle observation uses a slower cadence and returns to it after native drain', () => {
  const f = fixture();
  try {
    expect(f.intervals).toEqual([100]);
    f.tick();
    expect(f.intervals).toEqual([100, 100]);
    f.buffer(131); f.tick();
    expect(f.intervals.at(-1)).toBe(10);
    f.buffer(0); f.tick();
    expect(f.intervals.at(-1)).toBe(100);
  } finally { f.writer.close(); }
});

test('application bursts shorten a pending idle sample before a drain waiter can stall', async () => {
  const f = fixture();
  try {
    for (let burst = 0; burst < 3; burst += 1) {
      expect(f.intervals.at(-1)).toBe(100);
      f.writer.send('synthet');
      const drained = f.writer.drained(f.physical.signal);
      expect(f.intervals.at(-1)).toBe(10);
      f.advance(10); f.buffer(0); f.tick();
      await drained;
    }
    expect(f.port.send).toHaveBeenCalledTimes(3);
    expect(f.port.terminate).not.toHaveBeenCalled();
  } finally { f.writer.close(); }
});

test('physical disconnect settles every waiter without touching a replacement writer', async () => {
  const old = fixture();
  const replacement = fixture();
  old.writer.send('synthet');
  const first = old.writer.drained(old.physical.signal).catch((error) => error);
  const second = old.writer.drained(old.physical.signal).catch((error) => error);
  old.physical.abort();
  expect(await first).toMatchObject({ code: 'NODE_SOCKET_CLOSED' });
  expect(await second).toMatchObject({ code: 'NODE_SOCKET_CLOSED' });
  expect(old.scheduled()).toBe(false);
  expect(() => replacement.writer.send('fresh')).not.toThrow();
  replacement.writer.close();
});

test('drain callers are bounded and cancellation discards only their own wait', async () => {
  const f = fixture();
  const caller = new AbortController();
  f.writer.send('synthet');
  const first = f.writer.drained(caller.signal).catch((error) => error);
  const second = f.writer.drained(f.physical.signal);
  await expect(f.writer.drained(f.physical.signal)).rejects.toMatchObject({ code: 'NODE_SOCKET_CAPACITY' });
  caller.abort(new Error('synthetic cancellation'));
  expect(await first).toMatchObject({ message: 'synthetic cancellation' });
  expect(f.port.terminate).not.toHaveBeenCalled();
  f.buffer(0);
  f.tick();
  await second;
  expect(f.port.send).toHaveBeenCalledTimes(1);
  f.writer.close();
});

test.each(['deadline', 'clock regression'] as const)('a stalled physical queue closes on %s without extending its drain window', async (condition) => {
  const f = fixture();
  f.advance(10);
  f.writer.send('synthet');
  const pending = f.writer.drained(f.physical.signal).catch((error) => error);
  f.advance(condition === 'deadline' ? 100 : -1);
  f.tick();
  expect(await pending).toMatchObject({ code: 'NODE_SOCKET_CLOSED' });
  expect(f.port.terminate).toHaveBeenCalledTimes(1);
  expect(f.scheduled()).toBe(false);
});

test('a rejected native send closes delivery and is never retried', () => {
  const f = fixture();
  f.port.send.mockReturnValue(false);
  expect(() => f.writer.send('synthet')).toThrow('unavailable');
  expect(() => f.writer.send('retry')).toThrow('unavailable');
  expect(f.port.send).toHaveBeenCalledTimes(1);
  expect(f.port.terminate).toHaveBeenCalledTimes(1);
});

test.each([-1, NaN, 0.5])('invalid native buffer reading %s fails every waiter with a fatal code', async (bytes) => {
  const f = fixture();
  f.writer.send('synthet');
  const pending = f.writer.drained(f.physical.signal).catch((error) => error);
  f.buffer(bytes);
  f.writer.drain();
  expect(await pending).toMatchObject({ code: 'NODE_SOCKET_INVALID_ACCOUNTING' });
  expect(() => f.writer.send('retry')).toThrow('unavailable');
  expect(f.port.terminate).toHaveBeenCalledTimes(1);
  expect(f.scheduled()).toBe(false);
});

test('automatic protocol replies may exceed application admission while new sends wait for capacity', async () => {
  const f = fixture();
  try {
    f.writer.send('12345678'); f.writer.send('abcdefgh');
    f.buffer(20 + 131);
    expect(f.writer.send('x')).toBe(false);
    const pending = f.writer.sendWhenWritable('next', f.physical.signal, () => {});
    expect(f.port.send).toHaveBeenCalledTimes(2);
    expect(f.port.terminate).not.toHaveBeenCalled();
    f.buffer(0); f.writer.drain();
    await pending;
    expect(f.port.send).toHaveBeenCalledTimes(3);
    expect(f.port.terminate).not.toHaveBeenCalled();
  } finally { f.writer.close(); }
});

test('unbounded protocol traffic exhausts a separate hard native limit', async () => {
  const f = fixture();
  f.writer.send('synthet');
  const pending = f.writer.drained(f.physical.signal).catch((error) => error);
  f.buffer(20 + NODE_SOCKET_PROTOCOL_ALLOWANCE_BYTES + 1);
  f.writer.drain();
  expect(await pending).toMatchObject({ code: 'NODE_SOCKET_BACKPRESSURE' });
  expect(f.port.terminate).toHaveBeenCalledTimes(1);
  expect(f.scheduled()).toBe(false);
});

test('an invalid native frame cost fails the writer before submission', async () => {
  const f = fixture();
  f.writer.send('synthet');
  const pending = f.writer.drained(f.physical.signal).catch((error) => error);
  f.port.bufferedFrameBytes = (length) => length - 1;
  await expect(f.writer.sendWhenWritable('x', f.physical.signal, () => {}))
    .rejects.toMatchObject({ code: 'NODE_SOCKET_INVALID_ACCOUNTING' });
  expect(await pending).toMatchObject({ code: 'NODE_SOCKET_INVALID_ACCOUNTING' });
  expect(f.port.send).toHaveBeenCalledTimes(1);
  expect(f.port.terminate).toHaveBeenCalledTimes(1);
});

test('an oversized frame is a local refusal and preserves the physical writer', async () => {
  const f = fixture();
  try {
    await expect(f.writer.sendWhenWritable('x'.repeat(9), f.physical.signal, () => {}))
      .rejects.toMatchObject({ code: 'NODE_SOCKET_CAPACITY' });
    expect(f.port.send).not.toHaveBeenCalled();
    expect(f.port.terminate).not.toHaveBeenCalled();
    expect(f.writer.send('valid')).toBe(true);
  } finally { f.writer.close(); }
});

test('cancelling the last drain waiter cannot extend the physical backlog deadline', async () => {
  const f = fixture();
  const firstCaller = new AbortController();
  f.writer.send('synthet');
  const first = f.writer.drained(firstCaller.signal).catch((error) => error);
  f.advance(90);
  firstCaller.abort(new Error('synthetic caller left'));
  await first;
  expect(f.scheduled()).toBe(true);
  const replacement = f.writer.drained(f.physical.signal).catch((error) => error);
  f.advance(10);
  f.tick();
  expect(await replacement).toMatchObject({ code: 'NODE_SOCKET_CLOSED' });
  expect(f.port.terminate).toHaveBeenCalledTimes(1);
});

test('an expired buffered socket cannot accept another send before its timer callback', () => {
  const f = fixture();
  f.writer.send('synthet');
  f.advance(100);
  expect(() => f.writer.send('later')).toThrow('unavailable');
  expect(f.port.send).toHaveBeenCalledTimes(1);
});

test('framed byte accounting refuses an exact payload fit and accepts an exact framed fit', () => {
  const f = fixture();
  try {
    f.buffer(19);
    expect(f.writer.send('x')).toBe(false);
    expect(f.port.send).not.toHaveBeenCalled();
    f.buffer(17);
    expect(f.writer.send('x')).toBe(true);
    expect(f.port.bufferedBytes).toBe(20);
    expect(f.port.terminate).not.toHaveBeenCalled();
  } finally { f.writer.close(); }
});

test('bulk backpressure reserves native headroom for an immediate control frame', async () => {
  const f = fixture();
  try {
    await f.writer.sendWhenWritable('12345678', f.physical.signal, () => {});
    const waiting = f.writer.sendWhenWritable('abcdefgh', f.physical.signal, () => {});
    expect(f.port.send).toHaveBeenCalledTimes(1);
    expect(f.writer.send('stop')).toBe(true);
    expect(f.port.send.mock.calls.map(([text]) => text)).toEqual(['12345678', 'stop']);
    f.buffer(0); f.writer.drain();
    await waiting;
    expect(f.port.send.mock.calls.map(([text]) => text)).toEqual(['12345678', 'stop', 'abcdefgh']);
    expect(f.port.terminate).not.toHaveBeenCalled();
  } finally { f.writer.close(); }
});

test('steady drain progress renews the stall deadline even when the buffer never reaches zero', () => {
  const f = fixture();
  try {
    f.writer.send('12345678');
    for (const remaining of [9, 8, 7, 6]) {
      f.advance(90); f.buffer(remaining); f.tick();
      expect(f.port.terminate).not.toHaveBeenCalled();
    }
    f.advance(100); f.tick();
    expect(f.port.terminate).toHaveBeenCalledTimes(1);
  } finally { f.writer.close(); }
});

test('additional local writes cannot postpone a stalled socket deadline', () => {
  const f = fixture();
  f.writer.send('12345678');
  f.advance(90);
  expect(f.writer.send('stop')).toBe(true);
  f.advance(10); f.tick();
  expect(f.port.terminate).toHaveBeenCalledTimes(1);
});

test('data writability does not wait for unrelated control frames to drain completely', async () => {
  const f = fixture(40);
  try {
    f.buffer(40);
    const ready = f.writer.writable(f.physical.signal);
    f.buffer(20); f.writer.drain();
    await ready;
    expect(f.port.bufferedBytes).toBe(20);
    await f.writer.sendWhenWritable('12345678', f.physical.signal, () => {});
    expect(f.port.bufferedBytes).toBe(30);
    expect(f.writer.send('stop')).toBe(true);
    expect(f.port.terminate).not.toHaveBeenCalled();
  } finally { f.writer.close(); }
});
