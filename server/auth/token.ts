import jwt from 'jsonwebtoken';
import { type AuthUser, type CreatedAuthUser, getJwtSecret } from './store.js';
import { getJwtTokenExpiry } from '../config.js';
import { createLogger } from '../lib/log.js';
import { errorMessage } from '../lib/errors.js';

const logger = createLogger('auth:token');

type TokenUser = Pick<AuthUser | CreatedAuthUser, 'username'>;

export interface VerifiedAuthClaims {
  username: string;
  expiresAtMs: number;
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
  return (await verifyAuthTokenClaims(token)) !== null;
}

export async function verifyAuthTokenClaims(
  token: string | null | undefined,
): Promise<VerifiedAuthClaims | null> {
  if (!token) {
    return null;
  }

  try {
    const secret = await getJwtSecret();
    const decoded = jwt.verify(token, secret);
    const claims = decoded !== null && typeof decoded === 'object'
      ? decoded as Record<string, unknown>
      : null;
    if (
      !claims
      || typeof claims.username !== 'string'
      || claims.username.length === 0
      || typeof claims.exp !== 'number'
    ) {
      return null;
    }
    return {
      username: claims.username,
      expiresAtMs: claims.exp * 1000,
    };
  } catch (error) {
    logger.warn('Auth token verification failed:', errorMessage(error));
    return null;
  }
}
