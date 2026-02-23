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

export async function generateToken(user) {
  const secret = await resolveSecret();
  return jwt.sign(
    { username: user.username },
    secret,
    { expiresIn: getJwtTokenExpiry() },
  );
}

export async function authenticateWebSocket(token) {
  if (!token) {
    return null;
  }

  try {
    const secret = await resolveSecret();
    return jwt.verify(token, secret);
  } catch (error) {
    console.error('WebSocket token verification error:', error);
    return null;
  }
}
