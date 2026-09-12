import { expect, test } from 'bun:test';
import { connect } from 'node:net';
import type { ServerWebSocket } from 'bun';
import { NODE_SOCKET_PROTOCOL_ALLOWANCE_BYTES, NodeSocketWriter, type NodeSocketPort } from '../socket-writer.js';
import { serverNodeSocketPort, clientNodeSocketPort } from '../bun-sockets.js';

// The peer pauses its TCP reader so Bun's actual native send buffer must absorb backpressure.
test('Bun server backpressure drains its captured physical writer without retransmission', async () => {
  const physical = new AbortController();
  let writer: NodeSocketWriter | null = null;
  let sends = 0;
  const { server, peer, socket } = await pausedServerPeer(() => writer?.drain(), () => physical.abort());
  try {
    const port = {
      get open() { return socket.readyState === 1; },
      get bufferedBytes() { return socket.getBufferedAmount(); },
      bufferedFrameBytes: serverNodeSocketPort(socket).bufferedFrameBytes,
      send(serialized: string) { sends += 1; return socket.send(serialized) !== 0; },
      terminate() { socket.terminate(); },
    } satisfies NodeSocketPort;
    writer = new NodeSocketWriter(port, { signal: physical.signal, maxFrameBytes: 64 * 1024,
      maxBufferedBytes: 512 * 1024, reservedControlBytes: 4096, reservedLifecycleBytes: 1024, maxDrainWaiters: 1, drainTimeoutMs: 2_000,
    });
    const frame = 'x'.repeat(64 * 1024);
    while (!socket.getBufferedAmount() && sends < 1024) writer.send(frame);
    expect(socket.getBufferedAmount()).toBeGreaterThan(0);
    const before = sends;
    const draining = writer.drained(physical.signal);
    peer.resume();
    await draining;
    expect(socket.getBufferedAmount()).toBe(0);
    expect(sends).toBe(before);
  } finally {
    writer?.close();
    peer.destroy();
    await server.stop(true);
  }
}, 5_000);

test('Bun server frame headers participate in exact native-buffer admission', async () => {
  const physical = new AbortController();
  let writer: NodeSocketWriter | null = null;
  const { server, peer, socket } = await pausedServerPeer(() => writer?.drain(), () => physical.abort());
  try {
    const frame = 'x'.repeat(65_536);
    let sends = 0;
    while (!socket.getBufferedAmount() && sends++ < 1024) socket.send(frame);
    expect(socket.getBufferedAmount()).toBeGreaterThan(0);
    socket.send(frame);
    const port = serverNodeSocketPort(socket);
    for (const length of [1, 1000, 65_536]) {
      const before = port.bufferedBytes;
      expect(port.send('x'.repeat(length))).toBe(true);
      expect(port.bufferedBytes - before).toBe(port.bufferedFrameBytes(length));
    }
    const before = port.bufferedBytes;
    const maxBufferedBytes = before + 65_536;
    writer = new NodeSocketWriter(port, { signal: physical.signal, maxFrameBytes: 65_536,
      maxBufferedBytes, reservedControlBytes: 4096, reservedLifecycleBytes: 1024, maxDrainWaiters: 1, drainTimeoutMs: 2_000,
    });
    expect(writer.send(frame)).toBe(false);
    expect(port.bufferedBytes).toBe(before);
    expect(port.open).toBe(true);
    expect(writer.send('x'.repeat(65_532))).toBe(true);
    expect(port.bufferedBytes).toBe(maxBufferedBytes);
    expect(writer.send('x')).toBe(false);
    const draining = writer.drained(physical.signal);
    peer.resume();
    await draining;
    expect(port.bufferedBytes).toBe(0);
    expect(port.open).toBe(true);
  } finally {
    writer?.close();
    peer.destroy();
    await server.stop(true);
  }
}, 5_000);

test('Bun client buffering drains through polling when the remote TCP reader resumes', async () => {
  const physical = new AbortController();
  const { socket, peer, dispose } = await pausedClientPeer(() => physical.abort());
  let writer: NodeSocketWriter | null = null;
  let sends = 0;
  try {
    const port = {
      get open() { return socket.readyState === WebSocket.OPEN; },
      get bufferedBytes() { return socket.bufferedAmount; },
      bufferedFrameBytes: clientNodeSocketPort(socket).bufferedFrameBytes,
      send(serialized: string) { sends += 1; socket.send(serialized); return true; },
      terminate() { socket.terminate(); },
    } satisfies NodeSocketPort;
    writer = new NodeSocketWriter(port, { signal: physical.signal, maxFrameBytes: 64 * 1024,
      maxBufferedBytes: 512 * 1024, reservedControlBytes: 4096, reservedLifecycleBytes: 1024, maxDrainWaiters: 1, drainTimeoutMs: 2_000,
    });
    const frame = 'x'.repeat(64 * 1024);
    while (!socket.bufferedAmount && sends < 1024) writer.send(frame);
    expect(socket.bufferedAmount).toBeGreaterThan(0);
    const before = sends;
    const draining = writer.drained(physical.signal);
    peer.resume();
    await draining;
    expect(socket.bufferedAmount).toBe(0);
    expect(sends).toBe(before);
  } finally {
    writer?.close();
    await dispose();
  }
}, 5_000);

