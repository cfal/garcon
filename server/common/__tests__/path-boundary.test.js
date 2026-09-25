import { afterEach, describe, expect, it } from 'bun:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveRealWithinBase } from '../path-boundary.ts';

let directory;

afterEach(async () => {
  if (directory) await fs.rm(directory, { recursive: true, force: true });
  directory = undefined;
});

describe('project path boundaries', () => {
  it('accepts an in-base directory whose name begins with two dots', async () => {
    directory = path.join(os.tmpdir(), `garcon-path-boundary-${randomUUID()}`);
    const projectPath = path.join(directory, '..cache');
    await fs.mkdir(projectPath, { recursive: true });

    expect(await resolveRealWithinBase(directory, projectPath)).toBe(await fs.realpath(projectPath));
  });
});
