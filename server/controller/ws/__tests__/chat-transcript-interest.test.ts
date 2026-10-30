import { describe, expect, mock, test } from 'bun:test';
import { ChatTranscriptInterestRegistry } from '../chat-transcript-interest.js';
import { PrimarySocketDelivery } from '../primary-delivery.js';
import { publishSelectedWebSocketPayload } from '../transport.js';
import { LOCAL_SERVER_PRINCIPAL } from '../../lib/http-route-types.js';

function socketFixture() {
  const topics = new Set<string>();
  const socket = {
    data: { connectionId: crypto.randomUUID(), principal: LOCAL_SERVER_PRINCIPAL },
    readyState: 1,
    subscribe: (topic: string) => { topics.add(topic); return true; },
    isSubscribed: (topic: string) => topics.has(topic),
    send: mock((payload: string, _compress?: boolean) => Buffer.byteLength(payload)),
    getBufferedAmount: () => 0,
    close: mock((_code?: number, _reason?: string) => {}),
    terminate: mock(() => {}),
  } satisfies Parameters<PrimarySocketDelivery['add']>[0];
  return socket;
}

describe('ChatTranscriptInterestRegistry', () => {
  test('replaces each socket set independently and prunes on release', () => {
    const registry = new ChatTranscriptInterestRegistry();
    const first = { readyState: 1 };
    const second = { readyState: 1 };

    registry.declare(first, ['chat-a', 'chat-b']);
    registry.declare(second, ['chat-a']);
    registry.declare(first, ['chat-b']);

    expect(registry.isInterested(first, 'chat-a')).toBe(false);
    expect(registry.isInterested(first, 'chat-b')).toBe(true);
    expect(registry.isInterested(second, 'chat-a')).toBe(true);
    registry.declare(second, []);
    expect(registry.socketCount).toBe(1);
    registry.release(first);
    expect(registry.socketCount).toBe(0);
    expect(registry.isInterested(first, 'chat-b')).toBe(false);
  });

  test('ignores a declaration that arrives for a closed socket', () => {
    const registry = new ChatTranscriptInterestRegistry();
    const closed = { readyState: 3 };

    registry.declare(closed, ['chat-a']);

    expect(registry.isInterested(closed, 'chat-a')).toBe(false);
    expect(registry.socketCount).toBe(0);
  });

  test('serializes each payload once and only when a socket receives it', () => {
    const registry = new ChatTranscriptInterestRegistry();
    const interested = { readyState: 1 };
    const body = mock(() => 'body');
    const summary = mock(() => 'summary');
    registry.declare(interested, ['chat-a']);

    const select = registry.payloadSelector('chat-a', { body, summary });
    expect(select(interested)).toBe('body');
    expect(select(interested)).toBe('body');
    expect(body).toHaveBeenCalledTimes(1);
    expect(summary).not.toHaveBeenCalled();
  });
});

describe('selective transcript delivery', () => {
  test('sends bodies to interested chat sockets and summaries to the rest', () => {
    const delivery = new PrimarySocketDelivery(1024 * 1024);
    const registry = new ChatTranscriptInterestRegistry();
    const displaying = socketFixture();
    const background = socketFixture();
    const terminalOnly = socketFixture();
    const displayingPeer = delivery.add(displaying);
    delivery.add(background).subscribe('chat');
    delivery.add(terminalOnly);
    displayingPeer.subscribe('chat');
    registry.declare(displayingPeer, ['chat-a']);

    publishSelectedWebSocketPayload(delivery, 'chat', registry.payloadSelector('chat-a', {
      body: () => 'body-a',
      summary: () => 'summary-a',
    }));
    publishSelectedWebSocketPayload(delivery, 'chat', registry.payloadSelector('chat-b', {
      body: () => 'body-b',
      summary: () => 'summary-b',
    }));

    expect(displaying.send.mock.calls).toEqual([['body-a', true], ['summary-b', true]]);
    expect(background.send.mock.calls).toEqual([['summary-a', true], ['summary-b', true]]);
    expect(terminalOnly.send).not.toHaveBeenCalled();
  });
});
