import { afterEach, describe, expect, it } from 'bun:test';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { SnippetStore } from '../store.ts';

const createdDirs = [];

async function tempDir() {
  const dir = path.join(os.tmpdir(), `garcon-snippets-${randomUUID()}`);
  await fs.mkdir(dir, { recursive: true });
  createdDirs.push(dir);
  return dir;
}

function snippet(id, shortName = id) {
  return {
    id,
    shortName,
    template: `Template ${id}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('snippet persistence', () => {
  afterEach(async () => {
    for (const dir of createdDirs.splice(0)) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('persists ordered mutations, private permissions, and revision conflicts', async () => {
    const dir = await tempDir();
    const store = new SnippetStore(dir);
    await store.init();
    await store.create(snippet('a'), 0);
    await store.create(snippet('b'), 1);
    await store.reorder(['b', 'a'], 2);
    await store.update(
      'a',
      { shortName: 'a', template: 'Updated' },
      '2026-01-02T00:00:00.000Z',
      3,
    );

    expect(store.snapshot()).toMatchObject({
      revision: 4,
      snippets: [{ id: 'b' }, { id: 'a', template: 'Updated' }],
    });
    await expect(store.remove('a', 3)).rejects.toMatchObject({
      code: 'SNIPPET_REVISION_CONFLICT',
      status: 409,
      retryable: true,
    });

    const filePath = path.join(dir, 'snippets.json');
    expect((await fs.stat(filePath)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await fs.readFile(filePath, 'utf8')).revision).toBe(4);
  });

  it('keeps each snippet update timestamp strictly monotonic', async () => {
    const dir = await makeWorkspace();
    const store = new SnippetStore(dir);
    await store.init();
    const original = snippet('a');
    await store.create(original, 0);

    await store.update(
      original.id,
      { shortName: original.shortName, template: 'Updated' },
      original.updatedAt,
      1,
    );

    expect(store.snapshot().snippets[0].updatedAt).toBe(
      '2026-01-01T00:00:00.001Z',
    );
  });

  it('enforces name uniqueness and exact full-list reorder input', async () => {
    const dir = await tempDir();
    const store = new SnippetStore(dir);
    await store.init();
    await store.create(snippet('a', 'review'), 0);
    await expect(store.create(snippet('b', 'review'), 1)).rejects.toMatchObject(
      {
        code: 'SNIPPET_NAME_CONFLICT',
      },
    );
    await expect(store.reorder([], 1)).rejects.toMatchObject({
      code: 'SNIPPET_VALIDATION_FAILED',
    });
  });

  it('recovers valid version-one rows while keeping the first duplicate', async () => {
    const dir = await tempDir();
    await fs.writeFile(
      path.join(dir, 'snippets.json'),
      JSON.stringify({
        version: 1,
        revision: 3,
        snippets: [
          snippet('a', 'review'),
          snippet('b', 'review'),
          { invalid: true },
        ],
      }),
    );
    const store = new SnippetStore(dir);
    await store.init();
    expect(store.snapshot()).toMatchObject({
      revision: 3,
      snippets: [{ id: 'a' }],
    });
  });

  it('rejects future file versions instead of reinterpreting them', async () => {
    const dir = await tempDir();
    await fs.writeFile(
      path.join(dir, 'snippets.json'),
      JSON.stringify({ version: 2, revision: 0, snippets: [] }),
    );

    await expect(new SnippetStore(dir).init()).rejects.toThrow(
      'Unsupported snippets.json version: 2',
    );
  });

  it('enforces the count limit without changing the loaded snapshot', async () => {
    const dir = await tempDir();
    const snippets = Array.from({ length: 100 }, (_, index) =>
      snippet(`snippet-${index}`, `item-${index}`),
    );
    await fs.writeFile(
      path.join(dir, 'snippets.json'),
      JSON.stringify({ version: 1, revision: 7, snippets }),
    );
    const store = new SnippetStore(dir);
    await store.init();

    await expect(
      store.create(snippet('overflow', 'overflow'), 7),
    ).rejects.toMatchObject({ code: 'SNIPPET_LIMIT_REACHED' });
    expect(store.snapshot()).toEqual({ revision: 7, snippets });
  });

  it('rejects an over-cap file instead of truncating persisted snippets', async () => {
    const dir = await tempDir();
    const filePath = path.join(dir, 'snippets.json');
    const snippets = Array.from({ length: 101 }, (_, index) =>
      snippet(`snippet-${index}`, `item-${index}`),
    );
    const persisted = JSON.stringify({ version: 1, revision: 7, snippets });
    await fs.writeFile(filePath, persisted);

    await expect(new SnippetStore(dir).init()).rejects.toThrow(
      'snippets.json exceeds the maximum of 100 snippets',
    );
    expect(await fs.readFile(filePath, 'utf8')).toBe(persisted);
  });

  it('rejects a mutation before a safe revision would overflow', async () => {
    const dir = await tempDir();
    const filePath = path.join(dir, 'snippets.json');
    const file = {
      version: 1,
      revision: Number.MAX_SAFE_INTEGER,
      snippets: [],
    };
    await fs.writeFile(filePath, JSON.stringify(file));
    const store = new SnippetStore(dir);
    await store.init();

    await expect(
      store.create(snippet('a'), Number.MAX_SAFE_INTEGER),
    ).rejects.toMatchObject({
      code: 'SNIPPET_REVISION_EXHAUSTED',
      status: 409,
      retryable: false,
    });
    expect(store.snapshot()).toEqual({
      revision: Number.MAX_SAFE_INTEGER,
      snippets: [],
    });
    expect(JSON.parse(await fs.readFile(filePath, 'utf8'))).toEqual(file);
  });

  it('keeps the in-memory snapshot unchanged when an atomic write fails', async () => {
    const dir = await tempDir();
    const filePath = path.join(dir, 'snippets.json');
    const store = new SnippetStore(dir);
    await store.init();
    await fs.mkdir(filePath);

    await expect(store.create(snippet('a'), 0)).rejects.toBeTruthy();
    expect(store.snapshot()).toEqual({ revision: 0, snippets: [] });
  });
});
