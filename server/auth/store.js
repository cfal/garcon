// Flat-file auth persistence using auth.json in the config directory.
// Stores JWT secret, username, password hash, and creation timestamp.
// Always reads from disk before writing to avoid stale-cache issues.

import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { getConfigDir } from '../config.js';
import { writeJsonFileAtomic } from '../lib/json-file-store.ts';

function authPath() {
  return path.join(getConfigDir(), 'auth.json');
}

const cachedJwtSecrets = new Map();
const inflightJwtSecrets = new Map();

// Ensures the auth config directory exists.
export async function init() {
  await fs.mkdir(getConfigDir(), { recursive: true });
  await getJwtSecret();
}

async function readFromDisk(filePath = authPath()) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
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

async function writeToDisk(data, filePath = authPath()) {
  await writeJsonFileAtomic(filePath, data, { mode: 0o600 });
}

async function ensureJwtSecret(filePath) {
  const data = await readFromDisk(filePath);
  if (typeof data.jwtSecret === 'string' && data.jwtSecret) {
    return data.jwtSecret;
  }
  const secret = crypto.randomBytes(32).toString('hex');
  data.jwtSecret = secret;
  await writeToDisk(data, filePath);
  return secret;
}

// Returns the JWT secret owned by auth store initialization.
export async function getJwtSecret() {
  const filePath = authPath();
  const cachedJwtSecret = cachedJwtSecrets.get(filePath);
  if (cachedJwtSecret) {
    return cachedJwtSecret;
  }
  const inflightJwtSecret = inflightJwtSecrets.get(filePath);
  if (inflightJwtSecret) {
    return inflightJwtSecret;
  }

  const secretPromise = ensureJwtSecret(filePath)
    .then((secret) => {
      cachedJwtSecrets.set(filePath, secret);
      return secret;
    })
    .finally(() => {
      inflightJwtSecrets.delete(filePath);
    });

  inflightJwtSecrets.set(filePath, secretPromise);
  return secretPromise;
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
