// Flat-file auth persistence using auth.json in the config directory.
// Stores JWT secret, username, password hash, and creation timestamp.
// Always reads from disk before writing to avoid stale-cache issues.

import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { getConfigDir } from '../config.js';

function authPath() {
  return path.join(getConfigDir(), 'auth.json');
}

// Ensures the auth config directory exists.
export async function init() {
  await fs.mkdir(getConfigDir(), { recursive: true });
}

async function readFromDisk() {
  try {
    const raw = await fs.readFile(authPath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
    }
    return {};
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    console.warn('auth: invalid auth.json, treating as empty:', error.message);
    return {};
  }
}

async function writeToDisk(data) {
  const dir = getConfigDir();
  await fs.mkdir(dir, { recursive: true });
  const filePath = authPath();
  const tmp = filePath + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  await fs.rename(tmp, filePath);
}

// Returns the JWT secret, generating and persisting one if missing.
export async function getJwtSecret() {
  const data = await readFromDisk();
  if (typeof data.jwtSecret === 'string' && data.jwtSecret) {
    return data.jwtSecret;
  }
  const secret = crypto.randomBytes(32).toString('hex');
  data.jwtSecret = secret;
  await writeToDisk(data);
  return secret;
}

// Returns the user object or null if no user has been created.
export async function getUser() {
  const data = await readFromDisk();
  if (!data.username || !data.passwordHash) return null;
  return {
    username: data.username,
    passwordHash: data.passwordHash,
    createdAt: data.createdAt || null,
  };
}

// Returns the user by username, or null if credentials don't match.
export async function getUserByUsername(username) {
  const user = await getUser();
  if (!user || user.username !== username) return null;
  return user;
}

// Creates the single user. Throws if a user already exists.
export async function createUser(username, passwordHash) {
  const data = await readFromDisk();
  if (data.username && data.passwordHash) {
    throw new Error('Account already configured');
  }
  data.username = username;
  data.passwordHash = passwordHash;
  data.createdAt = new Date().toISOString();
  await writeToDisk(data);
  return { username: data.username, createdAt: data.createdAt };
}

// Returns true if no user account has been set up yet.
export async function needsSetup() {
  const data = await readFromDisk();
  return !data.username || !data.passwordHash;
}
