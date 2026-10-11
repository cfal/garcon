import jwt from 'jsonwebtoken';
import { parseAuthTokenIdentity } from '../../../common/auth.js';
import { getAuthStore, type AuthSnapshot } from './store.js';
import { getJwtTokenExpiry } from '../config.js';
import type { ServerPrincipal } from '../lib/http-route-types.js';
import { isRecord } from '../../../common/json.js';

export interface VerifiedAuthClaims {
  readonly ownerKey: string;
  readonly credentialRevision: number;
  readonly username: string;
  readonly expiresAtMs: number;
}

export function signAuthSnapshot(snapshot: AuthSnapshot): string {
  if (!snapshot.account) throw new Error('Account is not configured');
  return jwt.sign({ sub: snapshot.account.ownerKey, credentialRevision: snapshot.account.credentialRevision },
    snapshot.jwtSecret, { algorithm: 'HS256', expiresIn: getJwtTokenExpiry() });
}

export async function verifyAuthTokenClaims(token: string | null | undefined): Promise<VerifiedAuthClaims | null> {
  const store = getAuthStore();
  store.assertHealthy();
  if (!token) return null;
  const snapshot = await store.snapshot();
  store.assertHealthy();
  if (!snapshot.account) return null;
  try {
    const decoded = jwt.verify(token, snapshot.jwtSecret, { algorithms: ['HS256'] });
    const identity = parseAuthTokenIdentity(decoded);
    if (!identity || !isRecord(decoded) || typeof decoded.exp !== 'number'
      || !Number.isFinite(decoded.exp * 1000) || decoded.exp * 1000 <= Date.now()
      || !store.isCurrent(identity.ownerKey, identity.credentialRevision)) return null;
    return { ...identity, username: snapshot.account.username, expiresAtMs: decoded.exp * 1000 };
  } catch { return null; }
}

export async function verifyAuthToken(token: string | null | undefined): Promise<boolean> {
  return (await verifyAuthTokenClaims(token)) !== null;
}

export function isCurrentBrowserPrincipal(principal: ServerPrincipal): boolean {
  return principal.mode !== 'authenticated' || principal.expiresAtMs > Date.now()
    && getAuthStore().isCurrent(principal.key, principal.credentialRevision);
}
