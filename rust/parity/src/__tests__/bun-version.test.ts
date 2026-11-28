import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { bunCheck, PIN, pinnedBunVersion } from '../bun-version.js';

const repoRoot = resolve(import.meta.dir, '../../../..');

describe('the Bun the repository pins', () => {
  test('is read from the parity workflow each time, since the pin can move', async () => {
    const pinned = await pinnedBunVersion(repoRoot);
    expect(pinned).toMatch(/^\d+\.\d+\.\d+$/);
    expect(await readFile(join(repoRoot, PIN), 'utf8')).toContain(`bun-version: ${pinned}`);
  });

  test('lets a record and a replay run on it without a word', () => {
    expect(bunCheck('record', '1.4.3', '1.4.3', false)).toEqual({ refuse: false, warning: null });
    expect(bunCheck('replay', '1.4.3', '1.4.3', true)).toEqual({ refuse: false, warning: null });
  });

  test('stops a record on another Bun, unless --any-bun is given, and only warns for a replay', () => {
    const refused = bunCheck('record', '1.4.5', '1.4.3', false);
    expect(refused).toEqual({
      refuse: true,
      warning: 'Bun 1.4.5 runs this command, and the repository pins 1.4.3 for recordings (.github/workflows/rust-parity.yml): the original behaves differently on other versions. Start it with Bun 1.4.3, or pass --any-bun to record anyway.',
    });
    // The recording goes ahead, and says which Bun it describes.
    const override = bunCheck('record', '1.4.5', '1.4.3', true);
    expect(override.refuse).toBe(false);
    expect(override.warning).toContain('A recording made now describes Bun 1.4.5.');
    // A replay on either side compares two runs made on one Bun, so it goes ahead with a warning.
    for (const running of ['1.4.5', '1.4.2']) {
      const replay = bunCheck('replay', running, '1.4.3', false);
      expect(replay.refuse).toBe(false);
      expect(replay.warning).toContain(`A replay made now compares builds on Bun ${running}.`);
    }
  });

  test('fails when there is no workflow or it pins no Bun', async () => {
    const root = await mkdtemp(join(tmpdir(), 'garcon-pin-'));
    try {
      await expect(pinnedBunVersion(root)).rejects.toMatchObject({ code: 'ENOENT' });
      await mkdir(join(root, dirname(PIN)), { recursive: true });
      await writeFile(join(root, PIN), 'jobs:\n  rust-parity:\n    runs-on: ubuntu-latest\n');
      await expect(pinnedBunVersion(root)).rejects.toThrow(`${PIN} pins no Bun version: it needs a \`bun-version\` line.`);
      // Quoted or not, the pin is read.
      await writeFile(join(root, PIN), '        with:\n          bun-version: "1.5.0"\n');
      expect(await pinnedBunVersion(root)).toBe('1.5.0');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
