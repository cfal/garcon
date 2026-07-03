import jwt from 'jsonwebtoken';
import { type AuthUser, type CreatedAuthUser, getJwtSecret } from './store.js';
import { getJwtTokenExpiry } from '../config.js';
import { createLogger } from '../lib/log.js';
import { errorMessage } from '../lib/errors.js';

const logger = createLogger('auth:token');

type TokenUser = Pick<AuthUser | CreatedAuthUser, 'username'>;
export interface AuthTokenClaims {
  username: string;
}

function parseClaims(value: unknown): AuthTokenClaims | null {
  if (!value || typeof value !== 'object') return null;
  const username = (value as Record<string, unknown>).username;
  return typeof username === 'string' && username.trim()
    ? { username: username.trim() }
    : null;
}

export async function generateAuthToken({ username }: TokenUser): Promise<string> {
  const secret = await getJwtSecret();
  return jwt.sign(
    { username },
    secret,
    { expiresIn: getJwtTokenExpiry() },
  );
}

export async function verifyAuthToken(token: string | null | undefined): Promise<boolean> {
  return Boolean(await getAuthTokenClaims(token));
}

export async function getAuthTokenClaims(token: string | null | undefined): Promise<AuthTokenClaims | null> {
  if (!token) {
    return null;
  }

  try {
    const secret = await getJwtSecret();
    return parseClaims(jwt.verify(token, secret));
  } catch (error) {
    logger.warn('Auth token verification failed:', errorMessage(error));
    return null;
  }
}
