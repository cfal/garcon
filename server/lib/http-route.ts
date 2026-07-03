import {
  authenticateHttpRequest,
  MalformedJsonError,
  withAuthenticatedUsername,
} from './http-request.js';
import { isAuthDisabled } from '../config.js';
import { malformedJsonResponse } from './json-route.js';
import { compressHttpResponse } from './http-compression.js';
import type { RouteHandler, RouteMap } from './http-route-types.js';
import { createLogger } from './log.js';

const logger = createLogger('lib:http-route');

const noAuthRouteMarker: unique symbol = Symbol('no-auth-route');

type MarkedRouteHandler = RouteHandler & { [noAuthRouteMarker]?: true };
type WrappedRouteHandler = (request: Request, server?: unknown) => Promise<Response>;
type WrappedRouteMap = Record<string, Record<string, WrappedRouteHandler>>;

// Marks a route handler as publicly accessible without JWT auth.
export function markRouteNoAuth<T extends RouteHandler>(handler: T): T {
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

export function isNoAuthHandler(handler: unknown): handler is MarkedRouteHandler {
  return typeof handler === 'function'
    && Boolean((handler as MarkedRouteHandler)[noAuthRouteMarker]);
}

async function invokeRouteHandler(handler: RouteHandler, req: Request, server?: unknown): Promise<Response> {
  const url = new URL(req.url);
  try {
    const response = (await handler(req, url, server)) || new Response('Not found', { status: 404 });
    return compressHttpResponse(req, response);
  } catch (error) {
    if (error instanceof MalformedJsonError) {
      return compressHttpResponse(req, malformedJsonResponse());
    }
    throw error;
  }
}

// Wraps one route handler with URL parsing and JWT auth enforcement.
export function wrapRoute(handler: RouteHandler, routePath: string, method: string): WrappedRouteHandler {
  if (isAuthDisabled()) {
    return async (req: Request, server?: unknown): Promise<Response> => {
      return invokeRouteHandler(handler, req, server);
    };
  }

  if (isNoAuthHandler(handler)) {
    logger.debug(`Skipping auth wrapping for ${method} ${routePath}`);
    return async (req: Request, server?: unknown): Promise<Response> => {
      return invokeRouteHandler(handler, req, server);
    };
  }

  return async (req: Request, server?: unknown): Promise<Response> => {
    const { errorResponse, username } = await authenticateHttpRequest(req);
    if (errorResponse) return compressHttpResponse(req, errorResponse);
    return invokeRouteHandler(handler, withAuthenticatedUsername(req, username!), server);
  };
}

// Wraps all routes in the route table with auth-aware wrappers.
export function wrapRoutes(rawRoutes: RouteMap): WrappedRouteMap {
  return Object.fromEntries(
    Object.entries(rawRoutes).map(([routePath, methods]) => [
      routePath,
      Object.fromEntries(
        Object.entries(methods).map(([method, handler]) => [method, wrapRoute(handler, routePath, method)])
      ),
    ])
  );
}
