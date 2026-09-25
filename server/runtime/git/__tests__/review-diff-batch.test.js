import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import fs from 'node:fs/promises';
import { promises as nativeFs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadReviewDiffBatches, planReviewDiffBatches, limitGitReviewResponseBodies } from '../review-diff-batch.js';
import { GIT_MAX_RESULT_BYTES } from '../../../../common/git-execution.js';
import { validateGitResult } from '../../../../common/git-result-validation.js';

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

async function createLargeRevisionDocument() {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-review-budget-'));
  temporaryDirectories.push(projectPath);
  await git(projectPath, ['init']);
  await git(projectPath, ['config', 'user.email', 'test@example.com']);
  await git(projectPath, ['config', 'user.name', 'Test User']);
  const paths = ['a.txt', 'b.txt', 'c.txt', 'd.txt'];
  await Promise.all(paths.map((pathname) => fs.writeFile(path.join(projectPath, pathname), 'old\n')));
  await git(projectPath, ['add', '.']);
  await git(projectPath, ['commit', '-m', 'initial']);
  const baseHash = await git(projectPath, ['rev-parse', 'HEAD']);
  await Promise.all(
    paths.map((pathname) =>
      fs.writeFile(
        path.join(projectPath, pathname),
        Array.from({ length: 34_000 }, (_, index) => `${pathname}:${index}\n`).join(''),
      ),
    ),
  );
  await git(projectPath, ['add', '.']);
  await git(projectPath, ['commit', '-m', 'large change']);
  const targetHash = await git(projectPath, ['rev-parse', 'HEAD']);
  const files = paths.map((pathname) => reviewFile(pathname, 34_000));
  return {
    document: {
      id: 'large-document',
      generation: 1,
      sourceCacheKey: 'large-source',
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
  it.each(['x', '\t'])('bounds individual encoded bodies without shrinking the document budget (%p)', async (character) => {
    const { document, files } = await createRevisionDocument();
    const content = `${character.repeat(9999)}\n`.repeat(250);
    for (const [index, file] of files.entries()) {
      await fs.writeFile(path.join(document.repoRoot, file.path), character === '\t' && index > 0 ? 'small change\n' : content);
    }
    await git(document.repoRoot, ['add', '.']);
    await git(document.repoRoot, ['commit', '-m', 'bounded review']);
    document.source.toHash = await git(document.repoRoot, ['rev-parse', 'HEAD']);
    const loaded = await loadReviewDiffBatches(document, files);
    const bodies = limitGitReviewResponseBodies(loaded.bodies);
    expect(loaded.errors).toEqual({});
    expect(bodies.map(body => body.bodyState)).toEqual(character === 'x' ? ['loaded', 'loaded'] : ['too-large', 'loaded']);
    if (character === 'x') {
      expect(bodies.reduce((total, body) => total + body.patchBytes, 0)).toBeGreaterThan(GIT_MAX_RESULT_BYTES);
    }
    const scope = { executorId: 'local', instanceId: 'synthetic-instance' };
    for (const [index, body] of bodies.entries()) {
      expect(body.limitReason).toBe(character === '\t' && index === 0 ? 'file-too-many-bytes' : undefined);
      const response = { ...scope, status: 'ready', documentId: document.id,
        files: { [body.path]: body }, errors: loaded.errors };
      expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThan(GIT_MAX_RESULT_BYTES);
      expect(() => validateGitResult('getReviewDocumentFileBodies', response, scope)).not.toThrow();
    }
  });

  it('loads an untracked group with one scratch index while preserving attributes and literal paths', async () => {
    const { document } = await createRevisionDocument();
    const root = document.repoRoot;
    await fs.writeFile(path.join(root, '.gitattributes'), '*.txt text eol=lf\n');
    await git(root, ['add', '.gitattributes']);
    await fs.rm(path.join(root, '.gitattributes'));
    const names = ['new.txt', 'space name.txt', 'line\nname.txt', ':literal.txt', 'other.txt'];
    const files = names.map(name => ({ ...reviewFile(name), change: { kind: 'tree-diff', rawStatus: '?', status: 'added' } }));
    document.source = { kind: 'workbench', mode: 'working' };
    for (const file of files) await fs.writeFile(path.join(root, file.path), 'synthetic\r\n');
    const before = await fs.readFile(path.join(root, '.git', 'index'));
    const copy = spyOn(nativeFs, 'copyFile');
    const trace = [];
    try {
      const result = await loadReviewDiffBatches(document, files, trace);
      expect(result.errors).toEqual({});
      expect(result.bodies.map(body => body.path)).toEqual(names);
      for (const body of result.bodies) {
        expect(body.bodyState).toBe('loaded');
        expect(body.patch).toContain('+synthetic\n');
        expect(body.patch).not.toContain('\r');
      }
      expect(copy).toHaveBeenCalledTimes(1);
      expect(trace.filter(entry => entry.args[0] === 'add')).toHaveLength(1);
      expect(trace.filter(entry => entry.args[0] === 'diff')).toHaveLength(1);
      expect(await fs.readFile(path.join(root, '.git', 'index'))).toEqual(before);
      expect((await fs.readdir(path.join(root, '.git'))).filter(name => name.startsWith('.garcon-index-'))).toEqual([]);
    } finally { copy.mockRestore(); }
  });

  it('isolates a failed untracked path and cleans every scratch index', async () => {
    const { document } = await createRevisionDocument();
    const root = document.repoRoot;
    document.source = { kind: 'workbench', mode: 'working' };
    await fs.writeFile(path.join(root, '.gitignore'), 'ignored.txt\n');
    const files = ['valid.txt', 'ignored.txt'].map(name => ({ ...reviewFile(name), change: { kind: 'tree-diff', rawStatus: '?', status: 'added' } }));
    for (const file of files) await fs.writeFile(path.join(root, file.path), 'synthetic\n');
    const before = await fs.readFile(path.join(root, '.git', 'index'));
    const result = await loadReviewDiffBatches(document, files);
    expect(result.bodies.find(body => body.path === 'valid.txt')?.bodyState).toBe('loaded');
    expect(result.errors['ignored.txt']).toBeDefined();
    expect(result.metrics.bisectionCount).toBe(1);
    expect(await fs.readFile(path.join(root, '.git', 'index'))).toEqual(before);
    expect((await fs.readdir(path.join(root, '.git'))).filter(name => name.startsWith('.garcon-index-'))).toEqual([]);
  });

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

  it('stops later Git batches after the response reaches the aggregate row budget', async () => {
    const { document, files } = await createLargeRevisionDocument();
    const trace = [];

    const result = await loadReviewDiffBatches(document, files, trace);

    expect(trace.filter((entry) => entry.args[0] === 'diff')).toHaveLength(3);
    expect(result.bodies.map((body) => body.path)).toEqual(['a.txt', 'b.txt', 'c.txt']);
    expect(result.bodies[0]?.bodyState).toBe('loaded');
    expect(result.bodies[1]?.bodyState).toBe('loaded');
    expect(result.bodies[2]).toMatchObject({
      bodyState: 'too-large',
      limitReason: 'collection-too-many-rows',
    });
    expect(result.bodies.some((body) => body.path === 'd.txt')).toBe(false);
  });
});
