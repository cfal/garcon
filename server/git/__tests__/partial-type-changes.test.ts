import { afterEach, expect, test } from 'bun:test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { runGit } from '../run.js';
import { cleanupNodeRuntimeFixtures, nodeRuntimeFixture, untrackedReview } from './node-runtime-fixture.js';

afterEach(cleanupNodeRuntimeFixtures);

for (const method of ['stageHunk', 'stageSelection'] as const) {
  test(`${method} excludes subsequent section headers from type-change hunks`, async () => {
    const { projectPath, git } = await nodeRuntimeFixture();
    const file = 'tracked.txt';
    await fs.writeFile(path.join(projectPath, file), 'first\nsecond\nthird\n');
    await runGit(projectPath, ['commit', '-am', 'Record regular file']);
    await fs.rm(path.join(projectPath, file));
    await fs.symlink('target.txt', path.join(projectPath, file));
    const { document, body } = await untrackedReview(git, projectPath, file);
    expect(body.patch?.match(/^diff --git /gm)).toHaveLength(2);
    const proof = { projectPath, file, document, bodyFingerprint: body.bodyFingerprint, patchDigest: body.patchDigest!, mode: 'stage' as const, contextLines: 2 };
    if (method === 'stageHunk') await git.stageHunk({ ...proof, hunkIndex: 0 });
    else await git.stageSelection({ ...proof, selection: { lineIndices: [0] } });
    expect((await runGit(projectPath, ['show', `:${file}`])).stdout).toBe(method === 'stageHunk' ? '' : 'second\nthird\n');
    expect((await runGit(projectPath, ['ls-files', '-s', '--', file])).stdout).toStartWith('100644 ');
    expect(await fs.readlink(path.join(projectPath, file))).toBe('target.txt');
  });
}
