import { connectNoiseWebSocket } from '@cfal/noise-ws';
import { EXECUTOR_NOISE_CONTEXT } from '../transport/websocket-link.js';
import { primaryHello } from './link-hello.js';

// Peers that fail before the encrypted handshake completes, as anyone who can
// reach an executor endpoint without its secret can.

// Resolves once the endpoint has rejected the handshake as AUTHENTICATION_FAILED.
export async function connectWithWrongKey(url: string): Promise<void> {
  const socket = connectNoiseWebSocket(url, { psk: Buffer.alloc(32, 7), context: EXECUTOR_NOISE_CONTEXT, onMessage() {} });
  await socket.closed;
}

// Opens a socket that never starts the encrypted handshake, resolving once the endpoint accepts it.
export async function openSilentSocket(url: string): Promise<{ readonly socket: WebSocket; readonly closed: Promise<void> }> {
  const socket = new WebSocket(url);
  const closed = new Promise<void>((resolve) => socket.addEventListener('close', () => resolve()));
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve());
    socket.addEventListener('error', () => reject(new Error('The endpoint refused a silent socket')));
  });
  return { socket, closed };
}

// Resolves once the endpoint has rejected a frame too short to be a handshake as PROTOCOL_ERROR.
export async function sendMalformedRecord(url: string): Promise<void> {
  const socket = new WebSocket(url);
  const closed = new Promise((resolve) => socket.addEventListener('close', resolve));
  socket.addEventListener('open', () => socket.send(new Uint8Array(8)));
  await closed;
}

// Holds the secret but initiates a hello with the controller endpoint's own role.
export async function connectWithOwnRole(url: string, secret: string): Promise<void> {
  const socket = connectNoiseWebSocket(url, {
    psk: Buffer.from(secret, 'base64url'), context: EXECUTOR_NOISE_CONTEXT,
    onOpen(socket) { socket.send(JSON.stringify(primaryHello('controller'))); },
    onMessage() {},
  });
  await socket.closed;
}
