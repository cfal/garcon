import { verifyAuthTokenClaims } from '../auth/token.js';
import { jsonError } from './http-error.js';
import type { ServerPrincipal } from './http-route-types.js';

// Thrown by parseJsonBody when the request body is syntactically invalid JSON.
// Consumers should check `instanceof` rather than matching the message string.
export class MalformedJsonError extends Error {
  constructor() {
    super('Malformed JSON');
    this.name = 'MalformedJsonError';
  }
}

export async function parseJsonBody(request: Request): Promise<unknown> {
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

export function getTokenFromRequest(request: Request): string | null {
  const authHeader = request.headers.get('authorization');
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice('Bearer '.length);
  }
  return null;
}

// Verifies JWT token presence/validity for protected HTTP routes.
export async function authenticateHttpRequest(request: Request): Promise<{
  errorResponse: Response | null;
  principal: ServerPrincipal | null;
}> {
  const token = getTokenFromRequest(request);
  if (!token) {
    return { errorResponse: jsonError('Access denied. No token provided.', 401), principal: null };
  }

  const claims = await verifyAuthTokenClaims(token);
  if (!claims) {
    return { errorResponse: jsonError('Invalid token', 401), principal: null };
  }

  return {
    errorResponse: null,
    principal: {
      mode: 'authenticated',
      key: claims.username,
      username: claims.username,
      expiresAtMs: claims.expiresAtMs,
    },
  };
}
