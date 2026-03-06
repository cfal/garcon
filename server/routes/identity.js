import { needsSetup, getUserByUsername, createUser, getUser } from '../auth/store.js';
import { generateToken } from '../middleware/auth.js';
import { parseJsonBody } from '../lib/http-native.js';
import { createRateLimiter } from '../lib/rate-limit.js';
import { markRouteNoAuth } from '../lib/route-auth.js';
import { isAuthDisabled } from '../config.js';

const loginLimiter = createRateLimiter({ windowMs: 60_000, maxRequests: 10 });

async function noauthGetStatus() {
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
    console.error('Auth status error:', error);
    return Response.json({ error: 'Internal server error' }, { status: 500 });
  }
}

async function noauthPostRegister(request) {
  try {
    if (isAuthDisabled()) {
      return Response.json({ error: 'Authentication is disabled by server configuration' }, { status: 403 });
    }
    const { username, password } = await parseJsonBody(request);

    if (!username || !password) {
      return Response.json({ error: 'Both username and password are required' }, { status: 400 });
    }
    const trimmedUsername = username.trim();
    if (trimmedUsername.length < 1) {
      return Response.json({ error: 'Username is required' }, { status: 400 });
    }
    if (trimmedUsername.length > 64) {
      return Response.json({ error: 'Username must be 64 characters or fewer' }, { status: 400 });
    }
    if (password.length < 8) {
      return Response.json({ error: 'Password must be at least 8 characters' }, { status: 400 });
    }
    if (password.length > 128) {
      return Response.json({ error: 'Password must be 128 characters or fewer' }, { status: 400 });
    }

    const setupNeeded = await needsSetup();
    if (!setupNeeded) {
      return Response.json({ error: 'Account already configured' }, { status: 403 });
    }

    const passwordHash = await Bun.password.hash(password, { algorithm: 'bcrypt', cost: 12 });
    const user = await createUser(trimmedUsername, passwordHash);
    const token = await generateToken(user);

    return Response.json({
      success: true,
      user: { id: user.username, username: user.username },
      token,
    });
  } catch (error) {
    if (error.message === 'Malformed JSON') {
      return Response.json({ error: 'Malformed JSON' }, { status: 400 });
    }
    console.error('Registration error:', error);
    return Response.json({ error: 'Internal server error' }, { status: 500 });
  }
}

async function noauthPostLogin(request) {
  const limited = loginLimiter.check(request);
  if (limited) return limited;

  try {
    if (isAuthDisabled()) {
      return Response.json({ error: 'Authentication is disabled by server configuration' }, { status: 403 });
    }
    const { username, password } = await parseJsonBody(request);
    if (!username || !password) {
      return Response.json({ error: 'Both username and password are required' }, { status: 400 });
    }

    const user = await getUserByUsername(username);
    if (!user) {
      return Response.json({ error: 'Invalid username or password' }, { status: 401 });
    }

    const isValidPassword = await Bun.password.verify(password, user.passwordHash);
    if (!isValidPassword) {
      return Response.json({ error: 'Invalid username or password' }, { status: 401 });
    }

    const token = await generateToken(user);
    return Response.json({
      success: true,
      user: { id: user.username, username: user.username },
      token,
    });
  } catch (error) {
    if (error.message === 'Malformed JSON') {
      return Response.json({ error: 'Malformed JSON' }, { status: 400 });
    }
    console.error('Login error:', error);
    return Response.json({ error: 'Internal server error' }, { status: 500 });
  }
}

async function getAuthUser() {
  if (isAuthDisabled()) {
    return Response.json({ user: { id: 'local', username: 'local' } });
  }

  const user = await getUser();
  if (!user) {
    return Response.json({ error: 'No user found' }, { status: 404 });
  }
  return Response.json({ user: { id: user.username, username: user.username } });
}

// No-op: JWTs are stateless so there's no server-side session to invalidate.
// Add a token blocklist here if revocation is ever needed.
async function postLogout() {
  return Response.json({ success: true, message: 'Logged out successfully' });
}

export default {
  '/api/v1/auth/status': { GET: markRouteNoAuth(noauthGetStatus) },
  '/api/v1/auth/register': { POST: markRouteNoAuth(noauthPostRegister) },
  '/api/v1/auth/login': { POST: markRouteNoAuth(noauthPostLogin) },
  '/api/v1/auth/user': { GET: getAuthUser },
  '/api/v1/auth/logout': { POST: postLogout },
};
