import { expect, mock, test } from 'bun:test';
import type { NodeSocketWriter } from '../../execution-nodes/transport/socket-writer.js';
import { NodeSessionOutputRelay, NODE_SESSION_OUTPUT_ADMISSION_MS } from '../output-relay.js';
import { tick } from '../worker/__tests__/lifecycle-fixture.js';

function fixture(limits: { maxEntries?: number; maxBytes?: number } = {}) {
  let now = 0;
  let valid = true;
  const lifetime = new AbortController();
  const pending: PromiseWithResolvers<void>[] = [];
  const sent: string[] = [];
  const timers: { callback(): void; delayMs: number; cancelled: boolean }[] = [];
  const failed = mock((_error: unknown) => {});
  const deliver = async (text: string, signal: AbortSignal, validate: () => void) => {
    const gate = Promise.withResolvers<void>();
    pending.push(gate);
    await gate.promise;
    signal.throwIfAborted(); validate();
    sent.push(text);
  };
  const writer = { sendData: mock(() => false), sendApplication: mock(() => false),
    sendWhenWritable: mock(deliver), sendApplicationWhenWritable: mock(deliver), close: mock(() => {}) } satisfies
    Pick<NodeSocketWriter, 'sendData' | 'sendApplication' | 'sendWhenWritable' | 'sendApplicationWhenWritable' | 'close'>;
  const relay = new NodeSessionOutputRelay(writer, { ...limits, signal: lifetime.signal, now: () => now, failed,
    validate() { if (!valid) throw new Error('Synthetic retired authority'); },
    scheduleTimeout(callback, delayMs) {
      const timer = { callback, delayMs, cancelled: false }; timers.push(timer);
      return { cancel() { timer.cancelled = true; } };
    },
  });
  return { relay, writer, failed, sent, timers,
    advance(ms: number) { now += ms; }, invalidate() { valid = false; },
    async deliver() { expect(pending.length).toBe(1); pending.shift()!.resolve(); await tick(); },
    async close() { lifetime.abort(); for (const gate of pending.splice(0)) gate.resolve(); await tick(); },
  };
}

test('queued output stays ordered through continuing progress beyond one admission window', async () => {
  const f = fixture();
  try {
    for (const text of ['first', 'second', 'third']) f.relay.enqueue(text, 'data');
    expect(f.relay.pendingEntries).toBe(3);
    expect(f.writer.sendWhenWritable).toHaveBeenCalledTimes(1);
    for (let index = 0; index < 3; index++) {
      expect(f.timers[index]!.delayMs).toBe(NODE_SESSION_OUTPUT_ADMISSION_MS);
      f.advance(900); await f.deliver();
    }
    expect(f.sent).toEqual(['first', 'second', 'third']);
    expect(f.relay.pendingEntries).toBe(0);
    expect(f.relay.pendingBytes).toBe(0);
    expect(f.timers.every((timer) => timer.cancelled)).toBe(true);
    expect(f.failed).not.toHaveBeenCalled();
  } finally { await f.close(); }
});

test.each(['entries', 'bytes'] as const)('relay %s capacity includes the frame awaiting admission', async (dimension) => {
  const bytes = 2 * '界'.length + Buffer.byteLength('界') + 14;
  const f = fixture(dimension === 'entries' ? { maxEntries: 2 } : { maxBytes: 2 * bytes });
  try {
    f.relay.enqueue('界', 'data'); f.relay.enqueue('界', 'application');
    expect(f.relay.pendingBytes).toBe(2 * bytes);
    expect(f.relay.pendingEntries).toBe(2);
    f.relay.enqueue('界', 'data');
    expect(f.failed).toHaveBeenCalledTimes(1);
    expect(f.failed.mock.calls[0]![0]).toMatchObject({ code: 'NODE_WORKER_CAPACITY' });
    expect(f.relay.pendingEntries).toBe(1);
    expect(f.relay.pendingBytes).toBe(bytes);
    expect(f.writer.close).toHaveBeenCalledTimes(1);
    await f.deliver();
    expect(f.sent).toEqual([]);
    expect(f.relay.pendingBytes).toBe(0);
    expect(f.relay.pendingEntries).toBe(0);
  } finally { await f.close(); }
});

test.each(['arrival', 'drain', 'timer'] as const)('stalled output cannot regain admission from a late %s', async (event) => {
  const f = fixture();
  try {
    f.relay.enqueue('first', 'data');
    f.advance(NODE_SESSION_OUTPUT_ADMISSION_MS - 1);
    f.relay.enqueue('later', 'data');
    f.advance(1);
    if (event === 'arrival') f.relay.enqueue('last', 'data');
    else if (event === 'timer') f.timers[0]!.callback();
    await f.deliver();
    expect(f.failed).toHaveBeenCalledTimes(1);
    expect(f.failed.mock.calls[0]![0]).toMatchObject({ code: 'NODE_WORKER_TIMEOUT' });
    expect(f.sent).toEqual([]);
    expect(f.relay.pendingBytes).toBe(0);
  } finally { await f.close(); }
});

test('an old timer cannot expire the next output frame after valid progress', async () => {
  const f = fixture();
  try {
    f.relay.enqueue('first', 'data'); f.relay.enqueue('second', 'application');
    f.advance(900); await f.deliver();
    f.timers[0]!.callback();
    expect(f.failed).not.toHaveBeenCalled();
    f.advance(900); await f.deliver();
    expect(f.sent).toEqual(['first', 'second']);
    expect(f.writer.sendApplicationWhenWritable).toHaveBeenCalledTimes(1);
    expect(f.failed).not.toHaveBeenCalled();
  } finally { await f.close(); }
});

test('authority loss fences an admitted waiter and discards its queued siblings', async () => {
  const f = fixture();
  try {
    f.relay.enqueue('first', 'data'); f.relay.enqueue('second', 'data');
    f.invalidate(); await f.deliver();
    expect(f.sent).toEqual([]);
    expect(f.failed).toHaveBeenCalledTimes(1);
    expect(f.relay.pendingEntries).toBe(0);
    expect(f.relay.pendingBytes).toBe(0);
    expect(f.timers[0]!.cancelled).toBe(true);
  } finally { await f.close(); }
});
