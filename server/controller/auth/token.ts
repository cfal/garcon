import jwt from 'jsonwebtoken';
import { randomBytes } from 'node:crypto';
import { parseAuthTokenIdentity } from '../../../common/auth.js';
import { getAuthStore, type AuthSnapshot } from './store.js';
import { getJwtTokenExpiry } from '../config.js';
import type { ServerPrincipal } from '../lib/http-route-types.js';
import { isRecord } from '../../../common/json.js';
import type { AuthBrowserSession } from './sessions.js';

export interface VerifiedAuthClaims {
  readonly ownerKey: string;
  readonly credentialRevision: number;
  readonly sessionId: string;
  readonly username: string;
  readonly expiresAtMs: number;
}

export function signAuthSnapshot(snapshot: AuthSnapshot, session: AuthBrowserSession): string {
  if (!snapshot.account) throw new Error('Account is not configured');
  return jwt.sign({ sub: snapshot.account.ownerKey, credentialRevision: snapshot.account.credentialRevision,
    sid: session.sessionId, exp: session.expiresAtMs / 1000 }, snapshot.jwtSecret, { algorithm: 'HS256' });
}

export function prepareAuthSession(snapshot: AuthSnapshot): { session: AuthBrowserSession; token: string } {
  if (!snapshot.account) throw new Error('Account is not configured');
  const sessionId = randomBytes(32).toString('hex');
  const token = jwt.sign({ sub: snapshot.account.ownerKey, credentialRevision: snapshot.account.credentialRevision,
    sid: sessionId }, snapshot.jwtSecret, { algorithm: 'HS256', expiresIn: getJwtTokenExpiry() });
  const decoded = jwt.verify(token, snapshot.jwtSecret, { algorithms: ['HS256'] });
  if (!isRecord(decoded) || typeof decoded.exp !== 'number' || !Number.isSafeInteger(decoded.exp * 1000)
    || decoded.exp * 1000 <= Date.now()) throw new Error('Invalid browser session expiry');
  return { session: { sessionId, ownerKey: snapshot.account.ownerKey, expiresAtMs: decoded.exp * 1000 }, token };
}

async function verifySignedClaims(token: string | null | undefined, options: { ignoreExpiration: boolean }): Promise<VerifiedAuthClaims | null> {
  const store = getAuthStore();
  store.assertHealthy();
  if (!token) return null;
  const snapshot = await store.snapshot();
  store.assertHealthy();
  if (!snapshot.account) return null;
  try {
    const decoded = jwt.verify(token, snapshot.jwtSecret, { algorithms: ['HS256'], ...options });
    const identity = parseAuthTokenIdentity(decoded);
    if (!identity || !isRecord(decoded) || typeof decoded.exp !== 'number'
      || !Number.isSafeInteger(decoded.exp * 1000) || decoded.exp <= 0) return null;
    return { ...identity, username: snapshot.account.username, expiresAtMs: decoded.exp * 1000 };
  } catch { return null; }
}

export async function verifyAuthTokenClaims(token: string | null | undefined): Promise<VerifiedAuthClaims | null> {
  const claims = await verifySignedClaims(token, { ignoreExpiration: false });
  const store = getAuthStore();
  store.assertHealthy();
  if (!claims || !store.isCurrent(claims.ownerKey, claims.credentialRevision)
    || !store.isSessionCurrent(claims.ownerKey, claims.sessionId, claims.expiresAtMs)) return null;
  return claims;
}

// Stale or expired signed tokens may only revoke their own session, never authorize work.
export async function verifyLogoutToken(token: string | null | undefined): Promise<VerifiedAuthClaims | null> {
  const claims = await verifySignedClaims(token, { ignoreExpiration: true });
  getAuthStore().assertHealthy();
  return claims;
}

export async function verifyAuthToken(token: string | null | undefined): Promise<boolean> {
  return (await verifyAuthTokenClaims(token)) !== null;
}

export function isCurrentBrowserPrincipal(principal: ServerPrincipal): boolean {
  if (principal.mode !== 'authenticated') return true;
  const store = getAuthStore();
  return store.isCurrent(principal.key, principal.credentialRevision)
    && store.isSessionCurrent(principal.key, principal.sessionId, principal.expiresAtMs);
}
