import { describe, expect, test } from 'bun:test';
import { readBoundedJsonBody } from '../bounded-json-body.js';

const signal = () => new AbortController().signal;
const json = (body, headers = {}) => new Response(body, { headers: { 'Content-Type': 'application/json', ...headers } });

describe('bounded JSON body', () => {
  test('decodes split UTF-8 and accepts exactly the byte limit', async () => {
    const bytes = new TextEncoder().encode('{"value":"é"}');
    const body = new ReadableStream({ start(controller) {
      for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
      controller.close();
    } });
    const response = json(body, { 'Content-Length': String(bytes.length) });
    expect(await readBoundedJsonBody(response, bytes.length, signal())).toEqual({ value: 'é' });
    expect(response.body.locked).toBe(false);
    await expect(readBoundedJsonBody(json(bytes), bytes.length - 1, signal())).rejects.toThrow();
  });

  test('rejects malformed bytes, JSON, media types, and declared lengths', async () => {
    for (const response of [
      json(new Uint8Array([0xc3, 0x28])), json(new Uint8Array([0x22, 0xc3])), json('{malformed'),
      json('{}', { 'Content-Type': 'text/plain' }), new Response(null),
      ...['-1', 'NaN', '1e2', '65', '9007199254740993', '1', '3'].map((length) => json('{}', { 'Content-Length': length })),
    ]) {
      await expect(readBoundedJsonBody(response, 64, signal())).rejects.toThrow();
      expect(response.body?.locked ?? false).toBe(false);
    }
  });

  test('bounds decoded bytes without treating compressed Content-Length as decoded length', async () => {
    expect(await readBoundedJsonBody(json('{"value":"synthetic"}', { 'Content-Length': '10', 'Content-Encoding': 'gzip' }), 64, signal()))
      .toEqual({ value: 'synthetic' });
    await expect(readBoundedJsonBody(json(JSON.stringify('x'.repeat(65)), { 'Content-Length': '10', 'Content-Encoding': 'gzip' }), 64, signal()))
      .rejects.toThrow();
  });

  test('cancels before reading an oversized declaration', async () => {
    let cancelled = 0;
    const response = json(new ReadableStream({ cancel() { cancelled++; } }), { 'Content-Length': '65' });
    await expect(readBoundedJsonBody(response, 64, signal())).rejects.toThrow();
    expect(cancelled).toBe(1);
    expect(response.body.locked).toBe(false);
  });

  test('aborts a stalled read even when cancellation cleanup never resolves', async () => {
    const reading = Promise.withResolvers();
    let cancelled = 0;
    const response = json(new ReadableStream({
      pull() { reading.resolve(); return new Promise(() => {}); },
      cancel() { cancelled++; return new Promise(() => {}); },
    }));
    const controller = new AbortController();
    const pending = readBoundedJsonBody(response, 64, controller.signal);
    await reading.promise;
    const reason = new Error('Synthetic cancellation');
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(cancelled).toBe(1);
    expect(response.body.locked).toBe(false);
  });

  test('rejects pre-entry cancellation and cancellation at the last chunk', async () => {
    const controller = new AbortController();
    controller.abort(new Error('Synthetic pre-entry cancellation'));
    const response = json('{}');
    await expect(readBoundedJsonBody(response, 64, controller.signal)).rejects.toBe(controller.signal.reason);
    expect(response.body.locked).toBe(false);
    const late = new AbortController();
    const lateReason = new Error('Synthetic late cancellation');
    const body = new ReadableStream({ pull(controller) {
      controller.enqueue(new TextEncoder().encode('{}'));
      late.abort(lateReason);
      controller.close();
    } });
    await expect(readBoundedJsonBody(json(body), 64, late.signal)).rejects.toBe(lateReason);
  });
});
