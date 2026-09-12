import { expect, mock, spyOn, test } from 'bun:test';
import { NodeSocketReplyOutbox, type NodeSocketReplyOutboxOptions } from '../reply-outbox.js';
import { NodeSocketWriter, type NodeSocketPort } from '../socket-writer.js';
import type { NodeReplyAuthority } from '../reply-port.js';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function fixture(limits: Pick<NodeSocketReplyOutboxOptions, 'maxEntries' | 'maxBytes'> = {}) {
  let buffered = 1920;
  let now = 0;
  const physical = new AbortController();
  const failed = mock((_error: unknown) => {});
  const timers: { callback(): void; cancel: ReturnType<typeof mock> }[] = [];
  const frames: string[] = [];
  const port = { open: true, get bufferedBytes() { return buffered; }, bufferedFrameBytes: (length: number) => length + 4,
    send(text: string) { frames.push(text); buffered += Buffer.byteLength(text) + 4; return true; },
    terminate: mock(() => {}),
  } satisfies NodeSocketPort;
  const writer = new NodeSocketWriter(port, { signal: physical.signal, maxFrameBytes: 1024, maxBufferedBytes: 2048,
    reservedControlBytes: 512, reservedLifecycleBytes: 128, maxDrainWaiters: 1, drainTimeoutMs: 1000,
    now: () => now, schedulePoll: () => ({ cancel() {} }) });
  const waiting = spyOn(writer, 'sendApplicationWhenWritable');
  const authority = { signal: physical.signal, validate() {}, failed } satisfies NodeReplyAuthority;
  const outbox = new NodeSocketReplyOutbox(writer, { ...limits, signal: physical.signal, now: () => now, maxAgeMs: 100,
    validate() {}, failed, scheduleTimeout(callback) {
      const timer = { callback, cancel: mock(() => {}) }; timers.push(timer); return timer;
    } });
  return { writer, outbox, authority, physical, failed, frames, waiting, timers, port,
    buffer(bytes: number) { buffered = bytes; writer.drain(); }, advance(ms: number) { now += ms; },
    close() { outbox.close(); physical.abort(); } };
}

test('one reply waiter shares count and byte ownership across channels, including the active head', async () => {
  const f = fixture({ maxEntries: 3, maxBytes: 24 });
  const service = f.outbox.channel(); const execution = f.outbox.channel((text) => `[${text}]`);
  try {
    service.enqueue(1, 'a'.repeat(8), f.authority);
    execution.enqueue(1, 'b'.repeat(6), f.authority);
    service.enqueue(2, 'c'.repeat(8), f.authority);
    expect(f.outbox.pendingEntries).toBe(3); expect(f.outbox.pendingBytes).toBe(24);
    expect(f.waiting).toHaveBeenCalledTimes(1); expect(f.frames).toEqual([]);
    f.buffer(1908); await tick();
    expect(f.frames).toEqual(['a'.repeat(8)]);
    expect(f.outbox.pendingEntries).toBe(2); expect(f.outbox.pendingBytes).toBe(16);
    expect(f.waiting).toHaveBeenCalledTimes(2);
    f.buffer(1000); await tick();
    expect(f.frames).toEqual(['a'.repeat(8), `[${'b'.repeat(6)}]`, 'c'.repeat(8)]);
    expect(f.outbox.pendingEntries).toBe(0); expect(f.outbox.pendingBytes).toBe(0);
    expect(f.failed).not.toHaveBeenCalled(); expect(f.port.terminate).not.toHaveBeenCalled();
    expect(f.timers.every((timer) => timer.cancel.mock.calls.length === 1)).toBe(true);
  } finally { f.close(); }
});

test.each([
  { maxEntries: 2, maxBytes: 100, body: 'x', overflow: 'y' },
  { maxEntries: 5, maxBytes: 10, body: 'éé', overflow: 'éé' },
])('reply exhaustion fails only its captured socket with independent limits $maxEntries / $maxBytes', async (limits) => {
  const f = fixture(limits); const first = f.outbox.channel(); const second = f.outbox.channel();
  try {
    first.enqueue(1, limits.body, f.authority); second.enqueue(1, limits.body, f.authority);
    expect(() => second.enqueue(2, limits.overflow, f.authority)).toThrow(expect.objectContaining({ code: 'NODE_REPLY_CAPACITY' }));
    expect(f.failed).toHaveBeenCalledTimes(1); expect(f.port.terminate).toHaveBeenCalledTimes(1);
    await tick();
    expect(f.outbox.pendingEntries).toBe(0); expect(f.outbox.pendingBytes).toBe(0); expect(f.frames).toEqual([]);
  } finally { f.close(); }
});

