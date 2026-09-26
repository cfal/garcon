import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readDirectoryCandidates, readFileDirectory } from '../directory-reader.js';

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'directory-reader-'));
  await fs.mkdir(path.join(root, 'folder'));
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

for (const read of [readFileDirectory, readDirectoryCandidates]) {
  test.each(['ENOENT', 'ENOTDIR', 'ELOOP', 'EACCES', 'EPERM', 'ENOTCONN', 'ESTALE', 'EBUSY'])(`${read.name} skips expected per-entry failures: %s`, async (code) => {
    const stat = spyOn(fs, 'stat').mockRejectedValue(Object.assign(new Error('Entry unavailable'), { code }));
    try { expect(await read(root, root)).toEqual([]); }
    finally { stat.mockRestore(); }
  });

  test.each(['EIO', 'EMFILE'])(`${read.name} propagates unexpected per-entry failures: %s`, async (code) => {
    await fs.writeFile(path.join(root, 'healthy.txt'), 'synthetic');
    const failure = Object.assign(new Error('Filesystem failure'), { code });
    const original = fs.stat;
    const stat = spyOn(fs, 'stat').mockImplementation(async (...args) => {
      if (args[0] === path.join(root, 'folder')) throw failure;
      return original(...args);
    });
    try { await expect(read(root, root)).rejects.toBe(failure); }
    finally { stat.mockRestore(); }
  });

  test(`${read.name} preserves cancellation even when the entry becomes inaccessible`, async () => {
    const cancelled = new AbortController();
    const stat = spyOn(fs, 'stat').mockImplementation(async () => {
      cancelled.abort();
      throw Object.assign(new Error('Entry unavailable'), { code: 'ENOENT' });
    });
    try {
      const result = await read(root, root, cancelled.signal).catch((error: unknown) => error);
      expect(result).toBe(cancelled.signal.reason);
    }
    finally { stat.mockRestore(); }
  });
}

test('tree metadata uses at most sixteen concurrent reads and retains every ordered result', async () => {
  for (let i = 0; i < 31; i++) await fs.writeFile(path.join(root, `file-${i}.txt`), 'synthetic');
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const original = fs.stat;
  let active = 0;
  let peak = 0;
  let calls = 0;
  const stat = spyOn(fs, 'stat').mockImplementation(async (...args) => {
    active++;
    calls++;
    peak = Math.max(peak, active);
    if (active === 16) entered.resolve();
    try { await release.promise; return await original(...args); }
    finally { active--; }
  });
  const reading = readFileDirectory(root, root);
  try {
    await entered.promise;
    expect(calls).toBe(16);
    release.resolve();
    const entries = await reading;
    expect(entries).toHaveLength(32);
    expect(entries[0]!.name).toBe('folder');
    const names = entries.slice(1).map(({ name }) => name);
    expect(names).toEqual([...names].sort((left, right) => left.localeCompare(right)));
    expect(peak).toBe(16);
    expect(active).toBe(0);
  } finally {
    release.resolve();
    await reading.catch(() => undefined);
    stat.mockRestore();
  }
});
