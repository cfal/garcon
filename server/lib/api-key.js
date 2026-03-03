import crypto from 'crypto';
import { getApiKey as getApiKeyConfig } from '../config.js';

// Cached singleton so the env var is read once.
let instance = null;

// Returns an object with a verify(token) method.
// verify() returns a user object if the token matches the configured API key,
// or null otherwise. Uses constant-time comparison to prevent timing attacks.
export function getApiKey() {
  if (!instance) {
    const key = getApiKeyConfig();
    instance = {
      verify(token) {
        if (!key || !token) return null;
        const a = Buffer.from(key);
        const b = Buffer.from(token);
        if (a.length !== b.length) return null;
        if (!crypto.timingSafeEqual(a, b)) return null;
        return { username: 'api-key' };
      },
    };
  }
  return instance;
}
