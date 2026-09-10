import {
  parseTerminalCreateRequest,
  parseTerminalRenameRequest,
  parseTerminalTerminateRequest,
  type TerminalListResponse,
} from '../../common/terminal.js';
import { jsonError } from '../lib/http-error.js';
import type { HttpRouteContext, RouteMap } from '../lib/http-route-types.js';
import { withJsonBody } from '../lib/json-route.js';
import type { WorkspaceTerminalService } from '../execution-nodes/workspace-terminals.js';
import { terminalErrorResponse } from './terminal-http-error.js';

function requirePrincipal(context?: HttpRouteContext) {
  return context?.principal ?? null;
}

export default function createTerminalRoutes(
  manager: Pick<WorkspaceTerminalService, 'list' | 'create' | 'rename' | 'terminate'>,
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
        try {
          return Response.json({
            success: true,
            terminals: manager.list(principal),
          } satisfies TerminalListResponse);
        } catch (error) {
          return terminalErrorResponse(error);
        }
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
            return terminalErrorResponse(error);
          }
        },
      ),
      PATCH: withJsonBody(
        async (body: unknown, _request, _url, _server, context) => {
          const principal = requirePrincipal(context);
          if (!principal)
            return jsonError(
              'Authentication required.',
              401,
              'terminal-validation',
            );
          const input = parseTerminalRenameRequest(body);
          if (!input)
            return jsonError(
              'Invalid terminal rename request.',
              400,
              'terminal-validation',
            );
          try {
            return Response.json(
              manager.rename(principal, input.terminalId, input.title),
            );
          } catch (error) {
            return terminalErrorResponse(error);
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
            return terminalErrorResponse(error);
          }
        },
      ),
    },
  };
}
