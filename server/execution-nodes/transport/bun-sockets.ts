import type { ServerWebSocket } from 'bun';
import type { NodeSocketPort } from './socket-writer.js';

type ServerSocket = Pick<ServerWebSocket<unknown>, 'readyState' | 'getBufferedAmount' | 'send' | 'terminate'>;
export type NodeClientSocket = WebSocket & Pick<Bun.WebSocket, 'terminate'>;

export function createNodeClientSocket(url: URL, options: Bun.WebSocketOptions): NodeClientSocket {
  // DOM library declarations omit Bun's native TLS constructor and termination method.
  const Socket = WebSocket as typeof WebSocket & { new (url: URL, options: Bun.WebSocketOptions): NodeClientSocket };
  return new Socket(url, options);
}

export function serverNodeSocketPort(socket: ServerSocket): NodeSocketPort {
  return {
    get open() { return socket.readyState === 1; },
    get bufferedBytes() { return socket.getBufferedAmount(); },
    bufferedFrameBytes: (length) => length + (length < 126 ? 2 : length <= 65_535 ? 4 : 10),
    send: (serialized) => socket.send(serialized) !== 0,
    terminate: () => socket.terminate(),
  };
}

export function clientNodeSocketPort(socket: Pick<NodeClientSocket, 'readyState' | 'bufferedAmount' | 'send' | 'terminate'>): NodeSocketPort {
  return {
    get open() { return socket.readyState === WebSocket.OPEN; },
    get bufferedBytes() { return socket.bufferedAmount; },
    bufferedFrameBytes: (length) => length + (length < 126 ? 6 : length <= 65_535 ? 8 : 14),
    send(serialized) { socket.send(serialized); return socket.readyState === WebSocket.OPEN; },
    terminate: () => socket.terminate(),
  };
}
