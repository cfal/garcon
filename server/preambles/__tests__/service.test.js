import { afterEach, describe, expect, it, mock } from 'bun:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { preambleCatalogCompositionViolation } from '../catalog-budget.ts';
import { preambleRuleMatches } from '../matching.ts';
import { PreambleService } from '../service.ts';
import { PreambleStore } from '../store.ts';

const createdDirectories = [];

async function service(overrides = {}) {
  const directory = path.join(os.tmpdir(), `garcon-preamble-service-${randomUUID()}`);
  await fs.mkdir(directory, { recursive: true });
  createdDirectories.push(directory);
  const store = new PreambleStore(directory);
  await store.init();
  let nextId = 0;
  const projectPaths = overrides.projectPaths ?? {
    resolve: mock(async (projectPath) => path.resolve(projectPath)),
  };
  return {
    store,
    projectPaths,
    preambles: new PreambleService({
      store,
      projectPaths,
      newId: () => `preamble-${++nextId}`,
      now: () => new Date('2026-09-03T10:00:00.000Z'),
    }),
  };
}

function globalDefinition(title, content = `${title} body`) {
  return { enabled: true, title, content, scope: { type: 'global' } };
}

afterEach(async () => {
  for (const directory of createdDirectories.splice(0)) {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

describe('preamble matching', () => {
  it('matches exact and nested paths without confusing sibling prefixes', () => {
    const exact = { projectPath: '/workspace/project', includeNested: false };
    const nested = { ...exact, includeNested: true };
    expect(preambleRuleMatches(exact, '/workspace/project')).toBe(true);
    expect(preambleRuleMatches(exact, '/workspace/project/nested')).toBe(false);
    expect(preambleRuleMatches(nested, '/workspace/project/nested')).toBe(true);
    expect(preambleRuleMatches(nested, '/workspace/project-other')).toBe(false);
    expect(preambleRuleMatches(nested, '/workspace/project/..cache')).toBe(true);
  });
});

describe('PreambleService', () => {
  it('canonicalizes every path rule and resolves each matching preamble once in catalog order', async () => {
    const projectPaths = {
      resolve: mock(async (projectPath) => `/canonical/${path.basename(projectPath)}`),
    };
    const { preambles } = await service({ projectPaths });
    await preambles.create({ expectedRevision: 0, preamble: globalDefinition('Global first') });
    await preambles.create({
      expectedRevision: 1,
      preamble: {
        enabled: true,
        title: 'Project',
        content: 'Project body',
        scope: {
          type: 'project-paths',
          rules: [
            { projectPath: '/input/project', includeNested: true },
            { projectPath: '/input/nested', includeNested: false },
          ],
        },
      },
    });
    await preambles.create({ expectedRevision: 2, preamble: globalDefinition('Global last') });

    expect(projectPaths.resolve).toHaveBeenCalledTimes(2);
    expect(preambles.resolve('/canonical/project/child').map((entry) => entry.title)).toEqual([
      'Global first',
      'Project',
      'Global last',
    ]);
    expect(preambles.resolve('/canonical/nested').map((entry) => entry.title)).toEqual([
      'Global first',
      'Project',
      'Global last',
    ]);
  });

  it('rejects canonical path aliases within one preamble', async () => {
    const { preambles } = await service({
      projectPaths: { resolve: mock(async () => '/canonical/project') },
    });
    await expect(preambles.create({
      expectedRevision: 0,
      preamble: {
        enabled: true,
        title: 'Aliased',
        content: 'Body',
        scope: {
          type: 'project-paths',
          rules: [
            { projectPath: '/first', includeNested: true },
            { projectPath: '/second', includeNested: false },
          ],
        },
      },
    })).rejects.toMatchObject({ code: 'PREAMBLE_VALIDATION_FAILED' });
    expect(preambles.snapshot()).toEqual({ revision: 0, preambles: [] });
  });

  it('rejects a candidate whose matching composition exceeds the fixed budget', async () => {
    const { preambles } = await service();
    await preambles.create({
      expectedRevision: 0,
      preamble: globalDefinition('First', 'a'.repeat(32_000)),
    });
    await expect(preambles.create({
      expectedRevision: 1,
      preamble: globalDefinition('Second', 'b'.repeat(32_000)),
    })).rejects.toMatchObject({
      code: 'PREAMBLE_COMBINED_LIMIT_EXCEEDED',
      status: 422,
    });
    expect(preambles.snapshot()).toMatchObject({ revision: 1 });
  });

  it('validates the combined budget after chat ID expansion', async () => {
    const { preambles } = await service();
    const content = '{{chat_id}}'.repeat(2_700);
    await preambles.create({
      expectedRevision: 0,
      preamble: globalDefinition('First', content),
    });
    await expect(preambles.create({
      expectedRevision: 1,
      preamble: globalDefinition('Second', content),
    })).rejects.toMatchObject({
      code: 'PREAMBLE_COMBINED_LIMIT_EXCEEDED',
      status: 422,
    });
    expect(preambles.snapshot()).toMatchObject({ revision: 1 });
  });

  it('combines nested ancestor rules when validating a descendant candidate', async () => {
    const { preambles } = await service();
    await preambles.create({
      expectedRevision: 0,
      preamble: {
        ...globalDefinition('Ancestor', 'a'.repeat(32_000)),
        scope: {
          type: 'project-paths',
          rules: [{ projectPath: '/workspace', includeNested: true }],
        },
      },
    });
    await expect(preambles.create({
      expectedRevision: 1,
      preamble: {
        ...globalDefinition('Descendant', 'b'.repeat(32_000)),
        scope: {
          type: 'project-paths',
          rules: [{ projectPath: '/workspace/child', includeNested: false }],
        },
      },
    })).rejects.toMatchObject({ code: 'PREAMBLE_COMBINED_LIMIT_EXCEEDED' });
  });

  it('rejects a reserved file-context separator reconstructed across bodies', async () => {
    const { preambles } = await service();
    await preambles.create({
      expectedRevision: 0,
      preamble: globalDefinition('First', 'First body'),
    });
    await expect(preambles.create({
      expectedRevision: 1,
      preamble: globalDefinition(
        'Second',
        'Referenced file contents from @file mentions:\n\nSynthetic content',
      ),
    })).rejects.toMatchObject({
      code: 'PREAMBLE_VALIDATION_FAILED',
      status: 400,
    });
    expect(preambles.snapshot()).toMatchObject({ revision: 1 });

    const { preambles: leadingSeparator } = await service();
    await expect(leadingSeparator.create({
      expectedRevision: 0,
      preamble: globalDefinition(
        'Leading separator',
        '\nReferenced file contents from @file mentions:\n\nSynthetic content',
      ),
    })).rejects.toMatchObject({
      code: 'PREAMBLE_VALIDATION_FAILED',
      status: 400,
    });
    expect(leadingSeparator.snapshot()).toEqual({ revision: 0, preambles: [] });
  });

  it('excludes disabled preambles from matching and the combined budget', async () => {
    const { preambles } = await service();
    await preambles.create({
      expectedRevision: 0,
      preamble: { ...globalDefinition('First', 'a'.repeat(32_000)), enabled: false },
    });
    await preambles.create({
      expectedRevision: 1,
      preamble: globalDefinition('Second', 'b'.repeat(32_000)),
    });

    expect(preambles.resolve('/workspace')).toHaveLength(1);
    expect(preambles.resolve('/workspace')[0]?.title).toBe('Second');
    await expect(preambles.update({
      expectedRevision: 2,
      id: 'preamble-1',
      preamble: globalDefinition('First', 'a'.repeat(32_000)),
    })).rejects.toMatchObject({ code: 'PREAMBLE_COMBINED_LIMIT_EXCEEDED' });
    expect(preambles.snapshot().preambles[0]?.enabled).toBe(false);
  });

  it('emits invalidation only after a successful persisted mutation', async () => {
    const { preambles } = await service();
    const reasons = [];
    preambles.onInvalidated((reason) => reasons.push(reason));

    await preambles.create({ expectedRevision: 0, preamble: globalDefinition('First') });
    await expect(preambles.remove({ expectedRevision: 0, id: 'preamble-1' })).rejects.toMatchObject({
      code: 'PREAMBLE_REVISION_CONFLICT',
    });
    await preambles.update({
      expectedRevision: 1,
      id: 'preamble-1',
      preamble: globalDefinition('Updated'),
    });
    await preambles.remove({ expectedRevision: 2, id: 'preamble-1' });

    expect(reasons).toEqual(['created', 'updated', 'removed']);
  });

  it('rejects malformed reorder IDs before validating their composition', async () => {
    const { preambles } = await service();
    await preambles.create({
      expectedRevision: 0,
      preamble: globalDefinition('Large', 'a'.repeat(32_000)),
    });
    await preambles.create({
      expectedRevision: 1,
      preamble: globalDefinition('Small'),
    });

    await expect(preambles.reorder({
      expectedRevision: 2,
      orderedPreambleIds: ['preamble-1', 'preamble-1'],
    })).rejects.toMatchObject({ code: 'PREAMBLE_VALIDATION_FAILED', status: 400 });
    expect(preambles.snapshot()).toMatchObject({ revision: 2 });
  });

  it('reports a revision conflict before comparing a stale reorder with the current catalog', async () => {
    const { preambles } = await service();
    await preambles.create({ expectedRevision: 0, preamble: globalDefinition('First') });
    await preambles.create({ expectedRevision: 1, preamble: globalDefinition('Second') });
    await preambles.remove({ expectedRevision: 2, id: 'preamble-2' });

    await expect(preambles.reorder({
      expectedRevision: 2,
      orderedPreambleIds: ['preamble-2', 'preamble-1'],
    })).rejects.toMatchObject({ code: 'PREAMBLE_REVISION_CONFLICT', status: 409 });
    expect(preambles.snapshot()).toMatchObject({ revision: 3 });
  });

  it('validates the maximum rule shape without quadratic path matching', () => {
    const preambles = Array.from({ length: 100 }, (_, preambleIndex) => ({
      id: `preamble-${preambleIndex}`,
      enabled: true,
      title: `Preamble ${preambleIndex}`,
      content: 'x',
      scope: {
        type: 'project-paths',
        rules: Array.from({ length: 32 }, (_, ruleIndex) => ({
          projectPath: `/workspace/${preambleIndex}/${ruleIndex}`,
          includeNested: false,
        })),
      },
      createdAt: '2026-09-03T10:00:00.000Z',
      updatedAt: '2026-09-03T10:00:00.000Z',
    }));
    const startedAt = performance.now();

    expect(preambleCatalogCompositionViolation(preambles)).toBeNull();
    expect(performance.now() - startedAt).toBeLessThan(500);
  });
});
