import type { RouteMap } from './http-route-types.js';

export function composeRoutes(...groups: readonly RouteMap[]): RouteMap {
  const routes: RouteMap = {};
  for (const group of groups) {
    for (const [path, methods] of Object.entries(group)) {
      const combined = routes[path] ??= {};
      for (const [method, handler] of Object.entries(methods)) {
        if (Object.hasOwn(combined, method)) throw new Error(`Duplicate route: ${method} ${path}`);
        combined[method] = handler;
      }
    }
  }
  return routes;
}
