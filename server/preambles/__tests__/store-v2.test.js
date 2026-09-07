import { afterEach, describe, expect, it, mock } from 'bun:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  PREAMBLE_ID_LIFETIME_MAX_COUNT,
  PREAMBLES_FILE_MAX_BYTES,
} from '../../../common/preambles.js';
import { PreambleCatalogCommittedUnknownError, PreambleStore } from '../store.ts';

const createdDirectories = [];
const AT = '2026-09-03T10:00:00.000Z';
const ID_A = '3502b645-222b-49d2-ac39-1c91f9fb1174';
const ID_B = '80becfa6-c9c7-4b31-9190-fd23c0bedf9c';
const ID_C = '936903ad-8b98-43eb-a7d4-c17ce0dc18d8';

async function temporaryDirectory() {
  const directory = path.join(os.tmpdir(), `garcon-preambles-${randomUUID()}`);
  await fs.mkdir(directory, { recursive: true });
  createdDirectories.push(directory);
  return directory;
}

function preamble(id, overrides = {}) {
  return {
    id,
    enabled: true,
    title: `Preamble ${id}`,
    content: `Body ${id}`,
    scope: { type: 'global' },
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

afterEach(async () => {
  for (const directory of createdDirectories.splice(0)) {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

async function writeCatalog(directory, file) {
  await fs.writeFile(path.join(directory, 'preambles.json'), JSON.stringify(file, null, 2));
}

async function readCatalog(directory) {
  return JSON.parse(await fs.readFile(path.join(directory, 'preambles.json'), 'utf8'));
}

describe('PreambleStore version two', () => {
  it('migrates a valid version-one catalog at initialization', async () => {
    const directory = await temporaryDirectory();
    await writeCatalog(directory, {
      version: 1,
      revision: 7,
      preambles: [preamble(ID_A)],
    });

    const store = new PreambleStore(directory);
    await store.init();

    expect(await readCatalog(directory)).toEqual({
      version: 2,
      revision: 7,
      preambles: [preamble(ID_A)],
      retiredPreambleIds: [],
    });
    const reopened = new PreambleStore(directory);
    await reopened.init();
    expect(reopened.snapshot()).toEqual(store.snapshot());
  });

  it('fails visibly on an invalid legacy ID instead of rewriting it', async () => {
    const directory = await temporaryDirectory();
    await writeCatalog(directory, {
      version: 1,
      revision: 1,
      preambles: [preamble('legacy-id')],
    });
    await expect(new PreambleStore(directory).init()).rejects.toThrow();
    expect(await readCatalog(directory)).toMatchObject({ version: 1 });
  });

  it('moves a deleted ID into tombstones atomically and preserves it across restart', async () => {
    const directory = await temporaryDirectory();
    const store = new PreambleStore(directory);
    await store.init();
    await store.create(preamble(ID_A), 0);
    await store.create(preamble(ID_B), 1);

    await store.remove(ID_A, 2);

    expect(store.snapshot().preambles.map((entry) => entry.id)).toEqual([ID_B]);
    expect(await readCatalog(directory)).toMatchObject({
      version: 2,
      revision: 3,
      retiredPreambleIds: [ID_A],
    });

    const reopened = new PreambleStore(directory);
    await reopened.init();
    expect(reopened.snapshot().preambles.map((entry) => entry.id)).toEqual([ID_B]);

    // A later catalog creation can never acquire the retired identity.
    await expect(reopened.create(preamble(ID_A), 3)).rejects.toMatchObject({
      code: 'PREAMBLE_ID_COLLISION',
    });
    await reopened.create(preamble(ID_C), 3);
    expect((await readCatalog(directory)).preambles.map((entry) => entry.id))
      .toEqual([ID_B, ID_C]);
    expect(await readCatalog(directory)).toMatchObject({
      retiredPreambleIds: [ID_A],
    });
  });

  it('rejects persisted duplicate, malformed, or overlapping tombstones', async () => {
    const cases = [
      { preambles: [], retiredPreambleIds: [ID_A, ID_A] },
      { preambles: [], retiredPreambleIds: [ID_A, 'not-a-uuid'] },
      { preambles: [preamble(ID_A)], retiredPreambleIds: [ID_A] },
    ];
    for (const file of cases) {
      const directory = await temporaryDirectory();
      await writeCatalog(directory, { version: 2, revision: 1, ...file });
      await expect(new PreambleStore(directory).init()).rejects.toThrow();
    }
  });

  it('rejects generated collisions against active and retired IDs without looping', async () => {
    const directory = await temporaryDirectory();
    const store = new PreambleStore(directory);
    await store.init();
    await store.create(preamble(ID_A), 0);
    await store.create(preamble(ID_B), 1);
    await store.remove(ID_B, 2);

    await expect(store.create(preamble(ID_A), 3)).rejects.toMatchObject({
      code: 'PREAMBLE_ID_COLLISION',
    });
    await expect(store.create(preamble(ID_B), 3)).rejects.toMatchObject({
      code: 'PREAMBLE_ID_COLLISION',
    });
    expect(store.snapshot()).toMatchObject({ revision: 3 });
  });

  it('rejects malformed records at the public store creation boundary', async () => {
    const directory = await temporaryDirectory();
    const store = new PreambleStore(directory);
    await store.init();

    await expect(store.create(preamble('not-a-uuid'), 0)).rejects.toMatchObject({
      code: 'PREAMBLE_VALIDATION_FAILED',
    });
    await expect(store.create(preamble(ID_A, { content: '   ' }), 0)).rejects.toMatchObject({
      code: 'PREAMBLE_VALIDATION_FAILED',
    });

    expect(store.snapshot()).toEqual({ revision: 0, preambles: [] });
  });

  it('requires generated builders to preserve the assigned canonical ID', async () => {
    const directory = await temporaryDirectory();
    const store = new PreambleStore(directory);
    await store.init();

    await expect(store.createWithGeneratedId(
      0,
      () => ID_A,
      () => preamble(ID_B),
    )).rejects.toMatchObject({ code: 'PREAMBLE_VALIDATION_FAILED' });
    await expect(store.createWithGeneratedId(
      0,
      () => ID_A,
      () => preamble('malformed'),
    )).rejects.toMatchObject({ code: 'PREAMBLE_VALIDATION_FAILED' });

    expect(store.snapshot()).toEqual({ revision: 0, preambles: [] });
  });

  it('enforces the lifetime ID ceiling without pruning tombstones', async () => {
    const directory = await temporaryDirectory();
    const store = new PreambleStore(directory);
    await store.init();
    // Fill the lifetime set to the ceiling through a persisted file.
    const retired = [];
    const active = [];
    for (let index = 0; index < PREAMBLE_ID_LIFETIME_MAX_COUNT; index += 1) {
      const id = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
      if (active.length < 1) active.push(preamble(id));
      else retired.push(id);
    }
    await writeCatalog(directory, {
      version: 2,
      revision: 1,
      preambles: active,
      retiredPreambleIds: retired,
    });
    const full = new PreambleStore(directory);
    await full.init();
    expect(full.lifetimeIdCount()).toBe(PREAMBLE_ID_LIFETIME_MAX_COUNT);
    await expect(full.create(preamble(ID_C), 1)).rejects.toMatchObject({
      code: 'PREAMBLE_ID_LIFETIME_LIMIT_REACHED',
    });
    // Deletion still retires an active entry at the ceiling.
    await full.remove(active[0].id, 1);
    expect(await readCatalog(directory)).toMatchObject({
      retiredPreambleIds: [...retired, active[0].id],
      preambles: active.slice(1).map((entry) => entry.id),
    });
  });

  it('accounts for the exact written payload including the trailing newline and incremented revision', async () => {
    // A legal catalog cannot reach the 64 MiB ceiling (lifetime and content
    // bounds cap it far below), so exact accounting is proven on the largest
    // legal shape: the on-disk byte length must equal the store's serialized
    // form with the incremented revision and trailing newline included.
    // Stay within the 64,000-code-unit combined composition budget: scope
    // each entry to a distinct exact path so no matching set combines them.
    const directory = await temporaryDirectory();
    const canonicalProjectBase = await fs.realpath(
      process.env.GARCON_PROJECT_BASE_DIR ?? os.homedir(),
    );
    const definitions = [];
    for (let index = 0; index < 3; index += 1) {
      definitions.push(preamble(`00000000-0000-4000-8000-${String(index).padStart(12, '0')}`, {
        content: 'C'.repeat(30_000),
        scope: {
          type: 'project-paths',
          rules: [{
            projectPath: path.join(
              canonicalProjectBase,
              `.garcon-preamble-size-${path.basename(directory)}-${index}`,
            ),
            includeNested: false,
          }],
        },
      }));
    }
    const store = new PreambleStore(directory);
    await store.init();
    let revision = 0;
    for (const definition of definitions) {
      await store.create(definition, revision);
      revision += 1;
    }
    const expectedPayload = `${JSON.stringify({
      version: 2,
      revision,
      preambles: definitions,
      retiredPreambleIds: [],
    }, null, 2)}\n`;
    const onDisk = await fs.readFile(path.join(directory, 'preambles.json'));
    expect(onDisk.byteLength).toBe(new TextEncoder().encode(expectedPayload).byteLength);
    expect(onDisk.byteLength).toBeGreaterThan(90_000);
    const reopened = new PreambleStore(directory);
    await reopened.init();
    expect(reopened.snapshot().preambles).toHaveLength(definitions.length);
  });

  it('fails closed when the persisted file exceeds the byte bound', async () => {
    const directory = await temporaryDirectory();
    await fs.writeFile(
      path.join(directory, 'preambles.json'),
      `${JSON.stringify({ version: 2, revision: 0, preambles: [], retiredPreambleIds: [] })}\n${'x'.repeat(PREAMBLES_FILE_MAX_BYTES)}`,
    );
    await expect(new PreambleStore(directory).init()).rejects.toThrow('maximum file size');
  });

  it('installs the candidate and fences mutations after a post-rename failure', async () => {
    const directory = await temporaryDirectory();
    const store = new PreambleStore(directory);
    await store.init();
    await store.create(preamble(ID_A), 0);

    // The temp-file write uses flag 'w'; the durability sync opens the
    // directory with flag 'r'. Failing only the latter simulates a post-rename
    // durability failure.
    const originalOpen = fs.open;
    fs.open = async (target, flags, ...rest) => {
      if (flags === 'r' && typeof target === 'string' && target === directory) {
        throw new Error('injected directory sync failure');
      }
      return originalOpen(target, flags, ...rest);
    };
    try {
      await expect(store.remove(ID_A, 1)).rejects.toBeInstanceOf(PreambleCatalogCommittedUnknownError);
    } finally {
      fs.open = originalOpen;
    }

    // The renamed candidate is authoritative: the tombstone is installed.
    expect(store.snapshot().preambles).toEqual([]);
    expect(await readCatalog(directory)).toMatchObject({
      retiredPreambleIds: [ID_A],
    });
    // Later mutations stay fenced until an explicit sync retry or restart.
    await expect(store.create(preamble(ID_C), 2)).rejects.toMatchObject({
      code: 'PREAMBLE_CATALOG_SAVE_UNKNOWN',
    });
    // Reads remain available from the installed snapshot.
    expect(store.snapshot().revision).toBe(2);
    // Restart reloads the file and clears the fence; the tombstone survives.
    const reopened = new PreambleStore(directory);
    await reopened.init();
    expect(reopened.snapshot().preambles).toEqual([]);
    await reopened.create(preamble(ID_C), 2);
    expect(reopened.snapshot().preambles.map((entry) => entry.id)).toEqual([ID_C]);
  });

  it('keeps the old snapshot authoritative on a pre-rename failure', async () => {
    const directory = await temporaryDirectory();
    const store = new PreambleStore(directory);
    await store.init();
    await store.create(preamble(ID_A), 0);
    const before = store.snapshot();

    const originalRename = fs.rename;
    fs.rename = async () => {
      throw new Error('injected rename failure');
    };
    try {
      await expect(store.remove(ID_A, 1)).rejects.toThrow('injected rename failure');
    } finally {
      fs.rename = originalRename;
    }

    expect(store.snapshot()).toEqual(before);
    expect(await readCatalog(directory)).toMatchObject({ revision: 1 });
  });
});
