import jwt from 'jsonwebtoken';
import { getJwtSecret } from '../auth/store.js';

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

// Verifies JWT token presence/validity for protected HTTP routes.
export async function authenticateHttpRequest(request) {
  const token = getTokenFromRequest(request);
  if (!token) {
    return { errorResponse: Response.json({ error: 'Access denied. No token provided.' }, { status: 401 }) };
  }

  try {
    const secret = await resolveSecret();
    jwt.verify(token, secret);
    return { errorResponse: null };
  } catch (error) {
    console.error('Token verification error:', error);
    return { errorResponse: Response.json({ error: 'Invalid token' }, { status: 403 }) };
  }
}
