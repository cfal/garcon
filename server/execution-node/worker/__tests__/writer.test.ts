import { expect, mock, test } from 'bun:test';
import { NODE_WORKER_WRITER_LIMITS } from '../limits.js';
import { NodeWorkerWriter, type NodeWorkerWritePort } from '../writer.js';

function fixture(limits: { reservedUrgentFrames?: number; reservedUrgentBytes?: number } = {}) {
  const authority = new AbortController();
  const written: { text: string; bytes: Uint8Array; finished: PromiseWithResolvers<void> }[] = [];
  const timers: { callback(): void; cancelled: boolean }[] = [];
  const port = {
    async write(bytes: Uint8Array) {
      const finished = Promise.withResolvers<void>();
      written.push({ text: Buffer.from(bytes.subarray(4)).toString(), bytes, finished });
      await finished.promise;
    }, close: mock(() => {}),
  } satisfies NodeWorkerWritePort;
  const failed = mock(() => {});
  const writer = new NodeWorkerWriter(port, { signal: authority.signal,
    maxFrameBytes: 8, maxQueuedBytes: 36, maxQueuedFrames: 4, reservedControlBytes: 12, reservedControlFrames: 1, writeTimeoutMs: 100, ...limits,
    scheduleTimeout(callback) { const timer = { callback, cancelled: false }; timers.push(timer); return { cancel() { timer.cancelled = true; } }; }, failed,
  });
  return { writer, port, authority, written, timers, failed };
}

test('saturated data traffic retains lifecycle capacity and gives it the next complete frame', async () => {
  const f = fixture();
  try {
    const data = ['one!', 'two!', 'last'].map((text) => f.writer.send(text, 'data'));
    await expect(f.writer.send('full', 'data')).rejects.toMatchObject({ code: 'NODE_WORKER_CAPACITY' });
    const control = f.writer.send('stop', 'control');
    await expect(f.writer.send('full', 'control')).rejects.toMatchObject({ code: 'NODE_WORKER_CAPACITY' });
    expect(f.writer.bufferedBytes).toBe(32);
    expect(f.written.map(({ text }) => text)).toEqual(['one!']);
    f.written[0]!.finished.resolve(); await data[0];
    expect(f.written.map(({ text }) => text)).toEqual(['one!', 'stop']);
    f.written[1]!.finished.resolve(); await control;
    expect(f.written.map(({ text }) => text)).toEqual(['one!', 'stop', 'two!']);
    f.written[2]!.finished.resolve(); await data[1];
    f.written[3]!.finished.resolve(); await data[2];
    expect(f.written.map(({ text }) => text)).toEqual(['one!', 'stop', 'two!', 'last']);
    expect(f.writer.bufferedBytes).toBe(0);
    expect(f.written.every(({ bytes }) => bytes.every((byte) => byte === 0))).toBe(true);
    expect(f.timers.every(({ cancelled }) => cancelled)).toBe(true);
    expect(f.failed).not.toHaveBeenCalled();
  } finally { f.writer.close(); }
});

test('urgent traffic uses its reserve ahead of data without consuming lifecycle capacity', async () => {
  const f = fixture({ reservedUrgentFrames: 1, reservedUrgentBytes: 8 });
  try {
    const first = f.writer.send('one!', 'data');
    const second = f.writer.send('two!', 'data');
    await expect(f.writer.send('full', 'data')).rejects.toMatchObject({ code: 'NODE_WORKER_CAPACITY' });
    const urgent = f.writer.send('stop', 'urgent');
    await expect(f.writer.send('full', 'urgent')).rejects.toMatchObject({ code: 'NODE_WORKER_CAPACITY' });
    const pulse = f.writer.send('live', 'control');
    f.written[0]!.finished.resolve(); await first;
    expect(f.written[1]!.text).toBe('live');
    f.written[1]!.finished.resolve(); await pulse;
    expect(f.written[2]!.text).toBe('stop');
    f.written[2]!.finished.resolve(); await urgent;
    expect(f.written[3]!.text).toBe('two!');
    f.written[3]!.finished.resolve(); await second;
    expect(f.writer.bufferedBytes).toBe(0);
    expect(f.written.every(({ bytes }) => bytes.every((byte) => byte === 0))).toBe(true);
  } finally { f.writer.close(); }
});

