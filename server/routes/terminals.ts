import {
  parseTerminalCreateRequest,
  parseTerminalTerminateRequest,
  type TerminalListResponse,
} from '../../common/terminal.js';
import { jsonError } from '../lib/http-error.js';
import type { HttpRouteContext, RouteMap } from '../lib/http-route-types.js';
import { withJsonBody } from '../lib/json-route.js';
import {
  TerminalManager,
  TerminalManagerError,
} from '../terminals/terminal-manager.js';

function terminalError(error: unknown): Response {
  if (error instanceof TerminalManagerError) {
    return jsonError(
      error.message,
      error.status,
      error.code,
      error.status >= 500,
    );
  }
  return jsonError(
    'Terminal operation failed.',
    500,
    'terminal-internal',
    true,
  );
}

function requirePrincipal(context?: HttpRouteContext) {
  return context?.principal ?? null;
}

export default function createTerminalRoutes(
  manager: TerminalManager,
): RouteMap {
  return {
    '/api/v1/terminals': {
      GET: (_request, _url, _server, context) => {
        const principal = requirePrincipal(context);
        if (!principal)
          return jsonError(
            'Authentication required.',
            401,
            'terminal-validation',
          );
        return Response.json({
          success: true,
          terminals: manager.list(principal),
        } satisfies TerminalListResponse);
      },
      POST: withJsonBody(
        async (body: unknown, _request, _url, _server, context) => {
          const principal = requirePrincipal(context);
          if (!principal)
            return jsonError(
              'Authentication required.',
              401,
              'terminal-validation',
            );
          const input = parseTerminalCreateRequest(body);
          if (!input)
            return jsonError(
              'Invalid terminal create request.',
              400,
              'terminal-validation',
            );
          try {
            return Response.json(await manager.create(principal, input), {
              status: 201,
            });
          } catch (error) {
            return terminalError(error);
          }
        },
      ),
      DELETE: withJsonBody(
        async (body: unknown, _request, _url, _server, context) => {
          const principal = requirePrincipal(context);
          if (!principal)
            return jsonError(
              'Authentication required.',
              401,
              'terminal-validation',
            );
          const input = parseTerminalTerminateRequest(body);
          if (!input)
            return jsonError(
              'Invalid terminal terminate request.',
              400,
              'terminal-validation',
            );
          try {
            return Response.json(
              await manager.terminate(
                principal,
                input.terminalId,
                input.requestId,
              ),
            );
          } catch (error) {
            return terminalError(error);
          }
        },
      ),
    },
  };
}
