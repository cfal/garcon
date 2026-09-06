import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { inspectProjectDirectory } from '../project-directory-service.ts';

describe('inspectProjectDirectory', () => {
  let basePath;
  let priorBasePath;

  beforeEach(async () => {
    priorBasePath = process.env.GARCON_PROJECT_BASE_DIR;
    basePath = path.join(os.homedir(), `garcon-project-directory-${randomUUID()}`);
    await fs.mkdir(basePath, { recursive: true });
    process.env.GARCON_PROJECT_BASE_DIR = basePath;
  });

  afterEach(async () => {
    if (priorBasePath === undefined) delete process.env.GARCON_PROJECT_BASE_DIR;
    else process.env.GARCON_PROJECT_BASE_DIR = priorBasePath;
    await fs.rm(basePath, { recursive: true, force: true });
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

  it('rejects unexpected filesystem failures', async () => {
    const failure = new Error('device failed');
    await expect(inspectProjectDirectory(basePath, {
      stat: async () => { throw failure; },
    })).rejects.toBe(failure);
  });
});
