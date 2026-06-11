import { afterEach, describe, expect, it } from 'bun:test';
import { promises as fs } from 'fs';
import { readFileSync } from 'node:fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { JsonFileStore, writeJsonFileAtomic } from '../json-file-store.ts';

const createdDirs = [];

async function tempDir() {
  const dir = path.join(os.tmpdir(), `garcon-json-file-store-${randomUUID()}`);
  await fs.mkdir(dir, { recursive: true });
  createdDirs.push(dir);
  return dir;
}

describe('json file store', () => {
  afterEach(async () => {
    for (const dir of createdDirs.splice(0)) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('writes JSON atomically without leaving temp files', async () => {
    const dir = await tempDir();
    const filePath = path.join(dir, 'settings.json');

    await writeJsonFileAtomic(filePath, { ok: true });

    expect(JSON.parse(await fs.readFile(filePath, 'utf8'))).toEqual({ ok: true });
    expect(await fs.readdir(dir)).toEqual(['settings.json']);
  });

  it('normalizes parsed values and supplies empty state for missing files', async () => {
    const dir = await tempDir();
    const filePath = path.join(dir, 'ledger.json');
    const store = new JsonFileStore({
      filePath,
      empty: () => ({ version: 1, records: [] }),
      normalize: (value) => {
        const record = value && typeof value === 'object' ? value : {};
        return {
          version: 1,
          records: Array.isArray(record.records) ? record.records : [],
        };
      },
    });

    await expect(store.read()).resolves.toEqual({ version: 1, records: [] });
    await fs.writeFile(filePath, JSON.stringify({ records: [{ id: 'a' }] }), 'utf8');
    await expect(store.read()).resolves.toEqual({ version: 1, records: [{ id: 'a' }] });
  });

  it('keeps JSON persistence modules on the shared atomic writer', () => {
    for (const file of [
      'server/auth/store.ts',
      'server/chats/store.ts',
      'server/settings/store.ts',
      'server/chats/share-store.ts',
      'server/chats/metadata-store.ts',
      'server/api-providers/store.ts',
    ]) {
      const source = readFileSync(file, 'utf8');
      expect(source).toContain('writeJsonFileAtomic');
      expect(source).not.toMatch(/fs\.writeFile\([^)]*JSON\.stringify/s);
    }
  });
});
