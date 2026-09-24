import { isRuntimeProbeChallenge, type CliContext } from '@garcon/common/server-runtime';
import { markRouteNoAuth } from '../lib/http-route.js';
import type { RouteMap } from '../lib/http-route-types.js';
import { createServerRuntimeProof, type ServerRuntimeState } from '../lib/server-runtime.js';

export function createRuntimeRoutes(runtime: ServerRuntimeState, workspaceName: string | null = null): RouteMap {
  return {
    '/api/v1/cli/context': {
      GET: () => Response.json({
        serverInstanceId: runtime.identity.instanceId,
        defaultNodeId: 'local',
        workspaceName,
      } satisfies CliContext, { headers: { 'Cache-Control': 'no-store' } }),
    },
    '/api/v1/runtime': {
      GET: markRouteNoAuth((_request, url) => {
        const challenge = url.searchParams.get('challenge');
        if (!isRuntimeProbeChallenge(challenge)) {
          return Response.json({ error: 'challenge must be 32-byte base64url data' }, {
            status: 400,
            headers: { 'Cache-Control': 'no-store' },
          });
        }
        return Response.json({
          schemaVersion: runtime.identity.schemaVersion,
          instanceId: runtime.identity.instanceId,
          proof: createServerRuntimeProof(runtime, challenge),
        }, {
          headers: { 'Cache-Control': 'no-store' },
        });
      }),
    },
  };
}
