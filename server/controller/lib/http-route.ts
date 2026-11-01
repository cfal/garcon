import { authenticateHttpRequest, authenticatedWithLocalCapability } from './http-request.js';
import { MalformedJsonError, parseJsonBody } from '../../common/http-body.js';
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
import { trackActivity } from '../../common/event-loop-stalls.js';
import { CLI_SERVER_INSTANCE_HEADER } from '@garcon/common/server-runtime';
import { stripBasePath } from '@garcon/common/base-path';
import { CLI_CONTRACT_HEADER, CLI_OPERATIONS, type CliOperation } from '@garcon/common/cli-contracts';
import { cliRequestContract, cliRoute } from '../../remote/transport/cli-protocol.js';
import type { JsonValue } from '@garcon/common/json';
import { DomainError } from '../../common/domain-error.js';
import type { CliRouteContracts } from './cli-contracts.js';

const logger = createLogger('lib:http-route');

const noAuthRouteMarker: unique symbol = Symbol('no-auth-route');
const noStoreRouteMarker: unique symbol = Symbol('no-store-route');
const responseHeadersRouteMarker: unique symbol = Symbol('response-headers-route');
const bodyReaderRouteMarker: unique symbol = Symbol('body-reader-route');

interface RouteBodyReader {
  read(request: Request): Promise<unknown>;
  errorResponse(error: unknown): Response;
}

type MarkedRouteHandler = RouteHandler & {
  [noAuthRouteMarker]?: true;
  [noStoreRouteMarker]?: true;
  [responseHeadersRouteMarker]?: Readonly<Record<string, string>>;
  [bodyReaderRouteMarker]?: RouteBodyReader;
};
type WrappedRouteHandler = (request: Request, server?: unknown) => Promise<Response>;
type WrappedRouteMap = Record<string, Record<string, WrappedRouteHandler>>;

export interface HttpRouteAuthOptions {
  basePath?: string;
  localCapability?: string;
  serverInstanceId?: string;
  isShuttingDown?: () => boolean;
  cliContracts: CliRouteContracts;
}

export function cliInstanceMismatch(request: Request, expected: string | undefined): Response | null {
  const supplied = request.headers.get(CLI_SERVER_INSTANCE_HEADER);
  return supplied !== null && supplied !== expected
    ? jsonError('Garcon restarted; start a new CLI invocation', 409, 'CLI_CONTROLLER_CHANGED', false)
    : null;
}

