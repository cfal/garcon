import type { ServerRuntimeProbe } from '@garcon/common/server-runtime';
import { markRouteNoAuth } from '../lib/http-route.js';
import type { RouteMap } from '../lib/http-route-types.js';

export function createRuntimeRoutes(probe: ServerRuntimeProbe): RouteMap {
  return {
    '/api/v1/runtime': {
      GET: markRouteNoAuth(() => Response.json(probe, {
        headers: { 'Cache-Control': 'no-store' },
      })),
    },
  };
}
