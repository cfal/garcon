import jwt from 'jsonwebtoken';
import { getJwtSecret } from './store.js';
import { getJwtTokenExpiry } from '../config.js';

export async function generateAuthToken({ username }) {
  const secret = await getJwtSecret();
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
    const secret = await getJwtSecret();
    jwt.verify(token, secret);
    return true;
  } catch (error) {
    console.warn('Auth token verification failed:', error.message);
    return false;
  }
}
