import { expect, test } from 'bun:test';
import { SessionSocketFrames, SESSION_MESSAGE_BYTES, SESSION_SOCKET_BUFFER_BYTES } from '../session-socket.js';

test('framing preserves UTF-8 across fragment boundaries and pauses at the socket watermark', async () => {
  let bufferedAmount = 0;
  const sent: Uint8Array[] = [];
  const socket = new SessionSocketFrames({
    get bufferedAmount() { return bufferedAmount; },
    send(fragment) {
      if (typeof fragment === 'string') throw new Error('Expected binary fragment');
      sent.push(fragment);
      bufferedAmount += fragment.length;
    },
  }, () => {});
  const reader = new SessionSocketFrames({ bufferedAmount: 0, send() {} }, () => {});
  try {
    const text = '\u20ac'.repeat(300_000);
    socket.send(text);
    expect(bufferedAmount).toBeGreaterThanOrEqual(SESSION_SOCKET_BUFFER_BYTES);
    expect(socket.canSend()).toBe(false);
    expect(() => socket.send('next')).toThrow('not writable');
    const result: string[] = [];
    while (!socket.canSend()) {
      for (const fragment of sent.splice(0)) {
        const complete = reader.receive(fragment);
        if (complete !== null) result.push(complete);
      }
      bufferedAmount = 0;
      await Bun.sleep(20);
    }
    for (const fragment of sent) {
      const complete = reader.receive(fragment);
      if (complete !== null) result.push(complete);
    }
    expect(result).toEqual([text]);
  } finally { socket.dispose(); reader.dispose(); }
});

test('framing rejects malformed fragments, invalid UTF-8, and oversized reassembly', () => {
  const socket = new SessionSocketFrames({ bufferedAmount: 0, send() {} }, () => {});
  try {
    for (const fragment of [Buffer.from([0]), Buffer.from([2, 1]), Buffer.from([0, 1]), Buffer.from([1, 255])]) {
      expect(() => socket.receive(fragment)).toThrow();
    }
    const fragment = Buffer.alloc(256 * 1024 + 1);
    for (let bytes = 0; bytes < SESSION_MESSAGE_BYTES; bytes += fragment.length - 1) socket.receive(fragment);
    expect(() => socket.receive(Buffer.from([1, 1]))).toThrow('Invalid session message fragment');
  } finally { socket.dispose(); }
});

test('disposing a blocked socket cancels its partial send', async () => {
  let bufferedAmount = 0;
  let sends = 0;
  const socket = new SessionSocketFrames({
    get bufferedAmount() { return bufferedAmount; },
    send() { sends++; bufferedAmount = SESSION_SOCKET_BUFFER_BYTES; },
  }, () => {});
  socket.send('x'.repeat(1024 * 1024));
  socket.dispose();
  bufferedAmount = 0;
  await Bun.sleep(30);
  expect(sends).toBe(1);
});
