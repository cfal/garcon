import { verifyAuthToken } from '../auth/token.js';

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

  const isAuthorized = await verifyAuthToken(token);
  if (!isAuthorized) {
    return { errorResponse: Response.json({ error: 'Invalid token' }, { status: 403 }) };
  }

  return { errorResponse: null };
}
