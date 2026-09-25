import { authenticateHttpRequest } from './http-request.js';
import { MalformedJsonError } from '../../common/http-body.js';
import { isAuthDisabled } from '../config.js';
import { malformedJsonResponse } from './json-route.js';
import { compressHttpResponse } from './http-compression.js';
import { jsonError } from '../../common/http-error.js';
import {
  LOCAL_SERVER_PRINCIPAL,
  type HttpRouteContext,
  type RouteHandler,
  type RouteMap,
} from './http-route-types.js';
import { createLogger } from '../../common/log.js';
import { CLI_SERVER_INSTANCE_HEADER } from '@garcon/common/server-runtime';

const logger = createLogger('lib:http-route');

const noAuthRouteMarker: unique symbol = Symbol('no-auth-route');
const noStoreRouteMarker: unique symbol = Symbol('no-store-route');

type MarkedRouteHandler = RouteHandler & { [noAuthRouteMarker]?: true; [noStoreRouteMarker]?: true };
type WrappedRouteHandler = (request: Request, server?: unknown) => Promise<Response>;
type WrappedRouteMap = Record<string, Record<string, WrappedRouteHandler>>;

export interface HttpRouteAuthOptions {
  localCapability?: string;
  serverInstanceId?: string;
  isShuttingDown?: () => boolean;
}

export function cliInstanceMismatch(request: Request, expected: string | undefined): Response | null {
  const supplied = request.headers.get(CLI_SERVER_INSTANCE_HEADER);
  return supplied !== null && supplied !== expected
    ? jsonError('Garcon restarted; start a new CLI invocation', 409, 'CLI_CONTROLLER_CHANGED', false)
    : null;
}

export function serverShuttingDownResponse(): Response {
  return jsonError('The server is shutting down', 503, 'SERVER_SHUTTING_DOWN', true);
}

interface RequestTimeoutServer {
  timeout(request: Request, seconds: number): void;
}

function supportsRequestTimeout(server: unknown): server is RequestTimeoutServer {
  return server !== null
    && typeof server === 'object'
    && typeof (server as { timeout?: unknown }).timeout === 'function';
}

export function disableRequestIdleTimeout(request: Request, server: unknown): void {
  if (supportsRequestTimeout(server)) server.timeout(request, 0);
}

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

export function markRouteNoStore<T extends RouteHandler>(handler: T): T {
  Object.defineProperty(handler, noStoreRouteMarker, { value: true });
  return handler;
}

export async function invokeRawRouteHandler(
  handler: RouteHandler,
  req: Request,
  server: unknown,
  context: HttpRouteContext,
): Promise<Response> {
  const url = new URL(req.url);
  try {
    const response = (await handler(req, url, server, context)) || new Response('Not found', { status: 404 });
    return response;
  } catch (error) {
    if (error instanceof MalformedJsonError) {
      return malformedJsonResponse();
    }
    throw error;
  }
}

async function invokeRouteHandler(handler: RouteHandler, req: Request, server: unknown, context: HttpRouteContext): Promise<Response> {
  return compressHttpResponse(req, await invokeRawRouteHandler(handler, req, server, context));
}

export function unhandledRouteErrorResponse(error: unknown): Response {
  if (error instanceof MalformedJsonError) return malformedJsonResponse();
  logger.error('Unhandled route error:', error as Error);
  return jsonError('Internal server error', 500);
}

// Wraps one route handler with URL parsing and JWT auth enforcement.
export function wrapRoute(
  handler: RouteHandler,
  routePath: string,
  method: string,
  authOptions: HttpRouteAuthOptions = {},
): WrappedRouteHandler {
  if (isAuthDisabled()) {
    return async (req: Request, server?: unknown): Promise<Response> => {
      if (authOptions.isShuttingDown?.()) return serverShuttingDownResponse();
      const mismatch = cliInstanceMismatch(req, authOptions.serverInstanceId);
      if (mismatch) return mismatch;
      return invokeRouteHandler(handler, req, server, { principal: LOCAL_SERVER_PRINCIPAL });
    };
  }

  if (isNoAuthHandler(handler)) {
    logger.debug(`Skipping auth wrapping for ${method} ${routePath}`);
    return async (req: Request, server?: unknown): Promise<Response> => {
      if (authOptions.isShuttingDown?.()) return serverShuttingDownResponse();
      return invokeRouteHandler(handler, req, server, { principal: null });
    };
  }

  return async (req: Request, server?: unknown): Promise<Response> => {
    if (authOptions.isShuttingDown?.()) return serverShuttingDownResponse();
    const { errorResponse, principal } = await authenticateHttpRequest(req, authOptions);
    if (authOptions.isShuttingDown?.()) return serverShuttingDownResponse();
    if (errorResponse) {
      if ((handler as MarkedRouteHandler)[noStoreRouteMarker]) errorResponse.headers.set('Cache-Control', 'no-store');
      return compressHttpResponse(req, errorResponse);
    }
    const mismatch = cliInstanceMismatch(req, authOptions.serverInstanceId);
    if (mismatch) return mismatch;
    return invokeRouteHandler(handler, req, server, { principal });
  };
}

// Wraps all routes in the route table with auth-aware wrappers.
export function wrapRoutes(
  rawRoutes: RouteMap,
  authOptions: HttpRouteAuthOptions = {},
): WrappedRouteMap {
  return Object.fromEntries(
    Object.entries(rawRoutes).map(([routePath, methods]) => [
      routePath,
      Object.fromEntries(
        Object.entries(methods).map(([method, handler]) => [
          method,
          wrapRoute(handler, routePath, method, authOptions),
        ])
      ),
    ])
  );
}
