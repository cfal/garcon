import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { PathCache } from '../path-cache.ts';

describe('PathCache', () => {
  let basePath;
  let originalBasePath;

  beforeEach(async () => {
    originalBasePath = process.env.GARCON_PROJECT_BASE_DIR;
    basePath = path.join(os.tmpdir(), `garcon-path-cache-${randomUUID()}`);
    await fs.mkdir(basePath, { recursive: true });
    process.env.GARCON_PROJECT_BASE_DIR = basePath;
  });

  afterEach(async () => {
    if (originalBasePath === undefined)
      delete process.env.GARCON_PROJECT_BASE_DIR;
    else process.env.GARCON_PROJECT_BASE_DIR = originalBasePath;
    await fs.rm(basePath, { recursive: true, force: true });
  });

  it('resolves canonical directories and aliases to one effective key', async () => {
    const realPath = path.join(basePath, 'real');
    const aliasPath = path.join(basePath, 'alias');
    await fs.mkdir(realPath);
    await fs.symlink(realPath, aliasPath);
    const cache = new PathCache();

    const real = await cache.resolveProjectPath(realPath);
    const alias = await cache.resolveProjectPath(aliasPath);

    expect(real).toEqual({
      available: true,
      effectiveProjectKey: await fs.realpath(realPath),
    });
    expect(alias).toEqual(real);
  });

  it('normalizes missing and outside-base paths to unavailable', async () => {
    const cache = new PathCache();

    expect(
      await cache.resolveProjectPath(path.join(basePath, 'missing')),
    ).toEqual({
      available: false,
      effectiveProjectKey: null,
    });
    expect(await cache.resolveProjectPath(os.tmpdir())).toEqual({
      available: false,
      effectiveProjectKey: null,
    });
  });

  it('deduplicates batch paths and preserves first-seen result order', async () => {
    const one = path.join(basePath, 'one');
    const two = path.join(basePath, 'two');
    await fs.mkdir(one);
    await fs.mkdir(two);
    const cache = new PathCache();

    const result = await cache.resolveProjectPaths([two, one, two], 2);

    expect([...result.keys()]).toEqual([two, one]);
    expect(result.get(one)?.effectiveProjectKey).toBe(await fs.realpath(one));
  });
});