test('Bun client masked headers participate in exact native-buffer admission', async () => {
  const physical = new AbortController();
  const { socket, peer, dispose } = await pausedClientPeer(() => physical.abort());
  let writer: NodeSocketWriter | null = null;
  try {
    const frame = 'x'.repeat(65_536);
    let sends = 0;
    while (!socket.bufferedAmount && sends++ < 1024) socket.send(frame);
    expect(socket.bufferedAmount).toBeGreaterThan(0);
    socket.send(frame);
    const port = clientNodeSocketPort(socket);
    for (const length of [1, 125, 126, 1000, 65_535, 65_536]) {
      const before = port.bufferedBytes;
      expect(port.send('x'.repeat(length))).toBe(true);
      expect(port.bufferedBytes - before).toBe(port.bufferedFrameBytes(length));
    }
    const before = port.bufferedBytes;
    const maxBufferedBytes = before + 65_536;
    writer = new NodeSocketWriter(port, { signal: physical.signal, maxFrameBytes: 65_536,
      maxBufferedBytes, reservedControlBytes: 4096, reservedLifecycleBytes: 1024, maxDrainWaiters: 1, drainTimeoutMs: 2_000,
    });
    expect(writer.send(frame)).toBe(false);
    expect(port.bufferedBytes).toBe(before);
    expect(port.open).toBe(true);
    expect(writer.send('x'.repeat(65_528))).toBe(true);
    expect(port.bufferedBytes).toBe(maxBufferedBytes);
    expect(writer.send('x')).toBe(false);
    const draining = writer.drained(physical.signal);
    peer.resume();
    await draining;
    expect(port.bufferedBytes).toBe(0);
    expect(port.open).toBe(true);
  } finally {
    writer?.close();
    await dispose();
  }
}, 5_000);

for (const side of ['server', 'client'] as const) {
  test(`Bun ${side} automatic pongs saturate application capacity without corrupting the writer`, async () => {
    const physical = new AbortController();
    let pingReceived = Promise.withResolvers<void>();
    const ping = () => { setImmediate(() => pingReceived.resolve()); };
    const fixture = side === 'server'
      ? await pausedServerPeer(() => {}, () => physical.abort(), ping)
      : await pausedClientPeer(() => physical.abort(), ping);
    const port = 'server' in fixture ? serverNodeSocketPort(fixture.socket) : clientNodeSocketPort(fixture.socket);
    const maxBufferedBytes = 512 * 1024;
    const writer = new NodeSocketWriter(port, { signal: physical.signal, maxFrameBytes: 65_536,
      maxBufferedBytes, reservedControlBytes: 4096, reservedLifecycleBytes: 1024, maxDrainWaiters: 1, drainTimeoutMs: 2_000 });
    try {
      let observedPongBacklog = false;
      for (let attempt = 0; attempt < 32 && !observedPongBacklog; attempt += 1) {
        let count = 0;
        while (writer.send('x'.repeat(65_536)) && count++ < 1024) {}
        const remaining = maxBufferedBytes - port.bufferedBytes;
        const cost = side === 'server' ? [2, 4, 10] : [6, 8, 14];
        const padding = cost.map((header) => remaining - header)
          .find((length) => length > 0 && port.bufferedFrameBytes(length) === remaining);
        if (padding !== undefined) expect(writer.send('x'.repeat(padding))).toBe(true);
        expect(port.bufferedBytes).toBe(maxBufferedBytes);
        pingReceived = Promise.withResolvers<void>();
        fixture.peer.write(pingFrame(side === 'server'));
        await pingReceived.promise;
        observedPongBacklog = port.bufferedBytes > maxBufferedBytes;
        if (observedPongBacklog) expect(writer.send('x')).toBe(false);
        expect(port.open).toBe(true);
      }
      expect(observedPongBacklog).toBe(true);
      const drained = writer.drained(physical.signal);
      fixture.peer.resume();
      await drained;
      expect(port.bufferedBytes).toBe(0);
      expect(writer.send('after pong')).toBe(true);
    } finally {
      writer.close();
      if ('server' in fixture) { fixture.peer.destroy(); await fixture.server.stop(true); }
      else await fixture.dispose();
    }
  }, 5_000);
}

