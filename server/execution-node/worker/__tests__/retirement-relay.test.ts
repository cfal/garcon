import { expect, mock, test } from 'bun:test';
import { NodeWorkerRetirementRelay } from '../retirement-relay.js';
import { NodeWorkerWriter } from '../writer.js';
import { NODE_WORKER_WRITER_LIMITS } from '../limits.js';
import { serializeNodeWorkerOutputRetirement } from '../output-retirement.js';
import { session, tick } from './lifecycle-fixture.js';

function fixture() {
  const lifetime = new AbortController();
  const native = Promise.withResolvers<void>();
  const written: string[] = [];
  const failed = mock((_error: unknown) => {});
  const writer = new NodeWorkerWriter({ async write(bytes) {
    written.push(Buffer.from(bytes.subarray(4)).toString());
    if (written.length === 1) await native.promise;
  }, close() {} }, { ...NODE_WORKER_WRITER_LIMITS, signal: lifetime.signal, failed,
    scheduleTimeout: () => ({ cancel() {} }) });
  const timers: { callback(): void; cancelled: boolean }[] = [];
  const relay = new NodeWorkerRetirementRelay({
    send: (frame, signal) => writer.submit(serializeNodeWorkerOutputRetirement(frame), 'urgent', { signal, validate() {} }, 'application').drained,
    waitForRelease: (signal) => writer.waitForRelease(signal), failed,
    scheduleTimeout(callback) {
      const timer = { callback, cancelled: false }; timers.push(timer);
      return { cancel() { timer.cancelled = true; } };
    },
  });
  const submitted: Promise<unknown>[] = [];
  for (let i = 0; i < 112 + 8; i += 1) submitted.push(writer.submit('held', i < 112 ? 'data' : 'urgent',
    { signal: lifetime.signal, validate() {} }, i < 112 ? 'data' : 'application').drained.catch((error: unknown) => error));
  const frame = { type: 'node-worker-output-retired', reason: 'output-retired', version: 1, instanceId: 'synthetic-instance',
    stream: { ...session, streamId: 'synthetic-stream' } } as const;
  return { relay, frame, writer, native, written, failed, timers,
    async close() { relay.close(); writer.close(); native.resolve(); await Promise.all(submitted); } };
}

test('retirement waits for actual writer capacity and keeps the sibling barrier until delivery', async () => {
  const f = fixture();
  try {
    f.relay.enqueue(f.frame); f.relay.enqueue(f.frame);
    const complete = mock(() => {});
    const flushed = f.relay.flush().then(complete);
    await tick();
    expect(f.failed).not.toHaveBeenCalled(); expect(complete).not.toHaveBeenCalled();
    expect(f.written).toEqual(['held']);
    f.native.resolve(); await flushed;
    expect(f.written.filter((text) => text.includes('node-worker-output-retired'))).toEqual([serializeNodeWorkerOutputRetirement(f.frame)]);
    expect(f.failed).not.toHaveBeenCalled(); expect(complete).toHaveBeenCalledTimes(1);
    expect(f.timers.every((timer) => timer.cancelled)).toBe(true);
  } finally { await f.close(); }
});

test.each(['close', 'deadline'] as const)('retirement capacity waiting settles its barrier on %s without releasing native memory', async (cause) => {
  const f = fixture();
  try {
    f.relay.enqueue(f.frame);
    const flushed = f.relay.flush().catch((error: unknown) => error);
    await tick();
    const before = f.writer.bufferedBytes;
    if (cause === 'close') f.relay.close(); else f.timers[0]!.callback();
    expect(await flushed).toMatchObject({ code: 'NODE_WORKER_CLOSED' });
    expect(f.writer.bufferedBytes).toBe(before);
    expect(f.written).toEqual(['held']);
    expect(f.failed).toHaveBeenCalledTimes(cause === 'close' ? 0 : 1);
    if (cause === 'deadline') expect(f.failed).toHaveBeenCalledWith(expect.objectContaining({ code: 'NODE_WORKER_TIMEOUT' }));
    expect(f.timers.every((timer) => timer.cancelled)).toBe(true);
  } finally { await f.close(); }
});
