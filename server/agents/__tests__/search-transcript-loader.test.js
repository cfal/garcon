import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { probeDetachedSearchSource } from '../search-transcript-loader.js';

let tempDir = null;

afterEach(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = null;
});

describe('detached transcript source probes', () => {
  it('detects a same-size rewrite even when mtime is restored', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'garcon-search-probe-'));
    const nativePath = path.join(tempDir, 'transcript.jsonl');
    const source = { kind: 'direct-jsonl', nativePath };
    await writeFile(nativePath, 'alpha');
    const originalStat = await stat(nativePath);
    const before = await probeDetachedSearchSource(source);
    await Bun.sleep(2);
    await writeFile(nativePath, 'bravo');
    await utimes(nativePath, originalStat.atime, originalStat.mtime);

    const after = await probeDetachedSearchSource(source);

    expect(after).not.toBe(before);
  });
});