test('the byte budget includes the complete encoded execution envelope', () => {
  const f = fixture({ maxBytes: 10 });
  try {
    expect(() => f.outbox.channel((text) => JSON.stringify({ payload: text })).enqueue(1, 'x', f.authority))
      .toThrow(expect.objectContaining({ code: 'NODE_REPLY_CAPACITY' }));
    expect(f.frames).toEqual([]); expect(f.failed).toHaveBeenCalledTimes(1);
  } finally { f.close(); }
});

test('cancellation after enqueue targets the exact channel and keeps an active waiter charged until it settles', async () => {
  const f = fixture(); const first = f.outbox.channel(); const second = f.outbox.channel();
  try {
    first.enqueue(1, 'first', f.authority); second.enqueue(1, 'second', f.authority); first.enqueue(2, 'third', f.authority);
    second.cancel(1);
    expect(f.outbox.pendingEntries).toBe(2); expect(f.outbox.pendingBytes).toBe(10);
    first.cancel(1);
    expect(f.outbox.pendingEntries).toBe(2); expect(f.waiting).toHaveBeenCalledTimes(1);
    await tick(); expect(f.outbox.pendingEntries).toBe(1); expect(f.outbox.pendingBytes).toBe(5);
    f.buffer(1000); await tick();
    expect(f.frames).toEqual(['third']); expect(f.failed).not.toHaveBeenCalled();
  } finally { f.close(); }
});

test('request cancellation removes a queued reply and pre-enqueue cancellation cannot fail the physical hop', async () => {
  const f = fixture(); const replies = f.outbox.channel(); const caller = new AbortController();
  const authority = { ...f.authority, signal: caller.signal };
  try {
    replies.enqueue(1, 'first', authority); caller.abort(); await tick();
    expect(f.outbox.pendingBytes).toBe(0);
    expect(() => replies.enqueue(2, 'second', authority)).toThrow();
    expect(f.failed).not.toHaveBeenCalled(); expect(f.port.terminate).not.toHaveBeenCalled();
  } finally { f.close(); }
});

test('a disconnected outbox cannot deliver old replies or close its replacement', async () => {
  const first = fixture(); const second = fixture();
  try {
    first.outbox.channel().enqueue(1, 'old', first.authority);
    first.physical.abort(); await tick();
    second.buffer(1000); second.outbox.channel().enqueue(1, 'new', second.authority);
    first.timers[0]!.callback();
    expect(first.frames).toEqual([]); expect(first.outbox.pendingBytes).toBe(0);
    expect(second.frames).toEqual(['new']); expect(second.failed).not.toHaveBeenCalled();
  } finally { first.close(); second.close(); }
});

test.each(['timer', 'validation'] as const)('reply expiry fails its physical hop through %s while native backlog is progressing', async (boundary) => {
  const f = fixture();
  try {
    f.outbox.channel().enqueue(1, 'reply', f.authority);
    f.advance(100);
    if (boundary === 'timer') f.timers[0]!.callback(); else f.buffer(1000);
    await tick();
    expect(f.frames).toEqual([]); expect(f.failed).toHaveBeenCalledTimes(1);
    expect(f.failed.mock.calls[0]![0]).toMatchObject({ code: 'NODE_REPLY_EXPIRED' });
    expect(f.outbox.pendingBytes).toBe(0);
  } finally { f.close(); }
});

test('physical and request validation are repeated immediately before sending a waiting reply', async () => {
  const f = fixture(); let valid = true;
  try {
    f.outbox.channel().enqueue(1, 'reply', { ...f.authority, validate() { if (!valid) throw new Error('Synthetic stale connection'); } });
    valid = false; f.buffer(1000); await tick();
    expect(f.frames).toEqual([]); expect(f.failed).toHaveBeenCalledTimes(1);
  } finally { f.close(); }
});

test('cancellation during synchronous socket admission never repeats an admitted reply', () => {
  const f = fixture(); const caller = new AbortController(); const replies = f.outbox.channel();
  const send = f.port.send.bind(f.port);
  const sending = spyOn(f.port, 'send').mockImplementation((text) => { caller.abort(); return send(text); });
  try {
    f.buffer(1000);
    replies.enqueue(1, 'reply', { ...f.authority, signal: caller.signal });
    expect(f.frames).toEqual(['reply']);
    expect(f.outbox.pendingEntries).toBe(0); expect(f.outbox.pendingBytes).toBe(0);
    expect(f.waiting).not.toHaveBeenCalled(); expect(f.failed).not.toHaveBeenCalled();
  } finally { sending.mockRestore(); f.close(); }
});
