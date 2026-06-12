// Flat-file auth persistence using auth.json in the config directory.
// Stores JWT secret, username, password hash, and creation timestamp.
// Always reads from disk before writing to avoid stale-cache issues.

import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { getConfigDir } from '../config.js';
import { writeJsonFileAtomic } from '../lib/json-file-store.ts';
import { createLogger } from '../lib/log.js';

const logger = createLogger('auth:store');

interface AuthData {
  jwtSecret?: unknown;
  username?: unknown;
  passwordHash?: unknown;
  createdAt?: unknown;
}

export interface AuthUser {
  username: string;
  passwordHash: string;
  createdAt: string | null;
}

export interface CreatedAuthUser {
  username: string;
  createdAt: string;
}

function authPath(): string {
  return path.join(getConfigDir(), 'auth.json');
}

const cachedJwtSecrets = new Map<string, string>();
const inflightJwtSecrets = new Map<string, Promise<string>>();

function hasNodeErrorCode(error: unknown, code: string): boolean {
  return Boolean(
    error
      && typeof error === 'object'
      && 'code' in error
      && (error as { code?: unknown }).code === code,
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Ensures the auth config directory exists.
export async function init(): Promise<void> {
  await fs.mkdir(getConfigDir(), { recursive: true });
  await getJwtSecret();
}

async function readFromDisk(filePath = authPath()): Promise<AuthData> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as AuthData;
    }
    return {};
  } catch (error) {
    if (hasNodeErrorCode(error, 'ENOENT')) return {};
    logger.warn('auth: invalid auth.json, treating as empty:', errorMessage(error));
    return {};
  }
}

async function writeToDisk(data: AuthData, filePath = authPath()): Promise<void> {
  await writeJsonFileAtomic(filePath, data, { mode: 0o600 });
}

async function ensureJwtSecret(filePath: string): Promise<string> {
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
export async function getJwtSecret(): Promise<string> {
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
export async function getUser(): Promise<AuthUser | null> {
  const data = await readFromDisk();
  if (typeof data.username !== 'string' || typeof data.passwordHash !== 'string') return null;
  return {
    username: data.username,
    passwordHash: data.passwordHash,
    createdAt: typeof data.createdAt === 'string' ? data.createdAt : null,
  };
}

// Returns the user by username, or null if credentials don't match.
export async function getUserByUsername(username: string): Promise<AuthUser | null> {
  const user = await getUser();
  if (!user || user.username !== username) return null;
  return user;
}

// Creates the single user. Throws if a user already exists.
export async function createUser(username: string, passwordHash: string): Promise<CreatedAuthUser> {
  const data = await readFromDisk();
  if (data.username && data.passwordHash) {
    throw new Error('Account already configured');
  }
  data.username = username;
  data.passwordHash = passwordHash;
  const createdAt = new Date().toISOString();
  data.createdAt = createdAt;
  await writeToDisk(data);
  return { username, createdAt };
}

// Returns true if no user account has been set up yet.
export async function needsSetup(): Promise<boolean> {
  const data = await readFromDisk();
  return !data.username || !data.passwordHash;
}
