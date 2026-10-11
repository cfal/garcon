import crypto from 'crypto';
import { verifyAuthTokenClaims } from '../auth/token.js';
import { getAuthStore } from '../auth/store.js';
import { jsonError, jsonErrorFromUnknown } from '../../common/http-error.js';
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
  const tokenBytes = Buffer.from(token ?? '');
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

  let claims;
  try { getAuthStore().assertHealthy(); claims = await verifyAuthTokenClaims(token); }
  catch (error) { return { errorResponse: jsonErrorFromUnknown(error), principal: null }; }
  if (!claims) {
    return { errorResponse: jsonError('Invalid token', 401, 'AUTH_SESSION_INVALID'), principal: null };
  }

  return {
    errorResponse: null,
    principal: {
      mode: 'authenticated',
      key: claims.ownerKey,
      credentialRevision: claims.credentialRevision,
      sessionId: claims.sessionId,
      username: claims.username,
      expiresAtMs: claims.expiresAtMs,
    },
  };
}