function cliRouteSelection(request: Request, route: string, method: string, localCapability: boolean,
  handler: RouteHandler, contracts: CliRouteContracts): Response | RouteHandler {
  if (method === 'GET' && (route === '/api/v1/runtime' || route === '/api/v1/cli/context')) return handler;
  const hasHeader = request.headers.has(CLI_CONTRACT_HEADER) || request.headers.has(CLI_SERVER_INSTANCE_HEADER);
  const operation = `${method} ${route}`;
  if (!Object.hasOwn(CLI_OPERATIONS, operation)) {
    return hasHeader ? jsonError('This route is outside the CLI contract', 403, 'CLI_ACCESS_DENIED', false) : handler;
  }
  if (!hasHeader && !localCapability) return handler;
  try {
    const ref = cliRequestContract(request.headers, operation as CliOperation);
    const registered = contracts.resolve(operation, ref);
    return async (req, url, server, context) => {
      const copy = req.clone();
      const bodyReader = (registered.dispatch as MarkedRouteHandler)[bodyReaderRouteMarker];
      try {
        const route = cliRoute(method, url.pathname);
        let body: JsonValue | null = null;
        if (bodyReader) body = await bodyReader.read(copy) as JsonValue;
        else if (copy.body !== null) body = await parseJsonBody(copy) as JsonValue;
        registered.validateRequest({ ...route, query: [...url.searchParams], body });
      } catch (error) {
        // Both tee branches must retire to cancel an unfinished upload.
        void copy.body?.cancel().catch(() => {});
        void req.body?.cancel().catch(() => {});
        if (bodyReader) return bodyReader.errorResponse(error);
        if (error instanceof DomainError) return jsonError(error.message, error.status, error.code, error.retryable);
        throw error;
      }
      return registered.dispatch(req, url, server, context);
    };
  }
  catch (error) {
    if (error instanceof DomainError) return jsonError(error.message, error.status, error.code, error.retryable);
    throw error;
  }
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

export function markRouteBodyReader<T extends RouteHandler>(handler: T, reader: RouteBodyReader): T {
  Object.defineProperty(handler, bodyReaderRouteMarker, { value: reader });
  return handler;
}

// Marks a route whose every response carries these headers, including shutdown and
// unhandled-error responses produced outside the handler.
export function markRouteResponseHeaders<T extends RouteHandler>(
  handler: T,
  headers: Readonly<Record<string, string>>,
): T {
  Object.defineProperty(handler, responseHeadersRouteMarker, { value: headers });
  return handler;
}

export async function invokeRawRouteHandler(
  handler: RouteHandler,
  req: Request,
  server: unknown,
  context: HttpRouteContext,
  basePath = '',
): Promise<Response> {
  const url = new URL(req.url);
  const pathname = stripBasePath(url.pathname, basePath);
  if (pathname === null) return new Response('Not found', { status: 404 });
  url.pathname = pathname;
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

// The activity names the route pattern, never the URL, which can carry share tokens.
async function invokeRouteHandler(
  handler: RouteHandler,
  req: Request,
  server: unknown,
  context: HttpRouteContext,
  activity: string,
  basePath: string,
): Promise<Response> {
  const finish = trackActivity(activity);
  try {
    return compressHttpResponse(req, await invokeRawRouteHandler(handler, req, server, context, basePath));
  } finally {
    finish();
  }
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
  authOptions: HttpRouteAuthOptions,
): WrappedRouteHandler {
  const wrapped = wrapRouteAuth(handler, routePath, method, authOptions);
  const headers = (handler as MarkedRouteHandler)[responseHeadersRouteMarker];
  if (!headers) return wrapped;
  return async (req: Request, server?: unknown): Promise<Response> => {
    let response: Response;
    try {
      response = await wrapped(req, server);
    } catch (error) {
      response = unhandledRouteErrorResponse(error);
    }
    for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
    return response;
  };
}

function wrapRouteAuth(
  handler: RouteHandler,
  routePath: string,
  method: string,
  authOptions: HttpRouteAuthOptions,
): WrappedRouteHandler {
  const activity = `${method} ${routePath}`;
  function dispatch(
    req: Request,
    server: unknown,
    principal: HttpRouteContext['principal'],
    localCapability: boolean,
  ): Response | Promise<Response> {
    const selected = cliRouteSelection(req, routePath, method, localCapability, handler, authOptions.cliContracts);
    if (selected instanceof Response) return selected;
    return invokeRouteHandler(selected, req, server, {
      principal,
      cliContracts: authOptions.cliContracts.catalog,
    }, activity, authOptions.basePath ?? '');
  }

  if (isAuthDisabled()) {
    return async (req: Request, server?: unknown): Promise<Response> => {
      if (authOptions.isShuttingDown?.()) return serverShuttingDownResponse();
      const mismatch = cliInstanceMismatch(req, authOptions.serverInstanceId);
      if (mismatch) return mismatch;
      return dispatch(req, server, LOCAL_SERVER_PRINCIPAL, authenticatedWithLocalCapability(req, authOptions.localCapability));
    };
  }

  if (isNoAuthHandler(handler)) {
    logger.debug(`Skipping auth wrapping for ${method} ${routePath}`);
    return async (req: Request, server?: unknown): Promise<Response> => {
      if (authOptions.isShuttingDown?.()) return serverShuttingDownResponse();
      return dispatch(req, server, null, false);
    };
  }

  return async (req: Request, server?: unknown): Promise<Response> => {
    if (authOptions.isShuttingDown?.()) return serverShuttingDownResponse();
    const { errorResponse, principal, localCapability } = await authenticateHttpRequest(req, authOptions);
    if (authOptions.isShuttingDown?.()) return serverShuttingDownResponse();
    if (errorResponse) {
      if ((handler as MarkedRouteHandler)[noStoreRouteMarker]) errorResponse.headers.set('Cache-Control', 'no-store');
      return compressHttpResponse(req, errorResponse);
    }
    const mismatch = cliInstanceMismatch(req, authOptions.serverInstanceId);
    if (mismatch) return mismatch;
    return dispatch(req, server, principal, localCapability);
  };
}

// Wraps all routes in the route table with auth-aware wrappers.
export function wrapRoutes(
  rawRoutes: RouteMap,
  authOptions: HttpRouteAuthOptions,
): WrappedRouteMap {
  const basePath = authOptions.basePath ?? '';
  const mountedRoutes: WrappedRouteMap = Object.fromEntries(
    Object.entries(rawRoutes).map(([routePath, methods]) => {
      const wrappedMethods = Object.fromEntries(
        Object.entries(methods).map(([method, handler]) => [
          method,
          wrapRoute(handler, routePath, method, authOptions),
        ]),
      );
      return [`${basePath}${routePath}`, wrappedMethods];
    }),
  );
  if (basePath) {
    mountedRoutes[basePath] = {
      GET: async request => {
        if (authOptions.isShuttingDown?.()) return serverShuttingDownResponse();
        return new Response(null, {
          status: 308,
          headers: { Location: `${basePath}/${new URL(request.url).search}` },
        });
      },
    };
  }
  return mountedRoutes;
}
