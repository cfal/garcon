import crypto from 'crypto';
import { verifyAuthTokenClaims } from '../auth/token.js';
import { jsonError } from '../../common/http-error.js';
import type { ServerPrincipal } from './http-route-types.js';

import { getTokenFromRequest } from '../../common/http-body.js';

// Verifies JWT token presence/validity for protected HTTP routes.
export async function authenticateHttpRequest(
  request: Request,
  options: { localCapability?: string } = {},
): Promise<{
  errorResponse: Response | null;
  principal: ServerPrincipal | null;
}> {
  const token = getTokenFromRequest(request);
  if (!token) {
    return { errorResponse: jsonError('Access denied. No token provided.', 401), principal: null };
  }

  const tokenBytes = Buffer.from(token);
  const localCapabilityBytes = options.localCapability
    ? Buffer.from(options.localCapability)
    : null;
  if (
    localCapabilityBytes
    && tokenBytes.length === localCapabilityBytes.length
    && crypto.timingSafeEqual(tokenBytes, localCapabilityBytes)
  ) {
    return {
      errorResponse: null,
      principal: {
        mode: 'local',
        key: 'local',
        username: 'local',
        expiresAtMs: null,
      },
    };
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
