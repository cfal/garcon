import { afterEach, describe, expect, it } from 'bun:test';
import net from 'node:net';
import { PRIMARY_WEBSOCKET_TRANSPORT_OPTIONS } from '../transport-options.ts';

let server = null;

afterEach(async () => {
  await server?.stop(true);
  server = null;
});

describe('primary WebSocket transport options', () => {
  it('does not negotiate permessage-deflate', async () => {
    server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request, bunServer) {
        if (bunServer.upgrade(request)) return;
        return new Response('Upgrade failed', { status: 400 });
      },
      websocket: {
        ...PRIMARY_WEBSOCKET_TRANSPORT_OPTIONS,
        message() {},
      },
    });

    const response = await websocketHandshake(server.port);

    expect(response).toContain('HTTP/1.1 101 Switching Protocols');
    expect(response.toLowerCase()).not.toContain('sec-websocket-extensions');
  });
});

function websocketHandshake(port) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    let response = '';

    socket.setEncoding('utf8');
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
      response += chunk;
      if (!response.includes('\r\n\r\n')) return;
      socket.end();
      resolve(response);
    });
    socket.on('timeout', () => {
      socket.destroy(new Error('Timed out waiting for WebSocket handshake'));
    });
    socket.on('error', reject);
  });
}
