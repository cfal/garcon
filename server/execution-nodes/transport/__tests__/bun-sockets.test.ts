import { expect, mock, test } from 'bun:test';
import { clientNodeSocketPort, serverNodeSocketPort, type NodeClientSocket } from '../bun-sockets.js';
import { NodeSocketWriter } from '../socket-writer.js';

test.each([WebSocket.CLOSING, WebSocket.CLOSED])('a client closing during send cannot report delivery in state %s', (closing) => {
  let readyState: NodeClientSocket['readyState'] = WebSocket.OPEN;
  const socket = {
    get readyState() { return readyState; }, bufferedAmount: 0,
    send: mock(() => { readyState = closing; }), terminate: mock(() => {}),
  } satisfies Pick<NodeClientSocket, 'readyState' | 'bufferedAmount' | 'send' | 'terminate'>;
  const writer = new NodeSocketWriter(clientNodeSocketPort(socket), {
    signal: new AbortController().signal, maxFrameBytes: 1024, maxBufferedBytes: 2048, reservedControlBytes: 512,
    maxDrainWaiters: 1, drainTimeoutMs: 1_000,
  });
  expect(() => writer.send('synthetic frame')).toThrow('unavailable');
  expect(() => writer.send('synthetic retry')).toThrow('unavailable');
  expect(socket.send).toHaveBeenCalledTimes(1);
  expect(socket.terminate).toHaveBeenCalledTimes(1);
});

test('a server port distinguishes queued delivery from a dropped frame', () => {
  const socket = { readyState: 1 as const, getBufferedAmount: () => 10, send: mock(() => -1), terminate() {} };
  const port = serverNodeSocketPort(socket);
  expect(port.send('synthetic queued frame')).toBe(true);
  socket.send.mockReturnValue(0);
  expect(port.send('synthetic dropped frame')).toBe(false);
});
