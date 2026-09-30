import { createNoiseServer, type NoiseSocketData } from '@cfal/noise-ws';
import type { WebSocketLink } from '../transport/websocket-link.js';

// Hosts a link's listener behind the Noise server's WebSocket handler, where a
// test can fault the socket beneath the encryption: drop its writes, report its
// buffer as full, drop the frames it receives, or inject one.
export function faultyNoiseListener(link: WebSocketLink) {
  const noise = createNoiseServer();
  let latest: Bun.ServerWebSocket<NoiseSocketData> | null = null;
  let dropWrites = false;
  let bufferFull = false;
  let deliverable = Number.POSITIVE_INFINITY;
  const server = Bun.serve<NoiseSocketData>({
    hostname: '127.0.0.1', port: 0,
    fetch: (request, server) => link.upgrade(request, server, noise),
    websocket: {
      ...noise.websocket,
      open(socket) {
        latest = socket;
        const send = socket.send.bind(socket);
        const getBufferedAmount = socket.getBufferedAmount.bind(socket);
        socket.send = (data, compress) => (dropWrites ? 0 : send(data, compress));
        socket.getBufferedAmount = () => (bufferFull ? Number.MAX_SAFE_INTEGER : getBufferedAmount());
        noise.websocket.open?.(socket);
      },
      message(socket, message) {
        if (deliverable <= 0) return;
        deliverable -= 1;
        noise.websocket.message(socket, message);
      },
    },
  });
  return {
    url: `ws://127.0.0.1:${server.port}/executor`,
    dropWrites() { dropWrites = true; },
    fillBuffer() { bufferFull = true; },
    // Delivers only the next frames received, up to the count, and drops the rest.
    deliverOnly(count: number) { deliverable = count; },
    // Delivers a frame to the latest connection as if its peer had sent it.
    inject(frame: Buffer<ArrayBuffer>) { noise.websocket.message(latest!, frame); },
    closeConnections() { noise.close(); },
    async stop() {
      noise.close();
      await server.stop(true);
    },
  };
}
