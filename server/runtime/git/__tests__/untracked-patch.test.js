import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadUntrackedPatches } from '../untracked-patch.js';
import { createReviewPatchBody, splitPatchesFromRawDiff } from '../review-patch.js';
import { initRepoWithCommit, runGitCommand } from './repository-fixture.js';

const directories = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});

describe('untracked addition patches', () => {
  it.each([
    ['', 0],
    ['one', 1],
    ['one\n', 1],
    ['one\n\n', 2],
    ['one\ntwo\n', 2],
  ])('preserves newline semantics without modifying the real index: %p', async (content, lines) => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-untracked-patch-'));
    directories.push(projectPath);
    await initRepoWithCommit(projectPath);
    await fs.writeFile(path.join(projectPath, 'added.txt'), content);
    const before = await runGitCommand(projectPath, ['ls-files', '--stage']);

    const raw = await loadUntrackedPatches(projectPath, ['added.txt'], 3);
    const selected = splitPatchesFromRawDiff(raw).get('added.txt');
    expect(selected).toBeDefined();
    const body = createReviewPatchBody('added.txt', 'synthetic-fingerprint', selected.patch);
    expect(body.bodyState).toBe('loaded');
    expect(body.renderedRowCount).toBe(lines === 0 ? 0 : lines + 1);
    expect(body.patch.includes('\\ No newline at end of file')).toBe(content.length > 0 && !content.endsWith('\n'));
    if (lines > 0) expect(body.patch).toContain(`@@ -0,0 +1${lines === 1 ? '' : `,${lines}`} @@`);
    expect((await runGitCommand(projectPath, ['ls-files', '--stage'])).stdout).toBe(before.stdout);
  });
});
