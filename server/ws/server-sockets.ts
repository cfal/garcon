import type { ServerWebSocket, WebSocketHandler } from 'bun';
import type { NoiseSocketData } from '@cfal/noise-ws';
import { WsFaultMessage } from '../../common/ws-events.js';
import type { ServerConfig } from '../config.js';
import type { Logger } from '../lib/log.js';
import type { WebSocketAdmissionController } from '../lib/websocket-capacity.js';
import type { PrimaryWsHandler } from './primary.js';
import type { PrimarySocketDelivery, PrimaryWebSocketData } from './primary-delivery.js';
import { PRIMARY_WEBSOCKET_TRANSPORT_OPTIONS } from './transport.js';
import { decodeWebSocketMessage, sendWebSocketJson } from './utils.js';

interface PrimaryConnectionData extends PrimaryWebSocketData {
  kind: 'primary';
}

export type WsConnectionData = PrimaryConnectionData | NoiseSocketData;

function isPrimarySocket(socket: ServerWebSocket<WsConnectionData>): socket is ServerWebSocket<PrimaryConnectionData> {
  return socket.data.kind === 'primary';
}

function isExecutionSocket(socket: ServerWebSocket<WsConnectionData>): socket is ServerWebSocket<NoiseSocketData> {
  return socket.data.kind === 'noise-ws';
}

export function createServerSocketHandlers(options: {
  primary: Pick<PrimaryWsHandler, 'open' | 'message' | 'drain' | 'close'>;
  admission: Pick<WebSocketAdmissionController, 'confirm' | 'release'>;
  config: Pick<ServerConfig, 'wsIdleTimeoutSeconds' | 'wsBackpressureLimit' | 'wsMaxPayloadLength'>;
  logger: Pick<Logger, 'error'>;
  execution: WebSocketHandler<NoiseSocketData>;
  delivery: PrimarySocketDelivery;
}): WebSocketHandler<WsConnectionData> {
  const { primary, admission, config, logger, execution, delivery } = options;
  return {
    ...PRIMARY_WEBSOCKET_TRANSPORT_OPTIONS,
    idleTimeout: config.wsIdleTimeoutSeconds,
    sendPings: true,
    // Noise fragments may queue one complete 16 MiB message before Bun drains.
    backpressureLimit: Math.max(config.wsBackpressureLimit, 32 * 1024 * 1024),
    closeOnBackpressureLimit: true,
    maxPayloadLength: Math.max(config.wsMaxPayloadLength, 16 * 1024 * 1024),
    open(ws) {
      if (isExecutionSocket(ws)) { execution.open?.(ws); return; }
      if (!isPrimarySocket(ws)) return;
      const result = admission.confirm(ws.data.connectionId);
      if (!result.ok) { ws.close(1013, result.reason); return; }
      primary.open(delivery.add(ws));
    },
    async message(ws, message) {
      if (isExecutionSocket(ws)) { execution.message(ws, message); return; }
      if (!isPrimarySocket(ws)) return;
      const peer = delivery.get(ws);
      if (!peer || peer.readyState !== 1) return;
      let data;
      try { data = JSON.parse(decodeWebSocketMessage(message)); }
      catch { sendWebSocketJson(peer, new WsFaultMessage('Malformed JSON')); return; }
      try { await primary.message(peer, data); }
      catch (error) {
        logger.error('primary WebSocket message failed:', error);
        sendWebSocketJson(peer, new WsFaultMessage('WebSocket operation failed'));
      }
    },
    drain(ws) {
      if (isExecutionSocket(ws)) execution.drain?.(ws);
      else if (isPrimarySocket(ws)) {
        const peer = delivery.get(ws);
        if (peer?.readyState === 1) primary.drain(peer);
      }
    },
    close(ws, code, reason) {
      if (isExecutionSocket(ws)) { execution.close?.(ws, code, reason); return; }
      if (!isPrimarySocket(ws)) return;
      const peer = delivery.remove(ws);
      try { if (peer) primary.close(peer, code, reason); }
      finally { admission.release(ws.data.connectionId); }
    },
  };
}
