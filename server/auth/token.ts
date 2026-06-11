import jwt from 'jsonwebtoken';
import { type AuthUser, type CreatedAuthUser, getJwtSecret } from './store.js';
import { getJwtTokenExpiry } from '../config.js';

type TokenUser = Pick<AuthUser | CreatedAuthUser, 'username'>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
  if (!token) {
    return false;
  }

  try {
    const secret = await getJwtSecret();
    jwt.verify(token, secret);
    return true;
  } catch (error) {
    console.warn('Auth token verification failed:', errorMessage(error));
    return false;
  }
}
