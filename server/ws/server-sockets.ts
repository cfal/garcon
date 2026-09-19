import type { ServerWebSocket, WebSocketHandler } from 'bun';
import { WsFaultMessage } from '../../common/ws-events.js';
import type { ServerConfig } from '../config.js';
import type { WebSocketLink, LinkSocketHandlers } from '../execution-nodes/websocket-link.js';
import type { ServerPrincipal } from '../lib/http-route-types.js';
import type { Logger } from '../lib/log.js';
import type { WebSocketAdmissionController } from '../lib/websocket-capacity.js';
import type { PrimaryWsHandler } from './primary.js';
import { PRIMARY_WEBSOCKET_TRANSPORT_OPTIONS } from './transport.js';
import { decodeWebSocketMessage, sendWebSocketJson } from './utils.js';

interface PrimaryConnectionData {
  kind: 'primary';
  connectionId: string;
  principal: ServerPrincipal;
}

export type WsConnectionData = PrimaryConnectionData | {
  kind: 'execution-node';
  link: WebSocketLink;
  handlers: LinkSocketHandlers | null;
};

function isPrimarySocket(socket: ServerWebSocket<WsConnectionData>): socket is ServerWebSocket<PrimaryConnectionData> {
  return socket.data.kind === 'primary';
}

export function createServerSocketHandlers(options: {
  primary: Pick<PrimaryWsHandler, 'open' | 'message' | 'drain' | 'close'>;
  admission: Pick<WebSocketAdmissionController, 'confirm' | 'release'>;
  config: Pick<ServerConfig, 'wsIdleTimeoutSeconds' | 'wsBackpressureLimit' | 'wsMaxPayloadLength'>;
  logger: Pick<Logger, 'error'>;
}): WebSocketHandler<WsConnectionData> {
  const { primary, admission, config, logger } = options;
  return {
    ...PRIMARY_WEBSOCKET_TRANSPORT_OPTIONS,
    idleTimeout: config.wsIdleTimeoutSeconds,
    sendPings: true,
    backpressureLimit: Math.max(config.wsBackpressureLimit, 4 * 1024 * 1024),
    closeOnBackpressureLimit: true,
    maxPayloadLength: Math.max(config.wsMaxPayloadLength, 16 * 1024 * 1024),
    open(ws) {
      if (!isPrimarySocket(ws)) {
        if (ws.data.kind !== 'execution-node') return;
        ws.data.handlers = ws.data.link.openSocket({
          get bufferedAmount() { return ws.getBufferedAmount(); },
          send: (frame) => { if (ws.send(frame) === 0) throw new Error('Socket write failed'); },
          close: () => ws.close(),
        });
        return;
      }
      const result = admission.confirm(ws.data.connectionId);
      if (!result.ok) { ws.close(1013, result.reason); return; }
      primary.open(ws);
    },
    async message(ws, message) {
      if (!isPrimarySocket(ws)) {
        if (ws.data.kind === 'execution-node') ws.data.handlers?.receive(decodeWebSocketMessage(message));
        return;
      }
      let data;
      try { data = JSON.parse(decodeWebSocketMessage(message)); }
      catch { sendWebSocketJson(ws, new WsFaultMessage('Malformed JSON')); return; }
      try { await primary.message(ws, data); }
      catch (error) {
        logger.error('primary WebSocket message failed:', error);
        sendWebSocketJson(ws, new WsFaultMessage('WebSocket operation failed'));
      }
    },
    drain(ws) {
      if (isPrimarySocket(ws)) primary.drain(ws);
    },
    close(ws, code, reason) {
      if (!isPrimarySocket(ws)) {
        if (ws.data.kind === 'execution-node') ws.data.handlers?.closed();
        return;
      }
      try { primary.close(ws, code, reason); }
      finally { admission.release(ws.data.connectionId); }
    },
  };
}
