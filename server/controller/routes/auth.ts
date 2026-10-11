import { AuthValidationError, type AuthUserResponse, type AuthStatusResponse } from '../../../common/auth.js';
import { getAuthStore, needsSetup } from '../auth/store.js';
import { getAuthService } from '../auth/service.js';
import { readAuthBody } from '../auth/http.js';
import { createRateLimiter, type RequestIpServer } from '../lib/rate-limit.js';
import { markRouteNoAuth, markRouteNoStore } from '../lib/http-route.js';
import { isAuthDisabled } from '../config.js';
import type { RouteHandler, RouteMap } from '../lib/http-route-types.js';
import { DomainError } from '../../common/domain-error.js';
import { jsonError, jsonErrorFromUnknown } from '../../common/http-error.js';

const loginLimiter = createRateLimiter({ windowMs: 60_000, maxRequests: 10 });
const registerLimiter = createRateLimiter({ windowMs: 60_000, maxRequests: 10 });
const credentialLimiter = createRateLimiter({ windowMs: 60_000, maxRequests: 10 });

function authRoute(handler: RouteHandler): RouteHandler {
  return markRouteNoStore(async (...args) => {
    let response: Response;
    try { response = await handler(...args); }
    catch (error) {
      response = error instanceof AuthValidationError
        ? jsonError(error.message, 400, 'AUTH_VALIDATION_FAILED', false)
        : jsonErrorFromUnknown(error);
    }
    response.headers.set('Cache-Control', 'no-store');
    if (response.status === 429) response.headers.set('Retry-After', '5');
    return response;
  });
}

function requireEnabled(): void {
  if (isAuthDisabled()) throw new DomainError('AUTH_CHANGE_FORBIDDEN', 'Authentication is disabled by server configuration', 403);
}

function ipServer(server: unknown): RequestIpServer | null {
  return server && typeof server === 'object' ? server as RequestIpServer : null;
}

const status = authRoute(async () => {
  const store = getAuthStore();
  store.assertHealthy();
  const authDisabled = isAuthDisabled();
  const setupRequired = authDisabled ? false : await needsSetup();
  store.assertHealthy();
  return Response.json({ needsSetup: setupRequired, isAuthenticated: authDisabled,
    authDisabled } satisfies AuthStatusResponse);
});

const register = authRoute(async (request, _url, server) => {
  requireEnabled();
  const limited = registerLimiter.check(request, ipServer(server));
  if (limited) return limited;
  return Response.json(await getAuthService().register(await readAuthBody(request), request.signal));
});

const login = authRoute(async (request, _url, server) => {
  requireEnabled();
  const limited = loginLimiter.check(request, ipServer(server));
  if (limited) return limited;
  return Response.json(await getAuthService().login(await readAuthBody(request), request.signal));
});

function credentialRoute(operation: 'username' | 'password'): RouteHandler {
  return authRoute(async (request, _url, server, context) => {
    requireEnabled();
    if (context?.principal?.mode !== 'authenticated') {
      throw new DomainError('AUTH_CHANGE_FORBIDDEN', 'Sign in to change credentials.', 403);
    }
    const limited = credentialLimiter.check(request, ipServer(server));
    if (limited) return jsonError('Too many credential changes. Try again shortly.', 429, 'AUTH_BUSY', false);
    const service = getAuthService();
    const result = operation === 'username'
      ? await service.changeUsername(context.principal, () => readAuthBody(request), request.signal)
      : await service.changePassword(context.principal, () => readAuthBody(request), request.signal);
    return Response.json(result);
  });
}

const user = authRoute(async (_request, _url, _server, context) => {
  if (isAuthDisabled()) return Response.json({ user: { id: 'local', username: 'local' } } satisfies AuthUserResponse);
  const store = getAuthStore();
  const account = (await store.snapshot()).account;
  store.assertHealthy();
  const principal = context?.principal;
  if (
    !account ||
    (principal?.mode === 'authenticated' &&
      (!store.isCurrent(principal.key, principal.credentialRevision) || principal.expiresAtMs <= Date.now()))
  ) {
    throw new DomainError('AUTH_SESSION_INVALID', 'Sign in again.', 401);
  }
  return Response.json({ user: { id: account.ownerKey, username: account.username } } satisfies AuthUserResponse);
});

const routes: RouteMap = {
  '/api/v1/auth/status': { GET: markRouteNoAuth(status) },
  '/api/v1/auth/register': { POST: markRouteNoAuth(register) },
  '/api/v1/auth/login': { POST: markRouteNoAuth(login) },
  '/api/v1/auth/user': { GET: user },
  '/api/v1/auth/username': { PATCH: credentialRoute('username') },
  '/api/v1/auth/password': { PATCH: credentialRoute('password') },
  '/api/v1/auth/logout': { POST: authRoute(() => Response.json({ success: true })) },
};

export default routes;
