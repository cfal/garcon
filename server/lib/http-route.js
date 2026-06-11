import { authenticateHttpRequest, MalformedJsonError } from './http-request.js';
import { isAuthDisabled } from '../config.js';
import { malformedJsonResponse } from './json-route.js';

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

async function invokeRouteHandler(handler, req, server) {
  const url = new URL(req.url);
  try {
    return (await handler(req, url, server)) || new Response('Not found', { status: 404 });
  } catch (error) {
    if (error instanceof MalformedJsonError) {
      return malformedJsonResponse();
    }
    throw error;
  }
}

// Wraps one route handler with URL parsing and JWT auth enforcement.
export function wrapRoute(handler, routePath, method) {
  if (isAuthDisabled()) {
    return async (req, server) => {
      return invokeRouteHandler(handler, req, server);
    };
  }

  if (isNoAuthHandler(handler)) {
    console.debug(`Skipping auth wrapping for ${method} ${routePath}`);
    return async (req, server) => {
      return invokeRouteHandler(handler, req, server);
    };
  }

  return async (req, server) => {
    const { errorResponse } = await authenticateHttpRequest(req);
    if (errorResponse) return errorResponse;
    return invokeRouteHandler(handler, req, server);
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
