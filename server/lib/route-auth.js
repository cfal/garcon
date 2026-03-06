import { authenticateHttpRequest } from './http-native.js';
import { isAuthDisabled } from '../config.js';

const noAuthRouteMarker = Symbol('no-auth-route');

// Marks a route handler as publicly accessible without JWT auth.
export function markRouteNoAuth(handler) {
  if (typeof handler !== 'function') {
    throw new TypeError('Route handler must be a function');
  }
  Object.defineProperty(handler, noAuthRouteMarker, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return handler;
}

export function isNoAuthHandler(handler) {
  return Boolean(handler?.[noAuthRouteMarker]);
}

// Wraps one route handler with URL parsing and JWT auth enforcement.
export function wrapRoute(handler, routePath, method) {
  if (isAuthDisabled()) {
    return async (req) => {
      const url = new URL(req.url);
      return (await handler(req, url)) || new Response('Not found', { status: 404 });
    };
  }

  if (isNoAuthHandler(handler)) {
    console.debug(`Skipping auth wrapping for ${method} ${routePath}`);
    return async (req) => {
      const url = new URL(req.url);
      return (await handler(req, url)) || new Response('Not found', { status: 404 });
    };
  }

  return async (req) => {
    const url = new URL(req.url);
    const { errorResponse } = await authenticateHttpRequest(req);
    if (errorResponse) return errorResponse;
    return (await handler(req, url)) || new Response('Not found', { status: 404 });
  };
}

// Wraps all routes in the route table with auth-aware wrappers.
export function wrapRoutes(rawRoutes) {
  return Object.fromEntries(
    Object.entries(rawRoutes).map(([routePath, methods]) => [
      routePath,
      Object.fromEntries(
        Object.entries(methods).map(([method, handler]) => [method, wrapRoute(handler, routePath, method)])
      ),
    ])
  );
}
