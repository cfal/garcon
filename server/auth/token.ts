import jwt from 'jsonwebtoken';
import { type AuthUser, type CreatedAuthUser, getJwtSecret } from './store.js';
import { getJwtTokenExpiry } from '../config.js';
import { createLogger } from '../lib/log.js';
import { errorMessage } from '../lib/errors.js';

const logger = createLogger('auth:token');

type TokenUser = Pick<AuthUser | CreatedAuthUser, 'username'>;

export async function generateAuthToken({ username }: TokenUser): Promise<string> {
  const secret = await getJwtSecret();
  return jwt.sign(
    { username },
    secret,
    { expiresIn: getJwtTokenExpiry() },
  );
}

export async function verifyAuthToken(token: string | null | undefined): Promise<boolean> {
  if (!token) {
    return false;
  }

  try {
    const secret = await getJwtSecret();
    jwt.verify(token, secret);
    return true;
  } catch (error) {
    logger.warn('Auth token verification failed:', errorMessage(error));
    return false;
  }
}
