import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readJsonlLineEntries } from '../history-loader-utils.ts';

let tempDir = null;

afterEach(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = null;
});

describe('readJsonlLineEntries', () => {
  it('rejects oversized records before accumulating the full line', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'garcon-jsonl-reader-'));
    const filePath = path.join(tempDir, 'large.jsonl');
    await writeFile(filePath, `${'x'.repeat(128 * 1024)}\n`);

    const read = async () => {
      for await (const _entry of readJsonlLineEntries(filePath, { maxLineBytes: 64 * 1024 })) {
        // The oversized record never yields.
      }
    };

    await expect(read()).rejects.toThrow('JSONL record exceeds 65536 bytes');
  });
});
