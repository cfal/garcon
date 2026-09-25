import { expect, test } from 'bun:test';
import { connectNoiseWebSocket, createNoiseServer, MAX_FRAME_BYTES, MAX_MESSAGE_BYTES } from '@cfal/noise-ws';
import { LOCAL_SERVER_PRINCIPAL } from '../../lib/http-route-types.js';
import { WebSocketAdmissionController } from '../../../common/websocket-capacity.js';
import { PrimarySocketDelivery } from '../primary-delivery.js';
import { createServerSocketHandlers, type WsConnectionData } from '../server-sockets.js';
import { publishWebSocketPayload, sendWebSocketPayload } from '../transport.js';

test('shared native frame admission reserves only the Noise frame ceiling', () => {
  for (const wsMaxPayloadLength of [1024, 1024 * 1024]) {
    const handlers = createServerSocketHandlers({
      primary: { open() {}, async message() {}, drain() {}, close() {} },
      admission: new WebSocketAdmissionController(1), delivery: new PrimarySocketDelivery(1024),
      config: { wsIdleTimeoutSeconds: 60, wsBackpressureLimit: 1024, wsMaxPayloadLength },
      execution: { message() {} }, logger: { error() {} },
    });
    expect(handlers.maxPayloadLength).toBe(Math.max(wsMaxPayloadLength, MAX_FRAME_BYTES));
  }
});

test('shared listener preserves large Noise messages and routes primary replies and broadcasts separately', async () => {
  const noise = createNoiseServer();
  const delivery = new PrimarySocketDelivery(1024);
  const admission = new WebSocketAdmissionController(1);
  const server = Bun.serve<WsConnectionData>({
    hostname: '0.0.0.0', port: 0,
    fetch(request, server) {
      if (new URL(request.url).pathname === '/ws') {
        const connectionId = crypto.randomUUID();
        admission.tryReserve(connectionId);
        if (server.upgrade(request, { data: { kind: 'primary', connectionId, principal: LOCAL_SERVER_PRINCIPAL } })) return;
        admission.release(connectionId);
        return new Response(null, { status: 400 });
      }
      return noise.upgrade(request, server, {
        psk: Buffer.alloc(32, 42), context: 'shared-socket-test',
        onMessage: (socket, message) => socket.send(message),
      });
    },
    websocket: createServerSocketHandlers({
      primary: {
        open(peer) { peer.subscribe('chat'); },
        async message(peer, data) { sendWebSocketPayload(peer, JSON.stringify(data)); },
        drain() {}, close() {},
      },
      config: { wsIdleTimeoutSeconds: 60, wsBackpressureLimit: 1024, wsMaxPayloadLength: 1024 },
      admission, delivery, execution: noise.websocket, logger: { error() {} },
    }),
  });
  const result = Promise.withResolvers<string | Uint8Array>();
  const encrypted = connectNoiseWebSocket(`ws://127.0.0.1:${server.port}/executor`, {
    psk: Buffer.alloc(32, 42), context: 'shared-socket-test',
    onMessage: (_socket, message) => result.resolve(message),
  });
  const browser = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
  const opened = new Promise<void>((resolve, reject) => {
    browser.onopen = () => resolve();
    browser.onerror = () => reject(new Error('Browser socket failed'));
  });
  const messages: string[] = [];
  const received = Promise.withResolvers<void>();
  browser.onmessage = (event) => {
    messages.push(String(event.data));
    if (messages.length === 2) received.resolve();
  };
  try {
    await encrypted.ready;
    await opened;
    const payload = 'x'.repeat(MAX_MESSAGE_BYTES);
    encrypted.send(payload);
    browser.send(JSON.stringify({ type: 'reply' }));
    publishWebSocketPayload(delivery, 'chat', JSON.stringify({ type: 'broadcast' }));
    expect(await result.promise).toBe(payload);
    await received.promise;
    expect(messages.sort()).toEqual(['{"type":"broadcast"}', '{"type":"reply"}']);
    expect(admission.size).toBe(1);
  } finally {
    browser.close();
    encrypted.close();
    noise.close();
    await server.stop(true);
  }
  expect(admission.size).toBe(0);
}, 10_000);

for (const [kind, oversized] of [
  ['text', 'x'.repeat(1025)],
  ['binary', Buffer.alloc(1025)],
  ['utf8', '\u00e9'.repeat(513)],
] as const) {
  test(`primary ${kind} payloads retain their configured byte limit on the shared listener`, async () => {
    const admission = new WebSocketAdmissionController(1);
    const received: unknown[] = [];
    const delivered = Promise.withResolvers<void>();
    const server = Bun.serve<WsConnectionData>({
      hostname: '0.0.0.0', port: 0,
      fetch(request, server) {
        const connectionId = crypto.randomUUID();
        admission.tryReserve(connectionId);
        if (server.upgrade(request, { data: { kind: 'primary', connectionId, principal: LOCAL_SERVER_PRINCIPAL } })) return;
        admission.release(connectionId);
        return new Response(null, { status: 400 });
      },
      websocket: createServerSocketHandlers({
        primary: {
          open() {}, close() {}, drain() {},
          async message(_peer, data) { received.push(data); delivered.resolve(); },
        },
        config: { wsIdleTimeoutSeconds: 60, wsBackpressureLimit: 1024, wsMaxPayloadLength: 1024 },
        admission, delivery: new PrimarySocketDelivery(1024),
        execution: { message() {} }, logger: { error() {} },
      }),
    });
    const browser = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
    const opened = new Promise<void>((resolve, reject) => {
      browser.onopen = () => resolve();
      browser.onerror = () => reject(new Error('Browser socket failed'));
    });
    const closed = new Promise<CloseEvent>((resolve) => { browser.onclose = resolve; });
    try {
      await opened;
      const atLimit = JSON.stringify({ body: 'x'.repeat(1024 - JSON.stringify({ body: '' }).length) });
      browser.send(atLimit);
      await delivered.promise;
      browser.send(oversized);
      expect((await closed).code).toBe(1009);
      expect(received).toEqual([JSON.parse(atLimit)]);
    } finally {
      browser.close();
      await server.stop(true);
    }
    expect(admission.size).toBe(0);
  });
}
