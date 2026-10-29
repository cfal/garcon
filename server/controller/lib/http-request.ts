import crypto from 'crypto';
import { verifyAuthTokenClaims } from '../auth/token.js';
import { getAuthStore } from '../auth/store.js';
import { jsonError, jsonErrorFromUnknown } from '../../common/http-error.js';
import type { ServerPrincipal } from './http-route-types.js';

import { getTokenFromRequest } from '../../common/http-body.js';

export function authenticatedWithLocalCapability(request: Request, capability: string | undefined): boolean {
  const token = Buffer.from(getTokenFromRequest(request) ?? '');
  const expected = capability ? Buffer.from(capability) : null;
  return expected !== null && token.length === expected.length && crypto.timingSafeEqual(token, expected);
}

// Verifies JWT token presence/validity for protected HTTP routes.
export async function authenticateHttpRequest(
  request: Request,
  options: { localCapability?: string } = {},
): Promise<{
  errorResponse: Response | null;
  principal: ServerPrincipal | null;
  localCapability: boolean;
}> {
  const token = getTokenFromRequest(request);
  if (authenticatedWithLocalCapability(request, options.localCapability)) {
    return {
      localCapability: true,
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
  catch (error) { return { errorResponse: jsonErrorFromUnknown(error), principal: null, localCapability: false }; }
  if (!claims) {
    return { errorResponse: jsonError('Invalid token', 401, 'AUTH_SESSION_INVALID'), principal: null, localCapability: false };
  }

  return {
    localCapability: false,
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