test('idle Bun client automatic pongs remain bounded without any application send or drain waiter', async () => {
  const closed = Promise.withResolvers<void>();
  let received = 0;
  let through = 0;
  let batch = Promise.withResolvers<void>();
  const fixture = await pausedClientPeer(() => closed.resolve(), () => {
    if (++received >= through) batch.resolve();
  });
  fixture.peer.on('error', () => {});
  const port = clientNodeSocketPort(fixture.socket);
  const polls: { callback(): void; delayMs: number; cancelled: boolean }[] = [];
  const maxBufferedBytes = 1024;
  const writer = new NodeSocketWriter(port, { signal: new AbortController().signal, maxFrameBytes: 512,
    maxBufferedBytes, reservedControlBytes: 128, reservedLifecycleBytes: 32, maxDrainWaiters: 1, drainTimeoutMs: 2_000,
    schedulePoll(callback, delayMs) {
      const poll = { callback, delayMs, cancelled: false };
      polls.push(poll);
      return { cancel() { poll.cancelled = true; } };
    } });
  try {
    expect(port.bufferedBytes).toBe(0);
    const pings = Buffer.concat(Array.from({ length: 1024 }, () => pingFrame(false)));
    for (let attempt = 0; attempt < 128 && port.bufferedBytes <= maxBufferedBytes + NODE_SOCKET_PROTOCOL_ALLOWANCE_BYTES; attempt += 1) {
      batch = Promise.withResolvers<void>();
      through = received + 1024;
      fixture.peer.write(pings);
      await Promise.race([batch.promise, closed.promise]);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(port.bufferedBytes).toBeGreaterThan(maxBufferedBytes + NODE_SOCKET_PROTOCOL_ALLOWANCE_BYTES);
    expect(polls).toHaveLength(1);
    expect(polls[0]).toMatchObject({ delayMs: 100, cancelled: false });
    polls[0]!.callback();
    expect(port.open).toBe(false);
    try { writer.send('unreachable'); throw new Error('Idle writer remained usable'); }
    catch (error) { expect(error).toMatchObject({ code: 'NODE_SOCKET_BACKPRESSURE' }); }
  } finally { writer.close(); await fixture.dispose(); }
}, 5_000);

function pingFrame(masked: boolean): Buffer {
  const payload = Buffer.alloc(125, 120);
  if (!masked) return Buffer.concat([Buffer.from([0x89, payload.length]), payload]);
  const mask = Buffer.from([1, 2, 3, 4]);
  for (let index = 0; index < payload.length; index += 1) payload[index]! ^= mask[index % 4]!;
  return Buffer.concat([Buffer.from([0x89, 0x80 | payload.length]), mask, payload]);
}

async function pausedServerPeer(drain: () => void, close: () => void, ping = () => {}) {
  const accepted = Promise.withResolvers<ServerWebSocket<undefined>>();
  const server = Bun.serve<undefined>({
    hostname: '0.0.0.0', port: 0,
    fetch(request, server) {
      if (server.upgrade(request, { data: undefined })) return;
      return new Response(null, { status: 400 });
    },
    websocket: {
      // This shared fixture exceeds every tested writer ceiling and its protocol allowance.
      backpressureLimit: 1024 * 1024, closeOnBackpressureLimit: true,
      open(socket) { accepted.resolve(socket); }, message() {}, drain, close, ping,
    },
  });
  const peer = connect({ host: '127.0.0.1', port: server.port! });
  const upgraded = Promise.withResolvers<void>();
  let header = '';
  peer.on('data', (data) => {
    if (header.endsWith('\r\n\r\n')) return;
    header += data.toString();
    if (header.includes('\r\n\r\n')) { peer.pause(); upgraded.resolve(); }
  });
  peer.on('error', (error) => upgraded.reject(error));
  peer.write('GET / HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: c3ludGhldGljLWtleS0xMg==\r\n\r\n');
  try {
    await upgraded.promise;
    return { server, peer, socket: await accepted.promise };
  } catch (error) {
    peer.destroy();
    await server.stop(true);
    throw error;
  }
}

async function pausedClientPeer(close: () => void, ping = () => {}) {
  const { createServer } = await import('node:net');
  const { createHash } = await import('node:crypto');
  const connected = Promise.withResolvers<import('node:net').Socket>();
  const listener = createServer((peer) => {
    connected.resolve(peer);
    let header = '';
    peer.on('data', (data) => {
      if (header.endsWith('\r\n\r\n')) return;
      header += data.toString();
      if (!header.endsWith('\r\n\r\n')) return;
      const key = /sec-websocket-key:\s*([^\r\n]+)/i.exec(header)?.[1];
      if (!key) { peer.destroy(); return; }
      const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
      peer.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      peer.pause();
    });
  });
  await new Promise<void>((resolve) => listener.listen(0, '0.0.0.0', resolve));
  const address = listener.address();
  if (!address || typeof address === 'string') throw new Error('Missing synthetic socket listener');
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}`) as WebSocket & Pick<Bun.WebSocket, 'terminate'>;
  const opened = Promise.withResolvers<void>();
  socket.addEventListener('open', () => opened.resolve(), { once: true });
  socket.addEventListener('error', () => opened.reject(new Error('Synthetic socket failed')), { once: true });
  socket.addEventListener('close', close, { once: true });
  socket.addEventListener('ping', ping);
  async function dispose() {
    socket.terminate();
    (await connected.promise).destroy();
    await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  }
  try {
    await opened.promise;
    return { socket, peer: await connected.promise, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}
