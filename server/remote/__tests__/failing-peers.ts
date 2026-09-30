import { connectNoiseWebSocket } from '@cfal/noise-ws';
import { EXECUTOR_NOISE_CONTEXT } from '../transport/websocket-link.js';

// Peers that fail before the encrypted handshake completes, as anyone who can
// reach an executor endpoint without its secret can.

// Resolves once the endpoint has rejected the handshake as AUTHENTICATION_FAILED.
export async function connectWithWrongKey(url: string): Promise<void> {
  const socket = connectNoiseWebSocket(url, { psk: Buffer.alloc(32, 7), context: EXECUTOR_NOISE_CONTEXT, onMessage() {} });
  await socket.closed;
}

// Resolves once the endpoint has rejected a frame too short to be a handshake as PROTOCOL_ERROR.
export async function sendMalformedRecord(url: string): Promise<void> {
  const socket = new WebSocket(url);
  const closed = new Promise((resolve) => socket.addEventListener('close', resolve));
  socket.addEventListener('open', () => socket.send(new Uint8Array(8)));
  await closed;
}
