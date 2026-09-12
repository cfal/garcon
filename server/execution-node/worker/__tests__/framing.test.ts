import { expect, mock, test } from 'bun:test';
import { encodeNodeWorkerFrame, readNodeWorkerFrames } from '../framing.js';

function source(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(controller) { for (const bytes of chunks) controller.enqueue(bytes); controller.close(); } });
}

test('framing preserves order and exact UTF-8 across every one-byte boundary', async () => {
  const messages = ['{"type":"synthetic-one","value":"é\n"}', '{"type":"synthetic-two","value":"界"}'];
  const bytes = Buffer.concat(messages.map((text) => encodeNodeWorkerFrame(text, 1024)));
  for (const chunks of [[bytes], Array.from(bytes, (byte) => Uint8Array.of(byte))]) {
    expect(await Array.fromAsync(readNodeWorkerFrames(source(chunks), 1024, new AbortController().signal))).toEqual(messages);
  }
});

test.each([0, 1025, 0xffff_ffff])('rejects declared length %s before requesting any body', async (length) => {
  const header = new Uint8Array(4);
  new DataView(header.buffer).setUint32(0, length);
  const cancelled = mock(() => {});
  const input = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(header); }, cancel: cancelled });
  await expect(Array.fromAsync(readNodeWorkerFrames(input, 1024, new AbortController().signal)))
    .rejects.toMatchObject({ code: 'NODE_WORKER_PROTOCOL' });
  expect(cancelled).toHaveBeenCalledTimes(1);
  expect(input.locked).toBe(false);
});

test('partial headers and bodies cannot turn EOF into a completed frame', async () => {
  const frame = encodeNodeWorkerFrame('{"type":"synthetic"}', 1024);
  for (let length = 1; length < frame.byteLength; length += 1) {
    await expect(Array.fromAsync(readNodeWorkerFrames(source([frame.subarray(0, length)]), 1024, new AbortController().signal)))
      .rejects.toMatchObject({ code: 'NODE_WORKER_PROTOCOL' });
  }
  expect(await Array.fromAsync(readNodeWorkerFrames(source([]), 1024, new AbortController().signal))).toEqual([]);
});

test('malformed UTF-8 cannot be replaced with apparently valid protocol text', async () => {
  await expect(Array.fromAsync(readNodeWorkerFrames(source([Uint8Array.of(0, 0, 0, 2, 0xc0, 0x80)]), 1024, new AbortController().signal)))
    .rejects.toMatchObject({ code: 'NODE_WORKER_PROTOCOL' });
});

test('authority cancellation releases a blocked reader and preserves the exact cancellation reason', async () => {
  const authority = new AbortController();
  const cancelled = mock(() => {});
  const input = new ReadableStream<Uint8Array>({ cancel: cancelled });
  const reading = Array.fromAsync(readNodeWorkerFrames(input, 1024, authority.signal)).catch((error) => error);
  await Promise.resolve();
  const reason = new Error('Synthetic cancellation');
  authority.abort(reason);
  expect(await reading).toBe(reason);
  expect(cancelled).toHaveBeenCalledTimes(1);
  expect(input.locked).toBe(false);
});

test('early consumer exit cancels the pipe and releases its reader', async () => {
  const cancelled = mock(() => {});
  const input = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(encodeNodeWorkerFrame('synthetic', 1024)); }, cancel: cancelled,
  });
  for await (const text of readNodeWorkerFrames(input, 1024, new AbortController().signal)) { expect(text).toBe('synthetic'); break; }
  expect(cancelled).toHaveBeenCalledTimes(1);
  expect(input.locked).toBe(false);
});

test('frame size counts UTF-8 bytes without truncating a body', () => {
  expect(encodeNodeWorkerFrame('界', 3).byteLength).toBe(7);
  expect(() => encodeNodeWorkerFrame('界', 2)).toThrow('NODE_WORKER_PROTOCOL');
});
