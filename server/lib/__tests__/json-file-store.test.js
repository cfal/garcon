import { afterEach, describe, expect, it } from 'bun:test';
import { promises as fs } from 'fs';
import { readFileSync } from 'node:fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import {
  CorruptStateFileError,
  JsonFileStore,
  QUARANTINE_INFIX,
  readJsonStateFile,
  writeJsonFileAtomic,
} from '../json-file-store.ts';

const createdDirs = [];

async function tempDir() {
  const dir = path.join(os.tmpdir(), `garcon-json-file-store-${randomUUID()}`);
  await fs.mkdir(dir, { recursive: true });
  createdDirs.push(dir);
  return dir;
}

function atomicWriterSource() {
  const source = readFileSync('server/lib/json-file-store.ts', 'utf8');
  const start = source.indexOf('export async function writeJsonFileAtomic');
  const end = source.indexOf('export async function syncDirectory');
  return source.slice(start, end);
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

  it('syncs the temp file before the atomic rename', () => {
    const source = atomicWriterSource();
    expect(source).toContain('await file.sync()');
    expect(source.indexOf('await file.sync()')).toBeLessThan(source.indexOf('await fs.rename(tempPath'));
  });

  it('syncs the parent directory after the atomic rename', () => {
    const source = atomicWriterSource();
    expect(source).toContain('await syncDirectory(dir)');
    expect(source.indexOf('await fs.rename(tempPath')).toBeLessThan(source.lastIndexOf('await syncDirectory(dir)'));
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

  it('quarantines malformed state without losing its bytes or mode', async () => {
    const dir = await tempDir();
    const filePath = path.join(dir, 'auth.json');
    const corruptBytes = '{"jwtSecret":"secret"';
    await fs.writeFile(filePath, corruptBytes, { mode: 0o600 });

    const read = () => readJsonStateFile({
      filePath,
      empty: () => ({}),
      normalize: (value) => value,
    });
    await expect(read()).rejects.toBeInstanceOf(CorruptStateFileError);

    const [quarantineName] = (await fs.readdir(dir)).filter((entry) =>
      entry.startsWith(`auth.json${QUARANTINE_INFIX}`));
    const quarantinePath = path.join(dir, quarantineName);
    expect(await fs.readFile(quarantinePath, 'utf8')).toBe(corruptBytes);
    expect((await fs.stat(quarantinePath)).mode & 0o777).toBe(0o600);
    await expect(fs.stat(filePath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(read()).rejects.toMatchObject({ quarantinePath });
  });

  it('returns empty state only when no canonical file or quarantine exists', async () => {
    const dir = await tempDir();
    const filePath = path.join(dir, 'state.json');

    await expect(readJsonStateFile({
      filePath,
      empty: () => ({ fresh: true }),
      normalize: (value) => value,
    })).resolves.toEqual({ fresh: true });

    await fs.writeFile(filePath, '{"records":["a"]}');
    await expect(readJsonStateFile({
      filePath,
      empty: () => ({ records: [] }),
      normalize: (value) => ({ records: Array.isArray(value.records) ? value.records : [] }),
    })).resolves.toEqual({ records: ['a'] });
    expect(await fs.readdir(dir)).toEqual(['state.json']);
  });

  it('does not quarantine state after non-ENOENT read failures', async () => {
    const dir = await tempDir();
    const filePath = path.join(dir, 'state.json');
    await fs.mkdir(filePath);

    await expect(readJsonStateFile({
      filePath,
      empty: () => ({}),
      normalize: (value) => value,
    })).rejects.toMatchObject({ code: 'EISDIR' });
    expect(await fs.readdir(dir)).toEqual(['state.json']);
  });

  it('rejects concurrent reads without creating duplicate quarantines', async () => {
    const dir = await tempDir();
    const filePath = path.join(dir, 'state.json');
    await fs.writeFile(filePath, '{');
    const read = () => readJsonStateFile({
      filePath,
      empty: () => ({}),
      normalize: (value) => value,
    });

    const results = await Promise.allSettled([read(), read()]);

    expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected']);
    const quarantines = (await fs.readdir(dir)).filter((entry) =>
      entry.startsWith(`state.json${QUARANTINE_INFIX}`));
    expect(quarantines).toHaveLength(1);
    const [quarantineName] = quarantines;
    const quarantinePath = path.join(dir, quarantineName);
    expect(results.map((result) => result.reason.quarantinePath)).toEqual([
      quarantinePath,
      quarantinePath,
    ]);
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
