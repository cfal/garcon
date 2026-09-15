import { afterEach, describe, expect, it } from 'bun:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BUNDLED_PREAMBLES } from '../bundled.ts';
import { initializePreambleService } from '../setup.ts';

const createdDirectories = [];

async function temporaryDirectory() {
  const directory = path.join(os.tmpdir(), `garcon-preamble-setup-${randomUUID()}`);
  await fs.mkdir(directory, { recursive: true });
  createdDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  for (const directory of createdDirectories.splice(0)) {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

describe('preamble setup', () => {
  it('installs bundled preambles into a fresh workspace and leaves them unchanged on restart', async () => {
    const directory = await temporaryDirectory();
    const service = await initializePreambleService(directory);
    const snapshot = service.snapshot();

    expect(snapshot.revision).toBe(1);
    expect(snapshot.preambles.map(({ id, title, enabled }) => ({ id, title, enabled }))).toEqual(
      BUNDLED_PREAMBLES.map(({ id, title }) => ({ id, title, enabled: false })),
    );
    expect(snapshot.preambles.every((entry) => entry.createdAt === entry.updatedAt)).toBe(true);
    const firstFile = await fs.readFile(path.join(directory, 'preambles.json'), 'utf8');

    const reopened = await initializePreambleService(directory);
    expect(reopened.snapshot()).toEqual(snapshot);
    expect(await fs.readFile(path.join(directory, 'preambles.json'), 'utf8')).toBe(firstFile);
  });
});
