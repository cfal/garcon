import { describe, expect, mock, test } from 'bun:test';
import { PrimarySocketDelivery } from '../primary-delivery.js';
import { publishWebSocketPayload, sendWebSocketPayload } from '../transport.js';
import { sendWebSocketJson } from '../utils.js';

function socketFixture() {
  let bufferedBytes = 0;
  const topics = new Set<string>();
  const socket = {
    data: {
      connectionId: crypto.randomUUID(),
      principal: { mode: 'local', key: 'local', username: 'local', expiresAtMs: null },
    },
    readyState: 1,
    subscribe: (topic: string) => { topics.add(topic); return true; },
    isSubscribed: (topic: string) => topics.has(topic),
    send: mock((payload: string, _compress?: boolean) => {
      bufferedBytes += Buffer.byteLength(payload);
      return -1;
    }),
    getBufferedAmount: () => bufferedBytes,
    close: mock((_code?: number, _reason?: string) => {}),
    terminate: mock(() => {}),
  } satisfies Parameters<PrimarySocketDelivery['add']>[0];
  return { socket, drain() { bufferedBytes = 0; } };
}

describe('PrimarySocketDelivery', () => {
  test('bounds direct JSON replies and rejects late writes after overflow', () => {
    const delivery = new PrimarySocketDelivery(16);
    const { socket } = socketFixture();
    const peer = delivery.add(socket);
    expect(sendWebSocketJson(peer, { text: 'first' })).toBe(true);
    expect(socket.getBufferedAmount()).toBe(16);
    expect(sendWebSocketJson(peer, { text: 'overflow' })).toBe(false);
    expect(socket.terminate).toHaveBeenCalledTimes(1);
    expect(sendWebSocketPayload(peer, 'late')).toBe(0);
    expect(sendWebSocketJson(peer, { text: 'late' })).toBe(false);
    expect(socket.send).toHaveBeenCalledTimes(2);
    expect(socket.send).toHaveBeenNthCalledWith(1, '{"text":"first"}', true);
  });

  test('broadcasts share the direct budget without dropping healthy subscribers', () => {
    const delivery = new PrimarySocketDelivery(16);
    const slow = socketFixture();
    const fast = socketFixture();
    const otherTopic = socketFixture();
    const slowPeer = delivery.add(slow.socket);
    const fastPeer = delivery.add(fast.socket);
    delivery.add(otherTopic.socket).subscribe('other');
    slowPeer.subscribe('chat');
    fastPeer.subscribe('chat');
    sendWebSocketPayload(slowPeer, 'already buffered');
    expect(publishWebSocketPayload(delivery, 'chat', 'broadcast')).toBe(-1);
    expect(slow.socket.terminate).toHaveBeenCalledTimes(1);
    expect(fast.socket.terminate).not.toHaveBeenCalled();
    expect(fast.socket.send).toHaveBeenCalledWith('broadcast', true);
    expect(otherTopic.socket.send).not.toHaveBeenCalled();
    fast.drain();
    publishWebSocketPayload(delivery, 'chat', 'next');
    expect(slow.socket.send).toHaveBeenCalledTimes(2);
    expect(fast.socket.send).toHaveBeenCalledWith('next', true);
  });

  test('counts native buffered bytes, not the uncompressed message size', () => {
    const delivery = new PrimarySocketDelivery(16);
    const { socket } = socketFixture();
    socket.send.mockImplementation((payload) => Buffer.byteLength(payload));
    const payload = 'large immediately delivered message'.repeat(100);
    expect(sendWebSocketPayload(delivery.add(socket), payload)).toBe(Buffer.byteLength(payload));
    expect(socket.terminate).not.toHaveBeenCalled();
  });

  test('keeps socket identity across callbacks and prunes closed peers', () => {
    const delivery = new PrimarySocketDelivery(16);
    const { socket } = socketFixture();
    const peer = delivery.add(socket);
    peer.subscribe('chat');
    expect(delivery.get(socket)).toBe(peer);
    expect(delivery.remove(socket)).toBe(peer);
    expect(delivery.get(socket)).toBeUndefined();
    expect(sendWebSocketPayload(peer, 'late')).toBe(0);
    expect(publishWebSocketPayload(delivery, 'chat', 'late')).toBe(0);
    expect(socket.send).not.toHaveBeenCalled();
  });

  test('stops delivery during a locally initiated close', () => {
    const delivery = new PrimarySocketDelivery(16);
    const { socket } = socketFixture();
    const peer = delivery.add(socket);
    peer.subscribe('chat');
    peer.close(1013, 'closing');
    expect(socket.close).toHaveBeenCalledWith(1013, 'closing');
    expect(sendWebSocketPayload(peer, 'late')).toBe(0);
    expect(publishWebSocketPayload(delivery, 'chat', 'late')).toBe(0);
    expect(socket.send).not.toHaveBeenCalled();
  });
});
