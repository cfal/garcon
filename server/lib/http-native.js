import jwt from 'jsonwebtoken';
import { getJwtSecret } from '../auth/store.js';
import { getApiKey } from './api-key.js';

// Lazily resolved on first use and cached for the process lifetime.
let cachedSecret = null;

async function resolveSecret() {
  if (!cachedSecret) {
    cachedSecret = await getJwtSecret();
  }
  return cachedSecret;
}

// Thrown by parseJsonBody when the request body is syntactically invalid JSON.
// Consumers should check `instanceof` rather than matching the message string.
export class MalformedJsonError extends Error {
  constructor() {
    super('Malformed JSON');
    this.name = 'MalformedJsonError';
  }
}

export async function parseJsonBody(request) {
  const contentType = (request.headers.get('content-type') || '').toLowerCase();
  if (!contentType.includes('application/json')) {
    return {};
  }
  const text = await request.text();
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new MalformedJsonError();
  }
}

export function getTokenFromRequest(request) {
  const authHeader = request.headers.get('authorization');
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice('Bearer '.length);
  }
  return null;
}

// Verifies the JWT token or static API key. Single-user system so we only
// check token validity, not user lookup. Returns decoded payload as user.
export async function authenticateHttpRequest(request) {
  const token = getTokenFromRequest(request);
  if (!token) {
    return { user: null, errorResponse: Response.json({ error: 'Access denied. No token provided.' }, { status: 401 }) };
  }

  // Check static API key first (constant-time comparison).
  const apiKeyUser = getApiKey().verify(token);
  if (apiKeyUser) {
    return { user: apiKeyUser, errorResponse: null };
  }

  try {
    const secret = await resolveSecret();
    const decoded = jwt.verify(token, secret);
    return { user: { username: decoded.username }, errorResponse: null };
  } catch (error) {
    console.error('Token verification error:', error);
    return { user: null, errorResponse: Response.json({ error: 'Invalid token' }, { status: 403 }) };
  }
}
