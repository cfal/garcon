import type { CliContext } from '@garcon/common/server-runtime';
import { markRouteNoAuth } from '../lib/http-route.js';
import type { RouteMap } from '../lib/http-route-types.js';
import type { ServerRuntimeState } from '../../common/server-runtime.js';
import { runtimeProofResponse } from '../../common/runtime-proof.js';

export function createRuntimeRoutes(runtime: ServerRuntimeState, workspaceName: string | null = null): RouteMap {
  return {
    '/api/v1/cli/context': {
      GET: () => Response.json({
        serverInstanceId: runtime.identity.instanceId,
        defaultExecutorId: 'local',
        workspaceName,
      } satisfies CliContext, { headers: { 'Cache-Control': 'no-store' } }),
    },
    '/api/v1/runtime': {
      GET: markRouteNoAuth((_request, url) => runtimeProofResponse(runtime, url)),
    },
  };
}
