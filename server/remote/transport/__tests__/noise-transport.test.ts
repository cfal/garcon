import { afterEach, expect, test } from 'bun:test';
import { connectNoiseWebSocket, createNoiseServer } from '@cfal/noise-ws';
import type { ServerWebSocket } from 'bun';
import { WebSocketLink, EXECUTOR_NOISE_CONTEXT } from '../websocket-link.js';

const secret = Buffer.alloc(32, 42).toString('base64url');
const options = { secret, executorId: 'synthetic-executor', allowInsecureDevelopment: true, reconnectDelayMs: 20 };
const cleanups: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function link(role: 'controller' | 'worker', overrides = {}) {
  const result = new WebSocketLink({ ...options, role, ...overrides });
  cleanups.push(() => result.dispose());
  return result;
}

interface RelayData { upstream: WebSocket | null; pending: Buffer[] }

function relay(target: string) {
  const frames: Buffer[] = [];
  const handshakes: Buffer[] = [];
  const sockets = new Set<ServerWebSocket<RelayData>>();
  let tamper = false;
  const server = Bun.serve<RelayData>({
    hostname: '0.0.0.0', port: 0,
    fetch(request, server) {
      if (server.upgrade(request, { data: { upstream: null, pending: [] } })) return;
      return new Response(null, { status: 400 });
    },
    websocket: {
      perMessageDeflate: false,
      open(socket) {
        sockets.add(socket);
        const upstream = new WebSocket(target);
        upstream.binaryType = 'arraybuffer';
        socket.data.upstream = upstream;
        upstream.addEventListener('open', () => {
          for (const frame of socket.data.pending.splice(0)) upstream.send(frame);
        });
        let first = true;
        upstream.addEventListener('message', ({ data }) => {
          const frame = typeof data === 'string' ? Buffer.from(data) : Buffer.from(data as ArrayBuffer);
          frames.push(Buffer.from(frame));
          if (first) { handshakes.push(Buffer.from(frame)); first = false; }
          if (tamper) { frame[frame.length - 1]! ^= 1; tamper = false; }
          socket.send(frame);
        });
        upstream.addEventListener('close', () => socket.close());
        upstream.addEventListener('error', () => socket.close());
      },
      message(socket, message) {
        const frame = Buffer.from(message);
        frames.push(Buffer.from(frame));
        if (socket.data.upstream?.readyState === WebSocket.OPEN) socket.data.upstream.send(frame);
        else socket.data.pending.push(frame);
      },
      close(socket) { sockets.delete(socket); socket.data.upstream?.close(); },
    },
  });
  cleanups.push(async () => {
    for (const socket of sockets) { socket.data.upstream?.close(); socket.close(); }
    await server.stop(true);
  });
  return { frames, handshakes, tamperNext: () => { tamper = true; }, url: `ws://127.0.0.1:${server.port}/executor` };
}

test('a wire relay sees neither credentials nor large payloads, including after reconnect', async () => {
  const worker = link('worker');
  const controller = link('controller');
  const wire = relay(worker.listen());
  const received: string[] = [];
  const first = Promise.withResolvers<void>();
  const replayed = Promise.withResolvers<void>();
  controller.onSession((session) => session.onMessage((message) => {
    received.push(message);
    if (received.length === 1) first.resolve();
    if (received.length === 2) replayed.resolve();
  }));
  controller.dial(wire.url);
  const [left, right] = await Promise.all([controller.ready, worker.ready]);
  const payload = 'synthetic-private-execution-payload/'.repeat(8192);
  right.send(payload);
  await first.promise;
  worker.onSession(session => { if (session !== right) void session.ready.then(() => session.send(payload)); });
  controller.disconnect();
  worker.disconnect();
  await replayed.promise;
  expect(received).toEqual([payload, payload]);
  expect(controller.current).not.toBe(left);
  expect(worker.current).not.toBe(right);
  expect(wire.handshakes.length).toBeGreaterThanOrEqual(2);
  expect(wire.handshakes[0]).not.toEqual(wire.handshakes[1]);
  expect(wire.frames.every((frame) => frame.length <= 65_535)).toBe(true);
  const captured = Buffer.concat(wire.frames);
  for (const value of [secret, Buffer.from(secret, 'base64url'), 'synthetic-private-execution-payload', '"type":"hello"']) {
    expect(captured.includes(value)).toBe(false);
  }
}, 10_000);

