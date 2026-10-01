import type { createNoiseServer } from '@cfal/noise-ws';
import type { Server } from 'bun';
import type { WebSocketAdmissionController } from '../../common/websocket-capacity.js';
import { verifyAuthTokenClaims } from '../auth/token.js';
import type { ExecutorManager } from '../executors/manager.js';
import { serverShuttingDownResponse } from '../lib/http-route.js';
import { LOCAL_SERVER_PRINCIPAL, type ServerPrincipal } from '../lib/http-route-types.js';
import { getWebSocketAuthToken, webSocketUpgradeHeaders } from '../lib/websocket-auth.js';
import type { WsConnectionData } from './server-sockets.js';

export function createWebSocketUpgradeHandler({ executors, executionSockets, wsAdmission, authDisabled, isShuttingDown }: {
  executors: Pick<ExecutorManager, 'inboundLink'>;
  executionSockets: ReturnType<typeof createNoiseServer>;
  wsAdmission: Pick<WebSocketAdmissionController, 'tryReserve' | 'release'>;
  authDisabled: boolean;
  isShuttingDown(): boolean;
}) {
  return async (request: Request, server: Pick<Server<WsConnectionData>, 'upgrade'>): Promise<Response | undefined> => {
    if (isShuttingDown()) return serverShuttingDownResponse();
    const url = new URL(request.url);

    if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
      const executorMatch = /^\/executor\/([0-9a-f-]+)$/u.exec(url.pathname);
      if (executorMatch) {
        const link = executors.inboundLink(executorMatch[1]!);
        if (!link) return new Response('Executor is unavailable', { status: 404 });
        return link.upgrade(request, server, executionSockets);
      }
      if (url.pathname !== '/ws') {
        return new Response('Not found', { status: 404 });
      }

      const token = getWebSocketAuthToken(request);
      const claims = authDisabled
        ? null
        : await verifyAuthTokenClaims(token);
      if (isShuttingDown()) return serverShuttingDownResponse();
      let principal: ServerPrincipal | null = null;
      if (authDisabled) {
        principal = LOCAL_SERVER_PRINCIPAL;
      } else if (claims) {
        principal = {
          mode: 'authenticated',
          key: claims.username,
          username: claims.username,
          expiresAtMs: claims.expiresAtMs,
        };
      }
      if (!principal) {
        return new Response('Unauthorized', { status: 401 });
      }

      const connectionId = crypto.randomUUID();
      const admission = wsAdmission.tryReserve(connectionId);
      if (!admission.ok)
        return new Response(admission.reason, { status: 503 });

      const upgradeOptions: {
        data: WsConnectionData;
        headers?: HeadersInit;
      } = {
        data: {
          kind: 'primary',
          connectionId,
          principal,
        },
      };
      const headers = webSocketUpgradeHeaders(request);
      if (headers) upgradeOptions.headers = headers;

      let upgraded: boolean;
      try {
        upgraded = server.upgrade(request, upgradeOptions);
      } catch (error) {
        wsAdmission.release(connectionId);
        throw error;
      }
      if (!upgraded) {
        wsAdmission.release(connectionId);
        return new Response('WebSocket upgrade failed', { status: 400 });
      }
      return;
    }

    return new Response('Not found', { status: 404 });
  };
}
