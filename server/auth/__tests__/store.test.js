import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import { createUser, getUserByUsername, init, listUsers } from '../store.js';

describe('auth store users', () => {
  const originalConfigDir = process.env.GARCON_CONFIG_DIR;
  let tempDir;

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-auth-users-'));
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

  it('creates multiple users and resolves usernames case-insensitively', async () => {
    await createUser('alice', 'hash-a');
    await createUser('Bob', 'hash-b');

    expect((await listUsers()).map((user) => user.username)).toEqual(['alice', 'Bob']);
    expect((await getUserByUsername('ALICE'))?.passwordHash).toBe('hash-a');
    await expect(createUser('bob', 'hash-c')).rejects.toThrow('Account already exists');
  });
});
