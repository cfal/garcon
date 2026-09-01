import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resetServerConfigForTests } from '../../config.ts';
import { CorruptStateFileError, QUARANTINE_INFIX } from '../../lib/json-file-store.ts';
import { init, needsSetup } from '../store.ts';

describe('auth store', () => {
  const originalConfigDir = process.env.GARCON_CONFIG_DIR;
  let configDir;

  beforeEach(async () => {
    configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-auth-store-'));
    process.env.GARCON_CONFIG_DIR = configDir;
    resetServerConfigForTests();
  });

  afterEach(async () => {
    if (originalConfigDir === undefined) delete process.env.GARCON_CONFIG_DIR;
    else process.env.GARCON_CONFIG_DIR = originalConfigDir;
    resetServerConfigForTests();
    await fs.rm(configDir, { recursive: true, force: true });
  });

  it('quarantines corrupt auth state and keeps registration closed', async () => {
    const filePath = path.join(configDir, 'auth.json');
    const corruptBytes = '{"jwtSecret":"secret","username":"owner"';
    await fs.writeFile(filePath, corruptBytes, { mode: 0o600 });

    await expect(init()).rejects.toBeInstanceOf(CorruptStateFileError);
    const [quarantineName] = (await fs.readdir(configDir)).filter((entry) =>
      entry.startsWith(`auth.json${QUARANTINE_INFIX}`));
    expect(await fs.readFile(path.join(configDir, quarantineName), 'utf8')).toBe(corruptBytes);
    await expect(fs.stat(filePath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(needsSetup()).rejects.toBeInstanceOf(CorruptStateFileError);
  });
});
