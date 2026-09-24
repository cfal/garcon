import { expect, test } from 'bun:test';
import { MessageSession, type MessageSessionOptions } from '../message-session.js';

function endpoint(options: Partial<MessageSessionOptions> = {}) {
  const sent: string[] = [];
  const delivered: string[] = [];
  const failures: Error[] = [];
  const session = new MessageSession({ deliver: body => delivered.push(body), failed: error => failures.push(error), ...options });
  const socket = { send: (body: string) => { sent.push(body); }, close() {} };
  return { sent, delivered, failures, session, socket };
}

test('delivers in socket order without retaining successfully sent messages', () => {
  const peer = endpoint();
  const connection = peer.session.attach(peer.socket);
  peer.session.send('first');
  peer.session.send('second');
  connection.receive('reply');
  expect(peer.sent).toEqual(['first', 'second']);
  expect(peer.delivered).toEqual(['reply']);
  expect(peer.session.queuedFrames).toBe(0);
  expect(peer.session.queuedBytes).toBe(0);
  peer.session.close();
});

test('defers a bounded queue while the socket is backpressured', async () => {
  let writable = false;
  const flushed = Promise.withResolvers<void>();
  const peer = endpoint();
  peer.session.attach({
    ...peer.socket, canSend: () => writable,
    send(body) { peer.sent.push(body); if (body === 'second') flushed.resolve(); },
  });
  try {
    peer.session.send('first');
    peer.session.send('second');
    expect(peer.sent).toEqual([]);
    expect(peer.session.queuedFrames).toBe(2);
    expect(peer.session.trySend('terminal output')).toBe(false);
    writable = true;
    await flushed.promise;
    expect(peer.sent).toEqual(['first', 'second']);
    expect(peer.session.queuedBytes).toBe(0);
    expect(peer.failures).toEqual([]);
  } finally { peer.session.close(); }
});

test('disconnect fails immediately and never accepts a replacement socket', () => {
  const peer = endpoint();
  const connection = peer.session.attach({ ...peer.socket, canSend: () => false });
  peer.session.send('unsent');
  connection.disconnected();
  connection.receive('late');
  expect(peer.session.connected).toBe(false);
  expect(peer.session.queuedBytes).toBe(0);
  expect(peer.delivered).toEqual([]);
  expect(peer.failures).toHaveLength(1);
  expect(() => peer.session.send('retry')).toThrow('connection lost');
  expect(() => peer.session.attach(peer.socket)).toThrow('connection lost');
  connection.disconnected();
  expect(peer.failures).toHaveLength(1);
});

for (const limits of [{ maxQueuedFrames: 1 }, { maxQueuedBytes: 5 }, { maxFrameBytes: 5 }]) {
  test('rejects exhausted queue or frame limits', () => {
    const peer = endpoint(limits);
    peer.session.attach({ ...peer.socket, canSend: () => false });
    if ('maxQueuedFrames' in limits) peer.session.send('first');
    expect(peer.session.canAdmit('second')).toBe(false);
    expect(() => peer.session.send('second')).toThrow('budget exhausted');
    expect(peer.failures).toHaveLength(1);
    expect(peer.session.queuedFrames).toBe(0);
  });
}

test('a failed write retires the session and pending queue', () => {
  const peer = endpoint();
  peer.session.attach({ ...peer.socket, send() { throw new Error('write failed'); } });
  expect(() => peer.session.send('first')).toThrow('write failed');
  expect(peer.session.connected).toBe(false);
  expect(peer.failures).toHaveLength(1);
});

test('invalid inbound size and receiver errors retire the session', () => {
  for (const body of ['oversized', 'valid']) {
    const peer = endpoint({ maxFrameBytes: 5, deliver() { throw new Error('invalid payload'); } });
    peer.session.attach(peer.socket).receive(body);
    expect(peer.failures).toHaveLength(1);
    expect(peer.session.connected).toBe(false);
  }
});
