import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import {
  parseFileMentionTokens,
  resolveFileMentionsInCommand,
  stripResolvedFileMentionContext,
} from '../file-mentions.ts';

let projectPath;
let outsidePath;

beforeEach(async () => {
  const root = path.join(os.tmpdir(), `garcon-file-mentions-${randomUUID()}`);
  projectPath = path.join(root, 'project');
  outsidePath = path.join(root, 'secret.txt');
  await fs.mkdir(path.join(projectPath, 'src'), { recursive: true });
  await fs.mkdir(path.join(projectPath, 'docs'), { recursive: true });
  await fs.writeFile(path.join(projectPath, 'src/main.ts'), 'export const value = 42;\n', 'utf8');
  await fs.writeFile(path.join(projectPath, 'docs/design note.md'), '# Design\n', 'utf8');
  await fs.writeFile(outsidePath, 'do not include\n', 'utf8');
});

afterEach(async () => {
  await fs.rm(path.dirname(projectPath), { recursive: true, force: true });
});

describe('parseFileMentionTokens', () => {
  it('parses bare and quoted @file mentions', () => {
    expect(parseFileMentionTokens('read @src/main.ts and @"docs/design note.md"')).toEqual([
      { path: 'src/main.ts', start: 5, end: 17 },
      { path: 'docs/design note.md', start: 22, end: 44 },
    ]);
  });

  it('ignores @ inside regular words', () => {
    expect(parseFileMentionTokens('email alex@example.com and branch@{upstream}')).toEqual([]);
  });
});

describe('resolveFileMentionsInCommand', () => {
  it('appends contents for mentioned project files', async () => {
    const resolved = await resolveFileMentionsInCommand(
      'read @src/main.ts and @"docs/design note.md"',
      projectPath,
    );

    expect(resolved).toContain('Referenced file contents from @file mentions:');
    expect(resolved).toContain('@src/main.ts');
    expect(resolved).toContain('export const value = 42;');
    expect(resolved).toContain('@docs/design note.md');
    expect(resolved).toContain('# Design');
  });

  it('does not include files outside the project root', async () => {
    const resolved = await resolveFileMentionsInCommand('read @../secret.txt', projectPath);

    expect(resolved).toBe('read @../secret.txt');
    expect(resolved).not.toContain('do not include');
  });

  it('does not follow project symlinks outside the project root', async () => {
    await fs.symlink(outsidePath, path.join(projectPath, 'secret-link.txt'));

    const resolved = await resolveFileMentionsInCommand('read @secret-link.txt', projectPath);

    expect(resolved).toBe('read @secret-link.txt');
    expect(resolved).not.toContain('do not include');
  });

  it('strips resolved context back to the user-authored prompt', async () => {
    const resolved = await resolveFileMentionsInCommand('read @src/main.ts', projectPath);

    expect(stripResolvedFileMentionContext(resolved)).toBe('read @src/main.ts');
  });
});