test('cancelling queued urgent work releases both byte and frame reservations', async () => {
  const f = fixture({ reservedUrgentFrames: 1, reservedUrgentBytes: 8 });
  const cancellation = new AbortController();
  try {
    const held = f.writer.send('hold', 'data');
    const second = f.writer.send('two!', 'data');
    const pending = f.writer.submit('stop', 'urgent', { signal: cancellation.signal, validate() {} });
    const outcome = pending.drained.catch((error: unknown) => error);
    await expect(f.writer.send('full', 'urgent')).rejects.toMatchObject({ code: 'NODE_WORKER_CAPACITY' });
    cancellation.abort();
    expect(await outcome).toBe(cancellation.signal.reason);
    expect(f.writer.bufferedBytes).toBe(16);
    const next = f.writer.send('next', 'urgent');
    f.written[0]!.finished.resolve(); await held;
    expect(f.written[1]!.text).toBe('next');
    f.written[1]!.finished.resolve(); await next;
    f.written[2]!.finished.resolve(); await second;
    expect(f.writer.bufferedBytes).toBe(0);
    expect(f.failed).not.toHaveBeenCalled();
  } finally { f.writer.close(); }
});

test('byte capacity includes the native write and frame prefix independently of entry count', async () => {
  const f = fixture();
  try {
    const first = f.writer.send('界界', 'data');
    const second = f.writer.send('abcdefgh', 'data');
    expect(f.writer.bufferedBytes).toBe(22);
    await expect(f.writer.send('x', 'data')).rejects.toMatchObject({ code: 'NODE_WORKER_CAPACITY' });
    const control = f.writer.send('stop', 'control');
    f.written[0]!.finished.resolve(); await first;
    f.written[1]!.finished.resolve(); await control;
    f.written[2]!.finished.resolve(); await second;
  } finally { f.writer.close(); }
});

test.each(['timeout', 'cancellation', 'native failure'] as const)('%s settles callers once while keeping an unsettled native buffer accounted', async (cause) => {
  const f = fixture();
  const first = f.writer.send('one!', 'data').catch((error) => error);
  const second = f.writer.send('two!', 'data').catch((error) => error);
  if (cause === 'timeout') f.timers[0]!.callback();
  else if (cause === 'cancellation') f.authority.abort();
  else f.written[0]!.finished.reject(new Error('Synthetic private native error'));
  const expected = { code: cause === 'timeout' ? 'NODE_WORKER_TIMEOUT' : 'NODE_WORKER_CLOSED' };
  expect(await first).toMatchObject(expected);
  expect(await second).toMatchObject(expected);
  expect(f.writer.bufferedBytes).toBe(cause === 'native failure' ? 0 : 8);
  expect(f.written).toHaveLength(1);
  expect(f.port.close).toHaveBeenCalledTimes(1);
  expect(f.failed).toHaveBeenCalledTimes(1);
  await expect(f.writer.send('late', 'control')).rejects.toMatchObject(expected);
  f.written[0]!.finished.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(f.writer.bufferedBytes).toBe(0);
  expect(f.written[0]!.bytes).toEqual(new Uint8Array(8));
  expect(f.timers.every(({ cancelled }) => cancelled)).toBe(true);
  f.writer.close();
  expect(f.failed).toHaveBeenCalledTimes(1);
});

test('an oversized frame is refused before native delivery without truncating or poisoning the next frame', async () => {
  const f = fixture();
  try {
    await expect(f.writer.send('oversized', 'data')).rejects.toMatchObject({ code: 'NODE_WORKER_PROTOCOL' });
    expect(f.writer.bufferedBytes).toBe(0);
    expect(f.written).toHaveLength(0);
    const next = f.writer.send('next', 'control');
    f.written[0]!.finished.resolve(); await next;
    expect(f.written[0]!.text).toBe('next');
  } finally { f.writer.close(); }
});

test('cancelling a queued mutation removes its bytes before a later control can reach the pipe', async () => {
  const f = fixture();
  const cancellation = new AbortController();
  try {
    const first = f.writer.send('hold', 'data');
    const queued = f.writer.submit('work', 'control', { signal: cancellation.signal, validate() {} });
    const outcome = queued.drained.catch((error: unknown) => error);
    expect(queued.submitted).toBe(false);
    expect(f.writer.bufferedBytes).toBe(16);
    const reason = new Error('Synthetic caller cancellation');
    cancellation.abort(reason);
    expect(await outcome).toBe(reason);
    expect(f.writer.bufferedBytes).toBe(8);
    const next = f.writer.send('next', 'control');
    f.written[0]!.finished.resolve(); await first;
    expect(f.written.map(({ text }) => text)).toEqual(['hold', 'next']);
    f.written[1]!.finished.resolve(); await next;
    expect(queued.submitted).toBe(false);
    expect(f.failed).not.toHaveBeenCalled();
  } finally { f.writer.close(); }
});

