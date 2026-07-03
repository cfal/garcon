// Flat-file auth persistence using auth.json in the config directory.
// Stores JWT secret plus a username-keyed account map.
// Always reads from disk before writing to avoid stale-cache issues.

import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { getConfigDir } from '../config.js';
import { writeJsonFileAtomic } from '../lib/json-file-store.ts';
import { createLogger } from '../lib/log.js';
import { errorMessage, hasNodeErrorCode } from '../lib/errors.js';

const logger = createLogger('auth:store');

interface AuthData {
  jwtSecret?: unknown;
  username?: unknown;
  passwordHash?: unknown;
  createdAt?: unknown;
  users?: unknown;
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

interface PersistedAuthUser {
  username?: unknown;
  passwordHash?: unknown;
  createdAt?: unknown;
}

function authPath(): string {
  return path.join(getConfigDir(), 'auth.json');
}

const cachedJwtSecrets = new Map<string, string>();
const inflightJwtSecrets = new Map<string, Promise<string>>();

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

function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

function normalizePersistedUser(value: unknown, fallbackUsername: string): AuthUser | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as PersistedAuthUser;
  if (typeof raw.passwordHash !== 'string') return null;
  return {
    username: typeof raw.username === 'string' && raw.username.trim()
      ? raw.username.trim()
      : fallbackUsername,
    passwordHash: raw.passwordHash,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : null,
  };
}

function usersFromData(data: AuthData): Map<string, AuthUser> {
  const users = new Map<string, AuthUser>();

  if (data.users && typeof data.users === 'object' && !Array.isArray(data.users)) {
    for (const [key, value] of Object.entries(data.users as Record<string, unknown>)) {
      const user = normalizePersistedUser(value, key);
      if (user) users.set(normalizeUsername(user.username), user);
    }
  }

  if (typeof data.username === 'string' && typeof data.passwordHash === 'string') {
    const username = data.username.trim();
    if (username) {
      users.set(normalizeUsername(username), {
        username,
        passwordHash: data.passwordHash,
        createdAt: typeof data.createdAt === 'string' ? data.createdAt : null,
      });
    }
  }

  return users;
}

function writeUsersToData(data: AuthData, users: Map<string, AuthUser>): AuthData {
  return {
    ...data,
    users: Object.fromEntries(
      Array.from(users.entries()).map(([key, user]) => [
        key,
        {
          username: user.username,
          passwordHash: user.passwordHash,
          createdAt: user.createdAt,
        },
      ]),
    ),
  };
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
  const users = usersFromData(await readFromDisk());
  return users.values().next().value ?? null;
}

export async function listUsers(): Promise<AuthUser[]> {
  return Array.from(usersFromData(await readFromDisk()).values());
}

// Returns the user by username, or null if credentials don't match.
export async function getUserByUsername(username: string): Promise<AuthUser | null> {
  return usersFromData(await readFromDisk()).get(normalizeUsername(username)) ?? null;
}

// Creates a user account. Usernames are unique case-insensitively.
export async function createUser(username: string, passwordHash: string): Promise<CreatedAuthUser> {
  const data = await readFromDisk();
  const users = usersFromData(data);
  const trimmedUsername = username.trim();
  const key = normalizeUsername(trimmedUsername);
  if (users.has(key)) {
    throw new Error('Account already exists');
  }
  const createdAt = new Date().toISOString();
  users.set(key, { username: trimmedUsername, passwordHash, createdAt });
  await writeToDisk(writeUsersToData(data, users));
  return { username: trimmedUsername, createdAt };
}

// Returns true if no user account has been set up yet.
export async function needsSetup(): Promise<boolean> {
  return usersFromData(await readFromDisk()).size === 0;
}
