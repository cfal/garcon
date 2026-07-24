import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadReviewDiffBatches, planReviewDiffBatches } from '../review-diff-batch.js';

const temporaryDirectories = [];

async function git(projectPath, args) {
  const process = Bun.spawn(['git', ...args], {
    cwd: projectPath,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) throw new Error(stderr || stdout);
  return stdout.trim();
}

function reviewFile(pathname, estimatedRows = 3) {
  return {
    path: pathname,
    change: { kind: 'tree-diff', status: 'modified', rawStatus: 'M' },
    category: 'normal',
    additions: 1,
    deletions: 1,
    estimatedRows,
    bodyState: 'unloaded',
    bodyFingerprint: `fingerprint:${pathname}`,
    isBinary: false,
    isTooLarge: false,
  };
}

async function createRevisionDocument() {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-review-batch-'));
  temporaryDirectories.push(projectPath);
  await git(projectPath, ['init']);
  await git(projectPath, ['config', 'user.email', 'test@example.com']);
  await git(projectPath, ['config', 'user.name', 'Test User']);
  await fs.writeFile(path.join(projectPath, 'a.txt'), 'old a\n');
  await fs.writeFile(path.join(projectPath, 'b.txt'), 'old b\n');
  await git(projectPath, ['add', '.']);
  await git(projectPath, ['commit', '-m', 'initial']);
  const baseHash = await git(projectPath, ['rev-parse', 'HEAD']);
  await fs.writeFile(path.join(projectPath, 'a.txt'), 'new a\n');
  await fs.writeFile(path.join(projectPath, 'b.txt'), 'new b\n');
  await git(projectPath, ['add', '.']);
  await git(projectPath, ['commit', '-m', 'change']);
  const targetHash = await git(projectPath, ['rev-parse', 'HEAD']);
  const files = [reviewFile('a.txt'), reviewFile('b.txt')];
  return {
    document: {
      id: 'document',
      generation: 1,
      sourceCacheKey: 'source',
      projectPath,
      repoRoot: projectPath,
      context: 3,
      source: { kind: 'comparison-revisions', effectiveFromHash: baseHash, toHash: targetHash },
      filesByPath: new Map(files.map((file) => [file.path, file])),
      workingPathTokens: new Map(),
      createdAt: 0,
      lastAccessedAt: 0,
    },
    files,
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('planReviewDiffBatches', () => {
  it('splits batches by estimated rows', () => {
    const files = [reviewFile('large.ts', 20_000), reviewFile('next.ts', 1)];

    expect(planReviewDiffBatches(files).map((batch) => batch.map((file) => file.path))).toEqual([
      ['large.ts'],
      ['next.ts'],
    ]);
  });
});

describe('loadReviewDiffBatches', () => {
  it('loads multiple revision files with one Git diff process', async () => {
    const { document, files } = await createRevisionDocument();
    const trace = [];

    const result = await loadReviewDiffBatches(document, files, trace);

    expect(result.errors).toEqual({});
    expect(result.metrics).toEqual({ batchCount: 1, bisectionCount: 0 });
    expect(trace.filter((entry) => entry.args[0] === 'diff')).toHaveLength(1);
    expect(result.bodies).toHaveLength(2);
    expect(result.bodies.find((body) => body.path === 'a.txt')?.patch).toContain('+new a');
    expect(result.bodies.find((body) => body.path === 'b.txt')?.patch).toContain('+new b');
  });
});
