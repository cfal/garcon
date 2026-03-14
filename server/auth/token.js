import jwt from 'jsonwebtoken';
import { getJwtSecret } from './store.js';
import { getJwtTokenExpiry } from '../config.js';

// Shares one lazily initialized JWT secret cache across all auth flows.
let cachedSecret = null;

async function getCachedSecret() {
  if (!cachedSecret) {
    cachedSecret = await getJwtSecret();
  }
  return cachedSecret;
}

export async function generateAuthToken({ username }) {
  const secret = await getCachedSecret();
  return jwt.sign(
    { username },
    secret,
    { expiresIn: getJwtTokenExpiry() },
  );
}

export async function verifyAuthToken(token) {
  if (!token) {
    return false;
  }

  try {
    const secret = await getCachedSecret();
    jwt.verify(token, secret);
    return true;
  } catch (error) {
    console.warn('Auth token verification failed:', error.message);
    return false;
  }
}
