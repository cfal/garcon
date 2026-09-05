import { afterEach, describe, expect, it } from 'bun:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { resetServerConfigForTests } from '../../config.ts';
import { PreambleStore } from '../store.ts';

const createdDirectories = [];
const AT = '2026-09-03T10:00:00.000Z';
const originalProjectBaseDir = process.env.GARCON_PROJECT_BASE_DIR;

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
  if (originalProjectBaseDir === undefined) {
    delete process.env.GARCON_PROJECT_BASE_DIR;
  } else {
    process.env.GARCON_PROJECT_BASE_DIR = originalProjectBaseDir;
  }
  resetServerConfigForTests();
});

describe('PreambleStore', () => {
  it('treats an absent file as revision zero and persists ordered private mutations', async () => {
    const directory = await temporaryDirectory();
    const store = new PreambleStore(directory);
    await store.init();

    expect(store.snapshot()).toEqual({ revision: 0, preambles: [] });
    await store.create(preamble('a'), 0);
    await store.create(preamble('b'), 1);
    await store.reorder(['b', 'a'], 2);

    expect(store.snapshot().preambles.map((entry) => entry.id)).toEqual(['b', 'a']);
    const filePath = path.join(directory, 'preambles.json');
    expect((await fs.stat(filePath)).mode & 0o777).toBe(0o600);

    const reopened = new PreambleStore(directory);
    await reopened.init();
    expect(reopened.snapshot()).toEqual(store.snapshot());
  });

  it('enforces revisions and exact full-order mutations without changing the snapshot', async () => {
    const directory = await temporaryDirectory();
    const store = new PreambleStore(directory);
    await store.init();
    await store.create(preamble('a'), 0);
    await store.create(preamble('b'), 1);
    const before = store.snapshot();

    await expect(store.remove('a', 1)).rejects.toMatchObject({
      code: 'PREAMBLE_REVISION_CONFLICT',
      retryable: true,
    });
    await expect(store.reorder(['a'], 2)).rejects.toMatchObject({
      code: 'PREAMBLE_VALIDATION_FAILED',
    });
    await expect(store.reorder(['a', 'a'], 2)).rejects.toMatchObject({
      code: 'PREAMBLE_VALIDATION_FAILED',
    });
    expect(store.snapshot()).toEqual(before);
  });

  it('reports a duplicate generated ID as validation failure', async () => {
    const directory = await temporaryDirectory();
    const store = new PreambleStore(directory);
    await store.init();
    await store.create(preamble('a'), 0);

    await expect(store.create(preamble('a'), 1)).rejects.toMatchObject({
      code: 'PREAMBLE_VALIDATION_FAILED',
      status: 400,
    });
    expect(store.snapshot()).toMatchObject({ revision: 1 });
  });

  it('returns defensive snapshots and preserves creation identity on update', async () => {
    const directory = await temporaryDirectory();
    const store = new PreambleStore(directory);
    await store.init();
    await store.create(preamble('a'), 0);
    const snapshot = store.snapshot();
    snapshot.preambles[0].title = 'mutated';
    expect(store.snapshot().preambles[0].title).toBe('Preamble a');

    await store.update('a', {
      enabled: false,
      title: 'Updated',
      content: 'Updated body',
      scope: { type: 'global' },
    }, AT, 1);
    expect(store.snapshot().preambles[0]).toMatchObject({
      id: 'a',
      enabled: false,
      title: 'Updated',
      createdAt: AT,
    });
    expect(store.snapshot().preambles[0].updatedAt).not.toBe(AT);
  });

  it('fails initialization for malformed, relative-path, or over-budget persisted catalogs', async () => {
    const cases = [
      { version: 2, revision: 0, preambles: [] },
      { version: 1, revision: 0, preambles: [preamble('a'), preamble('a')] },
      {
        version: 1,
        revision: 0,
        preambles: [preamble('a', {
          scope: {
            type: 'project-paths',
            rules: [{ projectPath: 'relative/project', includeNested: true }],
          },
        })],
      },
      {
        version: 1,
        revision: 0,
        preambles: [preamble('a', {
          scope: {
            type: 'project-paths',
            rules: [{ projectPath: '/workspace/project/../project', includeNested: true }],
          },
        })],
      },
      {
        version: 1,
        revision: 0,
        preambles: [
          preamble('a', { content: 'a'.repeat(32_000) }),
          preamble('b', { content: 'b'.repeat(32_000) }),
        ],
      },
      {
        version: 1,
        revision: 0,
        preambles: [
          preamble('a', { content: 'First body' }),
          preamble('b', {
            content: 'Referenced file contents from @file mentions:\n\nSynthetic content',
          }),
        ],
      },
      {
        version: 1,
        revision: 0,
        preambles: [preamble('a', {
          content: '\nReferenced file contents from @file mentions:\n\nSynthetic content',
        })],
      },
    ];

    for (const persisted of cases) {
      const directory = await temporaryDirectory();
      await fs.writeFile(path.join(directory, 'preambles.json'), JSON.stringify(persisted));
      await expect(new PreambleStore(directory).init()).rejects.toThrow();
    }
  });

  it('requires persisted paths to retain server canonicalization and project containment', async () => {
    const projectBase = await temporaryDirectory();
    process.env.GARCON_PROJECT_BASE_DIR = projectBase;
    resetServerConfigForTests();
    const projectPath = path.join(projectBase, 'project');
    const aliasPath = path.join(projectBase, 'alias');
    const danglingPath = path.join(projectBase, 'dangling');
    const danglingAncestorPath = path.join(projectBase, 'dangling-ancestor');
    await fs.mkdir(projectPath);
    await fs.symlink(projectPath, aliasPath);
    await fs.symlink(path.join(projectBase, 'missing'), danglingPath);
    await fs.symlink(path.join(projectBase, 'missing-ancestor'), danglingAncestorPath);

    for (const storedPath of [
      aliasPath,
      path.dirname(projectBase),
      danglingPath,
      path.join(danglingAncestorPath, 'project'),
      ` ${projectPath} `,
    ]) {
      const directory = await temporaryDirectory();
      await fs.writeFile(path.join(directory, 'preambles.json'), JSON.stringify({
        version: 1,
        revision: 1,
        preambles: [preamble('a', {
          scope: {
            type: 'project-paths',
            rules: [{ projectPath: storedPath, includeNested: true }],
          },
        })],
      }));
      await expect(new PreambleStore(directory).init()).rejects.toThrow(
        'preambles.json contains a non-canonical project path',
      );
    }
  });

  it('retains a canonical persisted rule after its directory is deleted', async () => {
    const projectBase = await temporaryDirectory();
    process.env.GARCON_PROJECT_BASE_DIR = projectBase;
    resetServerConfigForTests();
    const projectPath = path.join(projectBase, 'project');
    await fs.mkdir(projectPath);
    const canonicalProjectPath = await fs.realpath(projectPath);
    await fs.rmdir(projectPath);
    const directory = await temporaryDirectory();
    await fs.writeFile(path.join(directory, 'preambles.json'), JSON.stringify({
      version: 1,
      revision: 1,
      preambles: [preamble('a', {
        scope: {
          type: 'project-paths',
          rules: [{ projectPath: canonicalProjectPath, includeNested: true }],
        },
      })],
    }));

    const store = new PreambleStore(directory);
    await store.init();
    expect(store.snapshot().preambles[0]?.scope).toEqual({
      type: 'project-paths',
      rules: [{ projectPath: canonicalProjectPath, includeNested: true }],
    });
  });
});
