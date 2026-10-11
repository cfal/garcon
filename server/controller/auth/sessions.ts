import { isRecord } from '../../../common/json.js';
import { isAuthSessionId } from '../../../common/auth.js';

export const AUTH_SESSION_LIMIT = 256;

export interface AuthBrowserSession {
  readonly sessionId: string;
  readonly ownerKey: string;
  readonly expiresAtMs: number;
}

export function parseStoredSessions(value: unknown): readonly AuthBrowserSession[] {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.sessions)
    || Object.keys(value).some(key => key !== 'version' && key !== 'sessions')
    || value.sessions.length > AUTH_SESSION_LIMIT) throw new Error('Invalid auth session registry');
  const ids = new Set<string>();
  return Object.freeze(value.sessions.map(raw => {
    if (!isRecord(raw) || Object.keys(raw).some(key => !['sessionId', 'ownerKey', 'expiresAtMs'].includes(key))
      || !isAuthSessionId(raw.sessionId) || typeof raw.ownerKey !== 'string' || !raw.ownerKey
      || typeof raw.expiresAtMs !== 'number' || !Number.isSafeInteger(raw.expiresAtMs) || raw.expiresAtMs <= 0
      || ids.has(raw.sessionId)) throw new Error('Invalid auth session');
    ids.add(raw.sessionId);
    return Object.freeze({ sessionId: raw.sessionId, ownerKey: raw.ownerKey, expiresAtMs: raw.expiresAtMs });
  }));
}
