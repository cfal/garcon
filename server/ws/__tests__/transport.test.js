import { afterEach, describe, expect, it, mock } from 'bun:test';
import net from 'node:net';
import {
  PRIMARY_WEBSOCKET_TRANSPORT_OPTIONS,
  publishWebSocketPayload,
  sendWebSocketPayload,
} from '../transport.ts';
import { sendWebSocketJson } from '../utils.ts';

let server = null;

afterEach(async () => {
  await server?.stop(true);
  server = null;
});

describe('primary WebSocket transport', () => {
  it('requests compression for direct JSON and published messages', () => {
    const sender = { readyState: 1, send: mock(() => 1) };
    const publisher = { publish: mock(() => 1) };

    sendWebSocketJson(sender, { type: 'direct' });
    publishWebSocketPayload(publisher, 'chat', 'published');

    expect(sender.send).toHaveBeenCalledWith('{"type":"direct"}', true);
    expect(publisher.publish).toHaveBeenCalledWith('chat', 'published', true);
  });

  it('negotiates permessage-deflate and emits a compressed data frame', async () => {
    const payload = 'compressible'.repeat(1_024);
    server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request, bunServer) {
        if (bunServer.upgrade(request)) return;
        return new Response('Upgrade failed', { status: 400 });
      },
      websocket: {
        ...PRIMARY_WEBSOCKET_TRANSPORT_OPTIONS,
        open(socket) {
          sendWebSocketPayload(socket, payload);
        },
        message() {},
      },
    });

    const { headers, frame } = await websocketHandshakeAndFrame(server.port);

    expect(headers.toLowerCase()).toContain('sec-websocket-extensions: permessage-deflate');
    expect(frame[0] & 0x40).toBe(0x40);
    expect(frame[0] & 0x0f).toBe(0x01);
  });
});

function websocketHandshakeAndFrame(port) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    let response = Buffer.alloc(0);

    socket.setTimeout(2_000);
    socket.on('connect', () => {
      socket.write([
        'GET /ws HTTP/1.1',
        `Host: 127.0.0.1:${port}`,
        'Connection: Upgrade',
        'Upgrade: websocket',
        'Sec-WebSocket-Version: 13',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Extensions: permessage-deflate; client_max_window_bits',
        '',
        '',
      ].join('\r\n'));
    });
    socket.on('data', (chunk) => {
      response = Buffer.concat([response, chunk]);
      const headerEnd = response.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      const frame = response.subarray(headerEnd + 4);
      if (!hasCompleteFrame(frame)) return;

      socket.destroy();
      resolve({
        headers: response.subarray(0, headerEnd).toString('utf8'),
        frame,
      });
    });
    socket.on('timeout', () => {
      socket.destroy(new Error('Timed out waiting for compressed WebSocket frame'));
    });
    socket.on('error', reject);
  });
}

function hasCompleteFrame(frame) {
  if (frame.length < 2) return false;

  let headerLength = 2;
  let payloadLength = frame[1] & 0x7f;
  if (payloadLength === 126) {
    if (frame.length < 4) return false;
    headerLength += 2;
    payloadLength = frame.readUInt16BE(2);
  } else if (payloadLength === 127) {
    if (frame.length < 10) return false;
    headerLength += 8;
    payloadLength = Number(frame.readBigUInt64BE(2));
  }

  return frame.length >= headerLength + payloadLength;
}
