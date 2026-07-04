import {
  GARCON_WS_PROTOCOL,
  bearerTokenFromWebSocketProtocolHeader,
  webSocketProtocolHeaderContains,
} from '../../common/ws-auth.ts';
import { getTokenFromRequest } from './http-request.js';

export function getWebSocketAuthToken(request: Request): string | null {
  return getTokenFromRequest(request)
    ?? bearerTokenFromWebSocketProtocolHeader(request.headers.get('sec-websocket-protocol'));
}

export function webSocketUpgradeHeaders(request: Request): HeadersInit | undefined {
  const protocolHeader = request.headers.get('sec-websocket-protocol');
  if (!webSocketProtocolHeaderContains(protocolHeader, GARCON_WS_PROTOCOL)) return undefined;
  return { 'Sec-WebSocket-Protocol': GARCON_WS_PROTOCOL };
}