test('a queued authority is checked again before submission without failing the worker pipe', async () => {
  const f = fixture();
  const reason = new Error('Synthetic replaced connection');
  let current = true;
  const validate = mock(() => { if (!current) throw reason; });
  try {
    const first = f.writer.send('hold', 'data');
    const queued = f.writer.submit('work', 'control', { signal: new AbortController().signal, validate });
    const outcome = queued.drained.catch((error: unknown) => error);
    expect(validate).not.toHaveBeenCalled();
    current = false;
    f.written[0]!.finished.resolve(); await first;
    expect(await outcome).toBe(reason);
    expect(validate).toHaveBeenCalledTimes(1);
    expect(queued.submitted).toBe(false);
    expect(f.written.map(({ text }) => text)).toEqual(['hold']);
    expect(f.writer.bufferedBytes).toBe(0);
    expect(f.port.close).not.toHaveBeenCalled();
    const next = f.writer.send('next', 'control');
    f.written[1]!.finished.resolve(); await next;
  } finally { f.writer.close(); }
});

test('cancelling after native submission keeps memory accounted until native drain', async () => {
  const f = fixture();
  const cancellation = new AbortController();
  try {
    const submission = f.writer.submit('work', 'control', { signal: cancellation.signal, validate() {} });
    const outcome = submission.drained.catch((error: unknown) => error);
    expect(submission.submitted).toBe(true);
    cancellation.abort(new Error('Synthetic caller cancellation'));
    const released = mock(() => {});
    const capacity = f.writer.waitForRelease(f.authority.signal).then(released);
    expect(await outcome).toBe(cancellation.signal.reason);
    expect(released).not.toHaveBeenCalled();
    expect(f.writer.bufferedBytes).toBe(8);
    expect(f.written[0]!.bytes.some((byte) => byte !== 0)).toBe(true);
    expect(f.failed).not.toHaveBeenCalled();
    f.written[0]!.finished.resolve();
    await capacity;
    expect(released).toHaveBeenCalledTimes(1);
    expect(f.writer.bufferedBytes).toBe(0);
    expect(f.written[0]!.bytes.every((byte) => byte === 0)).toBe(true);
  } finally { f.writer.close(); }
});

test('reservation waiters cancel independently and reject promptly when the writer fails', async () => {
  const f = fixture();
  const caller = new AbortController();
  const written = f.writer.send('hold', 'data').catch((error: unknown) => error);
  try {
    const cancelled = f.writer.waitForRelease(caller.signal).catch((error: unknown) => error);
    const waiting = f.writer.waitForRelease(f.authority.signal).catch((error: unknown) => error);
    caller.abort(new Error('Synthetic cancellation'));
    expect(await cancelled).toBe(caller.signal.reason);
    expect(f.writer.bufferedBytes).toBe(8);
    f.writer.close();
    expect(await waiting).toMatchObject({ code: 'NODE_WORKER_CLOSED' });
    expect(await written).toMatchObject({ code: 'NODE_WORKER_CLOSED' });
    expect(f.writer.bufferedBytes).toBe(8);
  } finally { f.writer.close(); f.written[0]!.finished.resolve(); }
});

test.each(['caller', 'worker'] as const)('reentrant %s retirement during validation cannot submit bytes', async (cause) => {
  const f = fixture();
  const cancellation = new AbortController();
  try {
    const submission = f.writer.submit('work', 'control', { signal: cancellation.signal, validate() {
      if (cause === 'caller') cancellation.abort(new Error('Synthetic authority retirement'));
      else f.authority.abort();
    } });
    await expect(submission.drained).rejects.toThrow();
    expect(submission.submitted).toBe(false);
    expect(f.written).toHaveLength(0);
    expect(f.writer.bufferedBytes).toBe(0);
  } finally { f.writer.close(); }
});

test('production limits admit execution and service bursts, eight urgent frames and four lifecycle frames independently', async () => {
  const lifetime = new AbortController();
  const cancellation = new AbortController();
  const native = Promise.withResolvers<void>();
  const results: Promise<unknown>[] = [];
  const writer = new NodeWorkerWriter({ write: () => native.promise, close: () => native.resolve() }, {
    ...NODE_WORKER_WRITER_LIMITS, signal: lifetime.signal, failed() {}, scheduleTimeout: () => ({ cancel() {} }),
  });
  const submit = (priority: 'control' | 'urgent' | 'data', signal = lifetime.signal) => {
    const result = writer.submit('x', priority, { signal, validate() {} });
    results.push(result.drained.catch((error: unknown) => error));
  };
  try {
    for (let i = 0; i < 112; i += 1) submit('data');
    expect(() => submit('data')).toThrow();
    for (let i = 0; i < 8; i += 1) submit('urgent', i === 0 ? cancellation.signal : lifetime.signal);
    expect(() => submit('urgent')).toThrow();
    for (let i = 0; i < 4; i += 1) submit('control');
    expect(() => submit('control')).toThrow();
    cancellation.abort();
    expect(() => submit('urgent')).not.toThrow();
    expect(() => submit('urgent')).toThrow();
    expect(writer.bufferedBytes).toBe(124 * 5);
  } finally { writer.close(); await Promise.all(results); }
});
