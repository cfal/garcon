import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspectProjectDirectory } from '../project-directory-service.ts';

describe('inspectProjectDirectory', () => {
  let rootPath;
  let basePath;
  let priorBasePath;

  beforeEach(async () => {
    priorBasePath = process.env.GARCON_PROJECT_BASE_DIR;
    rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-project-directory-'));
    basePath = path.join(rootPath, 'base');
    await fs.mkdir(basePath);
    process.env.GARCON_PROJECT_BASE_DIR = basePath;
  });

  afterEach(async () => {
    if (priorBasePath === undefined) delete process.env.GARCON_PROJECT_BASE_DIR;
    else process.env.GARCON_PROJECT_BASE_DIR = priorBasePath;
    await fs.rm(rootPath, { recursive: true, force: true });
  });

  it('does not resolve a blank path to the project base', async () => {
    await expect(inspectProjectDirectory('  ')).resolves.toEqual({
      kind: 'unavailable', reason: 'not-found',
    });
  });

  it('returns a canonical identity for an accessible directory', async () => {
    const projectPath = path.join(basePath, 'project');
    const aliasPath = path.join(basePath, 'alias');
    await fs.mkdir(projectPath);
    await fs.symlink(projectPath, aliasPath);

    await expect(inspectProjectDirectory(aliasPath)).resolves.toEqual({
      kind: 'available',
      effectiveProjectKey: await fs.realpath(projectPath),
    });
  });

  it('classifies missing, non-directory, boundary, and permission failures', async () => {
    const filePath = path.join(basePath, 'file');
    await fs.writeFile(filePath, 'file');
    await expect(inspectProjectDirectory(path.join(basePath, 'missing'))).resolves.toEqual({
      kind: 'unavailable', reason: 'not-found',
    });
    await expect(inspectProjectDirectory(filePath)).resolves.toEqual({
      kind: 'unavailable', reason: 'not-a-directory',
    });
    await expect(inspectProjectDirectory(path.dirname(basePath))).resolves.toEqual({
      kind: 'unavailable', reason: 'outside-base',
    });
    await expect(inspectProjectDirectory(basePath, {
      access: async () => {
        const error = new Error('denied');
        error.code = 'EACCES';
        throw error;
      },
    })).resolves.toEqual({ kind: 'unavailable', reason: 'permission-denied' });
  });

  it('rejects symlinks that escape the project base', async () => {
    const outsidePath = path.join(rootPath, 'outside');
    const aliasPath = path.join(basePath, 'alias');
    await fs.mkdir(outsidePath);
    await fs.symlink(outsidePath, aliasPath);

    await expect(inspectProjectDirectory(aliasPath)).resolves.toEqual({
      kind: 'unavailable', reason: 'outside-base',
    });
  });

  it('classifies symlink loops as missing paths', async () => {
    const firstPath = path.join(basePath, 'first');
    const secondPath = path.join(basePath, 'second');
    await fs.symlink(secondPath, firstPath);
    await fs.symlink(firstPath, secondPath);

    await expect(inspectProjectDirectory(firstPath)).resolves.toEqual({
      kind: 'unavailable', reason: 'not-found',
    });
  });

  it('rejects unexpected filesystem failures', async () => {
    const failure = new Error('device failed');
    await expect(inspectProjectDirectory(basePath, {
      stat: async () => { throw failure; },
    })).rejects.toBe(failure);
  });
});
