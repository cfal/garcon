import { describe, expect, test } from 'bun:test';
import { readTextStreamPrefix, readTextStreamWithLimit } from '../bounded-text-stream.ts';

const encoder = new TextEncoder();

function streamOf(...chunks) {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

describe('bounded text streams', () => {
  test('accepts absent streams and exact byte limits', async () => {
    expect(await readTextStreamPrefix(null, 0)).toBe('');
    expect(await readTextStreamWithLimit(null, 0, () => new Error('limit'))).toBe('');
    const stream = streamOf(encoder.encode('ab'), encoder.encode('cd'));
    expect(await readTextStreamWithLimit(stream, 4, () => new Error('limit'))).toBe('abcd');
    expect(stream.locked).toBe(false);
  });

  test('decodes multibyte text across chunk boundaries', async () => {
    const text = 'a\u00e9\ud83d\ude00z';
    const bytes = encoder.encode(text);
    const stream = streamOf(...Array.from(bytes, (byte) => Uint8Array.of(byte)));
    expect(await readTextStreamWithLimit(stream, bytes.length, () => new Error('limit'))).toBe(text);
  });

  test('propagates the exact limit error and releases without cancelling the source', async () => {
    const failure = new Error('synthetic limit');
    const stream = streamOf(encoder.encode('too long'), encoder.encode('tail'));
    await expect(readTextStreamWithLimit(stream, 3, () => failure)).rejects.toBe(failure);
    expect(stream.locked).toBe(false);
    const reader = stream.getReader();
    expect(await reader.read()).toEqual({ done: false, value: encoder.encode('tail') });
    reader.releaseLock();
  });

  test.each([0, 1, 2, 3, 4, 8])('retains at most %i bytes while draining all chunks', async (limit) => {
    const bytes = encoder.encode('a\u00e9xyz');
    const stream = streamOf(bytes.subarray(0, 2), bytes.subarray(2, 4), bytes.subarray(4));
    expect(await readTextStreamPrefix(stream, limit)).toBe(new TextDecoder().decode(bytes.subarray(0, limit)));
    expect(stream.locked).toBe(false);
    const reader = stream.getReader();
    expect((await reader.read()).done).toBe(true);
    reader.releaseLock();
  });

  test('propagates a source failure even after the prefix is full', async () => {
    const failure = new Error('synthetic stream failure');
    let pulls = 0;
    const stream = new ReadableStream({
      pull(controller) {
        if (pulls++ === 0) controller.enqueue(encoder.encode('prefix'));
        else controller.error(failure);
      },
    });
    await expect(readTextStreamPrefix(stream, 1)).rejects.toBe(failure);
    expect(stream.locked).toBe(false);
  });
});
