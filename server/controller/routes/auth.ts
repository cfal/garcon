import {
  AuthAccountAlreadyConfiguredError,
  needsSetup,
  getUserByUsername,
  createUser,
  getUser,
} from '../auth/store.js';
import { generateAuthToken } from '../auth/token.js';
import { createRateLimiter, type RequestIpServer } from '../lib/rate-limit.js';
import { markRouteNoAuth } from '../lib/http-route.js';
import { withJsonBody } from '../lib/json-route.js';
import { isAuthDisabled } from '../config.js';
import type { RouteMap } from '../lib/http-route-types.js';
import { asJsonBody, type JsonBody } from './route-helpers.js';
import { createLogger } from '../../common/log.js';
import { jsonError } from '../../common/http-error.js';

const logger = createLogger('routes:auth');

const loginLimiter = createRateLimiter({ windowMs: 60_000, maxRequests: 10 });
const registerLimiter = createRateLimiter({ windowMs: 60_000, maxRequests: 10 });

async function noauthGetStatus(): Promise<Response> {
  try {
    const authDisabled = isAuthDisabled();
    if (authDisabled) {
      return Response.json({
        needsSetup: false,
        isAuthenticated: true,
        authDisabled: true,
      });
    }
    const setupNeeded = await needsSetup();
    return Response.json({
      needsSetup: setupNeeded,
      isAuthenticated: false,
      authDisabled: false,
    });
  } catch (error) {
    logger.error('Auth status error:', error);
    return jsonError('Internal server error', 500);
  }
}

async function noauthPostRegister(body: JsonBody): Promise<Response> {
  try {
    if (isAuthDisabled()) {
      return jsonError('Authentication is disabled by server configuration', 403);
    }
    const input = asJsonBody(body);
    const username = typeof input.username === 'string' ? input.username : '';
    const password = typeof input.password === 'string' ? input.password : '';

    if (!username || !password) {
      return jsonError('Both username and password are required', 400);
    }
    const trimmedUsername = username.trim();
    if (trimmedUsername.length < 1) {
      return jsonError('Username is required', 400);
    }
    if (trimmedUsername.length > 64) {
      return jsonError('Username must be 64 characters or fewer', 400);
    }
    if (password.length < 8) {
      return jsonError('Password must be at least 8 characters', 400);
    }
    if (password.length > 128) {
      return jsonError('Password must be 128 characters or fewer', 400);
    }

    const setupNeeded = await needsSetup();
    if (!setupNeeded) {
      return jsonError('Account already configured', 409);
    }

    const passwordHash = await Bun.password.hash(password, { algorithm: 'bcrypt', cost: 12 });
    const user = await createUser(trimmedUsername, passwordHash);
    const token = await generateAuthToken(user);

    return Response.json({
      success: true,
      user: { id: user.username, username: user.username },
      token,
    });
  } catch (error) {
    if (error instanceof AuthAccountAlreadyConfiguredError) {
      return jsonError(error.message, 409);
    }
    logger.error('Registration error:', error);
    return jsonError('Internal server error', 500);
  }
}

async function noauthPostLogin(body: JsonBody): Promise<Response> {
  try {
    if (isAuthDisabled()) {
      return jsonError('Authentication is disabled by server configuration', 403);
    }
    const input = asJsonBody(body);
    const username = typeof input.username === 'string' ? input.username : '';
    const password = typeof input.password === 'string' ? input.password : '';
    if (!username || !password) {
      return jsonError('Both username and password are required', 400);
    }

    const user = await getUserByUsername(username);
    if (!user) {
      return jsonError('Invalid username or password', 401);
    }

    const isValidPassword = await Bun.password.verify(password, user.passwordHash);
    if (!isValidPassword) {
      return jsonError('Invalid username or password', 401);
    }

    const token = await generateAuthToken(user);
    return Response.json({
      success: true,
      user: { id: user.username, username: user.username },
      token,
    });
  } catch (error) {
    logger.error('Login error:', error);
    return jsonError('Internal server error', 500);
  }
}

const noauthPostLoginWithBody = withJsonBody(noauthPostLogin);
const noauthPostRegisterWithBody = withJsonBody(noauthPostRegister);

function asRequestIpServer(server: unknown): RequestIpServer | null {
  return server && typeof server === 'object' ? server as RequestIpServer : null;
}

async function noauthPostLoginRateLimited(request: Request, url: URL, server?: unknown): Promise<Response> {
  const limited = loginLimiter.check(request, asRequestIpServer(server));
  if (limited) return limited;
  return noauthPostLoginWithBody(request, url, server);
}

async function noauthPostRegisterRateLimited(request: Request, url: URL, server?: unknown): Promise<Response> {
  const limited = registerLimiter.check(request, asRequestIpServer(server));
  if (limited) return limited;
  return noauthPostRegisterWithBody(request, url, server);
}

async function getAuthUser(): Promise<Response> {
  if (isAuthDisabled()) {
    return Response.json({ user: { id: 'local', username: 'local' } });
  }

  const user = await getUser();
  if (!user) {
    return jsonError('No user found', 404);
  }
  return Response.json({ user: { id: user.username, username: user.username } });
}

// No-op: JWTs are stateless so there's no server-side session to invalidate.
// Add a token blocklist here if revocation is ever needed.
async function postLogout(): Promise<Response> {
  return Response.json({ success: true, message: 'Logged out successfully' });
}

const routes: RouteMap = {
  '/api/v1/auth/status': { GET: markRouteNoAuth(noauthGetStatus) },
  '/api/v1/auth/register': { POST: markRouteNoAuth(noauthPostRegisterRateLimited) },
  '/api/v1/auth/login': { POST: markRouteNoAuth(noauthPostLoginRateLimited) },
  '/api/v1/auth/user': { GET: getAuthUser },
  '/api/v1/auth/logout': { POST: postLogout },
};

export default routes;
