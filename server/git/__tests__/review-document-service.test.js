import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createGitService } from '../git-service.js';
import { GitReviewDocumentRegistry } from '../review-document-registry.js';
import { createReviewDocumentOperations } from '../review-document-service.js';

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

async function createRepository(paths = ['a.txt', 'b.txt']) {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-review-document-'));
  temporaryDirectories.push(projectPath);
  await git(projectPath, ['init']);
  await git(projectPath, ['config', 'user.email', 'test@example.com']);
  await git(projectPath, ['config', 'user.name', 'Test User']);
  await Promise.all(
    paths.map((pathname) => fs.writeFile(path.join(projectPath, pathname), `initial ${pathname}\n`)),
  );
  await git(projectPath, ['add', '.']);
  await git(projectPath, ['commit', '-m', 'initial']);
  return projectPath;
}

function createService() {
  return createGitService({
    agents: { runSingleQuery: async () => 'chore: test' },
    classifyGitError: (error) => ({
      code: 'UNKNOWN',
      status: 500,
      message: error instanceof Error ? error.message : String(error),
    }),
  });
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('Git review documents', () => {
  it('loads multiple revision files through one compact body batch', async () => {
    const projectPath = await createRepository();
    const service = createService();
    const base = await git(projectPath, ['rev-parse', 'HEAD']);
    await fs.writeFile(path.join(projectPath, 'a.txt'), 'changed a\n');
    await fs.writeFile(path.join(projectPath, 'b.txt'), 'changed b\n');
    await git(projectPath, ['add', '.']);
    await git(projectPath, ['commit', '-m', 'change']);
    const target = await git(projectPath, ['rev-parse', 'HEAD']);
    const snapshot = await service.getComparisonSnapshot({
      projectPath,
      from: { kind: 'revision', revision: base },
      to: { kind: 'revision', revision: target },
      mode: 'direct',
      context: 3,
    });
    expect(snapshot.status).toBe('ready');
    if (snapshot.status !== 'ready') return;
    const trace = [];

    const response = await service.getReviewDocumentFileBodies({
      projectPath,
      documentId: snapshot.documentId,
      files: ['a.txt', 'b.txt'],
      purpose: 'visible',
      trace,
    });

    expect(response.status).toBe('ready');
    if (response.status !== 'ready') return;
    expect(trace.filter((entry) => entry.args[0] === 'diff')).toHaveLength(1);
    expect(response.files['a.txt'].patch).toContain('+changed a');
    expect(response.files['a.txt'].rows).toBeUndefined();

    const cacheTrace = [];
    const cached = await service.getReviewDocumentFileBodies({
      projectPath,
      documentId: snapshot.documentId,
      files: ['a.txt', 'b.txt'],
      purpose: 'visible',
      trace: cacheTrace,
    });
    expect(cached.status).toBe('ready');
    expect(cacheTrace.filter((entry) => entry.args[0] === 'diff')).toHaveLength(0);
  });

  it('caps cached responses without caching collection-limit sentinels', async () => {
    const paths = ['a.txt', 'b.txt', 'c.txt', 'd.txt'];
    const projectPath = await createRepository(paths);
    const service = createService();
    const base = await git(projectPath, ['rev-parse', 'HEAD']);
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
    const target = await git(projectPath, ['rev-parse', 'HEAD']);
    const snapshot = await service.getComparisonSnapshot({
      projectPath,
      from: { kind: 'revision', revision: base },
      to: { kind: 'revision', revision: target },
      mode: 'direct',
      context: 3,
    });
    expect(snapshot.status).toBe('ready');
    if (snapshot.status !== 'ready') return;

    const first = await service.getReviewDocumentFileBodies({
      projectPath,
      documentId: snapshot.documentId,
      files: paths,
      purpose: 'visible',
    });
    expect(first.status).toBe('ready');
    if (first.status !== 'ready') return;
    expect(first.files['c.txt']).toMatchObject({
      bodyState: 'too-large',
      limitReason: 'collection-too-many-rows',
    });
    expect(first.files['d.txt']).toBeUndefined();

    const retryTrace = [];
    const retried = await service.getReviewDocumentFileBodies({
      projectPath,
      documentId: snapshot.documentId,
      files: ['c.txt'],
      purpose: 'visible',
      trace: retryTrace,
    });
    expect(retried.status).toBe('ready');
    if (retried.status !== 'ready') return;
    expect(retried.files['c.txt']?.bodyState).toBe('loaded');
    expect(retryTrace.filter((entry) => entry.args[0] === 'diff')).toHaveLength(1);

    const cachedTrace = [];
    const cached = await service.getReviewDocumentFileBodies({
      projectPath,
      documentId: snapshot.documentId,
      files: ['a.txt', 'b.txt', 'c.txt'],
      purpose: 'visible',
      trace: cachedTrace,
    });
    expect(cached.status).toBe('ready');
    if (cached.status !== 'ready') return;
    expect(cached.files['c.txt']).toMatchObject({
      bodyState: 'too-large',
      limitReason: 'collection-too-many-rows',
    });
    expect(cachedTrace.filter((entry) => entry.args[0] === 'diff')).toHaveLength(0);
  });

  it('retries transient body errors instead of caching them', async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-review-document-'));
    temporaryDirectories.push(projectPath);
    const registry = new GitReviewDocumentRegistry();
    const document = registry.register({
      sourceCacheKey: 'comparison:transient-body',
      projectPath,
      repoRoot: projectPath,
      context: 3,
      source: {
        kind: 'comparison-revisions',
        effectiveFromHash: 'base',
        toHash: 'target',
      },
      files: [{
        path: 'retry.txt',
        change: { kind: 'tree-diff', status: 'added', rawStatus: '?' },
        category: 'untracked',
        additions: 1,
        deletions: 0,
        estimatedRows: 2,
        bodyState: 'unloaded',
        bodyFingerprint: 'fingerprint:retry.txt',
        isBinary: false,
        isTooLarge: false,
      }],
    });
    const operations = createReviewDocumentOperations(registry);
    const options = {
      projectPath,
      documentId: document.id,
      files: ['retry.txt'],
      purpose: 'visible',
    };

    const failed = await operations.getReviewDocumentFileBodies(options);
    expect(failed.status).toBe('ready');
    if (failed.status !== 'ready') return;
    expect(failed.files['retry.txt']).toMatchObject({ bodyState: 'error' });

    await fs.writeFile(path.join(projectPath, 'retry.txt'), 'available now\n');
    const retried = await operations.getReviewDocumentFileBodies(options);
    expect(retried.status).toBe('ready');
    if (retried.status !== 'ready') return;
    expect(retried.files['retry.txt']).toMatchObject({ bodyState: 'loaded' });
    expect(retried.files['retry.txt'].patch).toContain('+available now');
  });

  it('validates only requested working-tree paths', async () => {
    const projectPath = await createRepository();
    const service = createService();
    await fs.writeFile(path.join(projectPath, 'a.txt'), 'changed a\n');
    await fs.writeFile(path.join(projectPath, 'b.txt'), 'changed b\n');
    const snapshot = await service.getComparisonSnapshot({
      projectPath,
      from: { kind: 'revision', revision: 'HEAD' },
      to: { kind: 'working-tree' },
      mode: 'direct',
      context: 3,
    });
    expect(snapshot.status).toBe('ready');
    if (snapshot.status !== 'ready') return;

    await fs.writeFile(path.join(projectPath, 'b.txt'), 'changed b again\n');
    const unrelated = await service.getReviewDocumentFileBodies({
      projectPath,
      documentId: snapshot.documentId,
      files: ['a.txt'],
      purpose: 'visible',
    });
    expect(unrelated.status).toBe('ready');

    await fs.writeFile(path.join(projectPath, 'a.txt'), 'changed a again\n');
    const changed = await service.getReviewDocumentFileBodies({
      projectPath,
      documentId: snapshot.documentId,
      files: ['a.txt'],
      purpose: 'visible',
    });
    expect(changed).toMatchObject({ status: 'stale', changedPaths: ['a.txt'] });
  });

  it('validates the source path of a mutable rename', async () => {
    const projectPath = await createRepository();
    const service = createService();
    await git(projectPath, ['mv', 'a.txt', 'renamed.txt']);
    const snapshot = await service.getComparisonSnapshot({
      projectPath,
      from: { kind: 'revision', revision: 'HEAD' },
      to: { kind: 'working-tree' },
      mode: 'direct',
      context: 3,
    });
    expect(snapshot.status).toBe('ready');
    if (snapshot.status !== 'ready') return;
    expect(snapshot.files).toContainEqual(
      expect.objectContaining({ path: 'renamed.txt', originalPath: 'a.txt' }),
    );

    await fs.writeFile(path.join(projectPath, 'a.txt'), 'recreated source path\n');
    const response = await service.getReviewDocumentFileBodies({
      projectPath,
      documentId: snapshot.documentId,
      files: ['renamed.txt'],
      purpose: 'visible',
    });

    expect(response).toMatchObject({
      status: 'stale',
      changedPaths: ['a.txt'],
    });
  });

  it('keeps staged bodies valid across worktree-only edits', async () => {
    const projectPath = await createRepository();
    const service = createService();
    await fs.writeFile(path.join(projectPath, 'a.txt'), 'staged a\n');
    await git(projectPath, ['add', 'a.txt']);
    const snapshot = await service.getWorkbenchSnapshot({
      projectPath,
      mode: 'staged',
      context: 3,
    });
    expect(snapshot.status).toBe('ready');
    if (snapshot.status !== 'ready') return;

    await fs.writeFile(path.join(projectPath, 'a.txt'), 'worktree a\n');
    const response = await service.getReviewDocumentFileBodies({
      projectPath,
      documentId: snapshot.reviewSummary.documentId,
      files: ['a.txt'],
      purpose: 'visible',
    });

    expect(response.status).toBe('ready');
    if (response.status === 'ready') expect(response.files['a.txt'].patch).toContain('+staged a');
  });

  it('returns a typed response for an expired document', async () => {
    const projectPath = await createRepository();
    const response = await createService().getReviewDocumentFileBodies({
      projectPath,
      documentId: 'missing',
      files: ['a.txt'],
      purpose: 'visible',
    });

    expect(response).toMatchObject({ status: 'document-expired', documentId: 'missing' });
  });

  it('rejects files outside the registered review', async () => {
    const projectPath = await createRepository();
    const service = createService();
    await fs.writeFile(path.join(projectPath, 'a.txt'), 'changed a\n');
    const snapshot = await service.getWorkbenchSnapshot({
      projectPath,
      mode: 'working',
      context: 3,
    });
    expect(snapshot.status).toBe('ready');
    if (snapshot.status !== 'ready') return;

    await expect(service.getReviewDocumentFileBodies({
      projectPath,
      documentId: snapshot.reviewSummary.documentId,
      files: ['not-in-review.txt'],
      purpose: 'visible',
    })).rejects.toThrow('does not contain not-in-review.txt');
  });

  it('does not follow untracked symbolic links while loading bodies', async () => {
    const projectPath = await createRepository();
    const service = createService();
    await fs.symlink('a.txt', path.join(projectPath, 'linked.txt'));
    const snapshot = await service.getWorkbenchSnapshot({
      projectPath,
      mode: 'working',
      context: 3,
    });
    expect(snapshot.status).toBe('ready');
    if (snapshot.status !== 'ready') return;

    const response = await service.getReviewDocumentFileBodies({
      projectPath,
      documentId: snapshot.reviewSummary.documentId,
      files: ['linked.txt'],
      purpose: 'visible',
    });

    expect(response.status).toBe('ready');
    if (response.status !== 'ready') return;
    expect(response.files['linked.txt']).toMatchObject({
      bodyState: 'too-large',
      limitReason: 'unsupported-file-kind',
      patch: null,
    });
  });

  it('keeps conflicted workbench files terminal instead of parsing combined diffs', async () => {
    const projectPath = await createRepository();
    const service = createService();
    const baseBranch = await git(projectPath, ['branch', '--show-current']);
    await git(projectPath, ['checkout', '-b', 'other']);
    await fs.writeFile(path.join(projectPath, 'a.txt'), 'other\n');
    await git(projectPath, ['commit', '-am', 'other']);
    await git(projectPath, ['checkout', baseBranch]);
    await fs.writeFile(path.join(projectPath, 'a.txt'), 'current\n');
    await git(projectPath, ['commit', '-am', 'current']);
    const merge = Bun.spawn(['git', 'merge', 'other'], {
      cwd: projectPath,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(await merge.exited).not.toBe(0);

    const snapshot = await service.getWorkbenchSnapshot({
      projectPath,
      mode: 'working',
      context: 3,
    });
    expect(snapshot.status).toBe('ready');
    if (snapshot.status !== 'ready') return;
    expect(snapshot.reviewSummary.files).toContainEqual(
      expect.objectContaining({
        path: 'a.txt',
        bodyState: 'too-large',
        limitReason: 'unsupported-file-kind',
      }),
    );
  });

  it('loads renamed revision files through their registered source paths', async () => {
    const projectPath = await createRepository();
    const service = createService();
    const base = await git(projectPath, ['rev-parse', 'HEAD']);
    await git(projectPath, ['mv', 'a.txt', 'renamed.txt']);
    await git(projectPath, ['commit', '-am', 'rename']);
    const target = await git(projectPath, ['rev-parse', 'HEAD']);
    const snapshot = await service.getComparisonSnapshot({
      projectPath,
      from: { kind: 'revision', revision: base },
      to: { kind: 'revision', revision: target },
      mode: 'direct',
      context: 3,
    });
    expect(snapshot.status).toBe('ready');
    if (snapshot.status !== 'ready') return;
    const renamed = snapshot.files.find((file) => file.path === 'renamed.txt');
    expect(renamed?.originalPath).toBe('a.txt');

    const response = await service.getReviewDocumentFileBodies({
      projectPath,
      documentId: snapshot.documentId,
      files: ['renamed.txt'],
      purpose: 'visible',
    });

    expect(response.status).toBe('ready');
    if (response.status !== 'ready') return;
    expect(response.files['renamed.txt'].patch).toContain('rename from a.txt');
    expect(response.files['renamed.txt'].patch).toContain('rename to renamed.txt');
  });
});