test('wire tampering disconnects before delivering application data', async () => {
  const worker = link('worker');
  const controller = link('controller', { reconnectDelayMs: 60_000 });
  const wire = relay(worker.listen());
  const received: string[] = [];
  controller.onSession((session) => session.onMessage((message) => received.push(message)));
  controller.dial(wire.url);
  const [left, right] = await Promise.all([controller.ready, worker.ready]);
  const disconnected = Promise.withResolvers<void>();
  left.onAvailability((connected) => { if (!connected) disconnected.resolve(); });
  wire.tamperNext();
  right.send('must-not-be-delivered');
  await disconnected.promise;
  expect(received).toEqual([]);
});

test.each(['key', 'context'])('wrong Noise %s is rejected before the Garcon hello or a logical session', async (wrong) => {
  const worker = link('worker');
  const received: unknown[] = [];
  const socket = connectNoiseWebSocket(worker.listen(), {
    psk: Buffer.alloc(32, wrong === 'key' ? 43 : 42), context: wrong === 'context' ? 'wrong-context' : EXECUTOR_NOISE_CONTEXT,
    onMessage: (_socket, message) => received.push(message),
  });
  cleanups.push(() => socket.close());
  const result = await socket.closed;
  expect(result.error).not.toBeNull();
  expect(worker.current).toBeNull();
  expect(received).toEqual([]);
});

test('binary Noise application messages are not accepted as Garcon JSON', async () => {
  const worker = link('worker');
  const socket = connectNoiseWebSocket(worker.listen(), {
    psk: Buffer.from(secret, 'base64url'), context: EXECUTOR_NOISE_CONTEXT,
    onOpen: (socket) => socket.send(Buffer.from(JSON.stringify({ type: 'hello', role: 'controller' }))), onMessage() {},
  });
  cleanups.push(() => socket.close());
  await socket.closed;
  expect(worker.current).toBeNull();
});

test('a failed encrypted fragment is discarded without replay on a fresh connection', async () => {
  const worker = link('worker');
  const controller = link('controller');
  const noise = createNoiseServer();
  let failAfter = 0;
  const server = Bun.serve({
    hostname: '0.0.0.0', port: 0,
    fetch(request, server) { return worker.upgrade(request, server, noise); },
    websocket: {
      ...noise.websocket,
      open(socket) {
        const send = socket.send.bind(socket);
        socket.send = (data, compress) => {
          if (failAfter > 0 && --failAfter === 0) return 0;
          return send(data, compress);
        };
        noise.websocket.open!(socket);
      },
    },
  });
  cleanups.push(async () => { noise.close(); await server.stop(true); });
  const received: string[] = [];
  const completed = Promise.withResolvers<void>();
  controller.onSession((session) => session.onMessage((message) => { received.push(message); completed.resolve(); }));
  controller.dial(`ws://127.0.0.1:${server.port}/executor`);
  const [left, right] = await Promise.all([controller.ready, worker.ready]);
  const payload = 'synthetic-large-message/'.repeat(8192);
  worker.onSession(session => { if (session !== right) void session.ready.then(() => session.send('new session')); });
  failAfter = 2;
  expect(() => right.send(payload)).toThrow();
  expect(right.connected).toBe(false);
  await completed.promise;
  expect(received).toEqual(['new session']);
  expect(controller.current).not.toBe(left);
  expect(worker.current).not.toBe(right);
});

test('plaintext downgrade is rejected without disclosing a Garcon hello', async () => {
  const worker = link('worker');
  const received: unknown[] = [];
  const closed = Promise.withResolvers<void>();
  const socket = new WebSocket(worker.listen());
  cleanups.push(() => socket.close());
  socket.addEventListener('open', () => socket.send(JSON.stringify({ type: 'hello', role: 'controller' })));
  socket.addEventListener('message', ({ data }) => received.push(data));
  socket.addEventListener('close', () => closed.resolve());
  await closed.promise;
  expect(received).toEqual([]);
  expect(worker.current).toBeNull();
});

test.each(['short', 'test-secret-longer-than-32-characters', 'B'.repeat(43)])('rejects a noncanonical PSK without echoing it', (value) => {
  expect(() => new WebSocketLink({ role: 'worker', secret: value })).toThrow('32-byte');
  try { new WebSocketLink({ role: 'worker', secret: value }); }
  catch (error) { expect(String(error)).not.toContain(value); }
});
