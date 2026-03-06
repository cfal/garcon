import jwt from 'jsonwebtoken';
import { getJwtSecret } from '../auth/store.js';
import { getJwtTokenExpiry } from '../config.js';

// Lazily resolved on first use and cached for the process lifetime.
let cachedSecret = null;

async function resolveSecret() {
  if (!cachedSecret) {
    cachedSecret = await getJwtSecret();
  }
  return cachedSecret;
}

export async function generateAuthToken({ username }) {
  const secret = await resolveSecret();
  return jwt.sign(
    { username },
    secret,
    { expiresIn: getJwtTokenExpiry() },
  );
}

export async function verifyWebSocketToken(token) {
  if (!token) {
    return false;
  }

  try {
    const secret = await resolveSecret();
    jwt.verify(token, secret);
    return true;
  } catch (error) {
    console.warn('WebSocket token verification failed:', error.message);
    return false;
  }
}
