import type { RouteMap } from '../lib/http-route-types.js';
import { jsonError } from '../lib/http-error.js';

export function createUnavailableMachineRoutes(): RouteMap {
  const unavailable = () => jsonError('This execution node does not provide file, Git, or terminal services', 501, 'OPERATION_UNSUPPORTED', false);
  return Object.fromEntries(['files', 'git', 'gh', 'terminals'].flatMap((service) =>
    [`/api/v1/${service}`, `/api/v1/${service}/*`].map((route) => [route, {
      GET: unavailable, POST: unavailable, PUT: unavailable, PATCH: unavailable, DELETE: unavailable,
    }]),
  ));
}
