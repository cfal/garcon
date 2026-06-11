import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import { getJwtSecret, init } from '../store.js';
import { generateAuthToken, verifyAuthToken } from '../token.js';

describe('auth tokens', () => {
  const originalConfigDir = process.env.GARCON_CONFIG_DIR;
  let tempDir;
  let authFilePath;

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-auth-'));
    authFilePath = path.join(tempDir, 'auth.json');
    process.env.GARCON_CONFIG_DIR = tempDir;
    await init();
  });

  afterAll(async () => {
    if (originalConfigDir === undefined) {
      delete process.env.GARCON_CONFIG_DIR;
    } else {
      process.env.GARCON_CONFIG_DIR = originalConfigDir;
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('primes and reuses the store-owned JWT secret', async () => {
    const stored = JSON.parse(await fs.readFile(authFilePath, 'utf8'));
    const secret = await getJwtSecret();

    expect(stored.jwtSecret).toBe(secret);

    await fs.writeFile(authFilePath, JSON.stringify({ ...stored, jwtSecret: 'changed-on-disk' }));

    expect(await getJwtSecret()).toBe(secret);
  });

  it('signs and verifies tokens with the store secret', async () => {
    const token = await generateAuthToken({ username: 'test-user' });

    expect(await verifyAuthToken(token)).toBe(true);
  });
});
