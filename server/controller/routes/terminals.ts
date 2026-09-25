import {
  parseTerminalCreateRequest,
  parseTerminalRenameRequest,
  parseTerminalTerminateRequest,
} from '../../../common/terminal.js';
import { jsonError } from '../../common/http-error.js';
import type { HttpRouteContext, RouteMap } from '../lib/http-route-types.js';
import { withJsonBody } from '../lib/json-route.js';
import { type TerminalController, terminalOperationError } from '../terminals/controller.js';
import { parseExecutorId } from '../../../common/executors.js';

function terminalError(error: unknown): Response {
  const failure = terminalOperationError(error);
  return jsonError(failure.message, failure.status, failure.code, failure.status >= 500);
}

function requirePrincipal(context?: HttpRouteContext) {
  return context?.principal ?? null;
}

export default function createTerminalRoutes(
  manager: Pick<TerminalController, 'list' | 'create' | 'rename' | 'terminate'>,
): RouteMap {
  return {
    '/api/v1/terminals': {
      GET: async (_request, url, _server, context) => {
        const principal = requirePrincipal(context);
        if (!principal)
          return jsonError(
            'Authentication required.',
            401,
            'terminal-validation',
          );
        const executorId = parseExecutorId(url.searchParams.get('executorId'));
        if (!executorId) return jsonError('Invalid terminal executor.', 400, 'terminal-validation');
        try { return Response.json(await manager.list(principal, executorId)); }
        catch (error) { return terminalError(error); }
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
              await manager.rename(principal, input.terminalId, input.title),
            );
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
