import { sendWebSocketPayload } from './transport.js';

const OPEN_WS_STATE = 1;

type WS = import('bun').ServerWebSocket<unknown>;

function sendWebSocketMessage(ws: WS, payload: string): boolean {
  if (ws.readyState !== OPEN_WS_STATE) return false;
  sendWebSocketPayload(ws, payload);
  return true;
}

export function sendWebSocketJson(ws: WS, payload: unknown): boolean {
  return sendWebSocketMessage(ws, JSON.stringify(payload));
}

export function decodeWebSocketMessage(message: string | ArrayBuffer | Uint8Array): string {
  if (typeof message === 'string') return message;
  if (message instanceof ArrayBuffer) return Buffer.from(message).toString('utf8');
  return Buffer.from(message.buffer, message.byteOffset, message.byteLength).toString('utf8');
}
