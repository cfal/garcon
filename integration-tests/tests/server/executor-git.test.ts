import { expect, test } from 'bun:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExecutionGitResults, GitReviewDocumentRef } from '../../../common/git-execution.js';
import { GIT_MAX_RESULT_BYTES } from '../../../common/git-execution.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { initializeFixtureRepository, runFixtureGit } from '../../support/git-fixture.js';

for (const executionBackend of ['in-process', 'remote-controller-dials', 'remote-executor-dials'] as const) {
  test(`Git review loads bounded files independently without exhausting the document (${executionBackend})`, async () => {
    await withIntegrationFixture(`git-body-limit-${executionBackend}`, async fixture => {
      const { client } = fixture;
      const project = fixture.executionDirs.project;
      const target = { executorId: client.executorId, project };
      await initializeFixtureRepository(project);
      const plain = `${'x'.repeat(9999)}\n`.repeat(250);
      for (const [file, content] of [['a.txt', plain], ['b.txt', plain], ['escaped.txt', plain.replaceAll('x', '\t')], ['small.txt', 'small change\n']]) {
        await writeFile(join(project, file), content);
      }
      const snapshot = await client.post<ExecutionGitResults['getWorkbenchSnapshot']>('/api/v1/git/workbench/snapshot', { ...target, mode: 'working', context: 5 });
      if (snapshot.status !== 'ready') throw new Error('Expected workbench');
      expect(snapshot.reviewSummary.limits.maxLoadedPatchBytes).toBe(10_000_000);
      const document: GitReviewDocumentRef = { executorId: client.executorId, instanceId: snapshot.instanceId, documentId: snapshot.reviewSummary.documentId };
      let loadedBytes = 0;
      for (const file of ['a.txt', 'b.txt', 'escaped.txt', 'small.txt']) {
        const response = await client.post<ExecutionGitResults['getReviewDocumentFileBodies']>('/api/v1/git/review-documents/files', { ...target, document, files: [file], purpose: 'visible' });
        if (response.status !== 'ready') throw new Error('Expected ready review body');
        expect(response.errors).toEqual({});
        const body = response.files[file];
        expect(body.bodyState).toBe(file === 'escaped.txt' ? 'too-large' : 'loaded');
        expect(body.limitReason).toBe(file === 'escaped.txt' ? 'file-too-many-bytes' : undefined);
        loadedBytes += body.patchBytes;
      }
      expect(loadedBytes).toBeGreaterThan(GIT_MAX_RESULT_BYTES);
    }, { executionBackend, projectRoots: 'separate' });
  }, 60_000);

  test(`Git HTTP rejects oversized results without retiring the executor (${executionBackend})`, async () => {
    await withIntegrationFixture(`git-result-limit-${executionBackend}`, async fixture => {
      const { client } = fixture;
      const project = fixture.executionDirs.project;
      const target = { executorId: client.executorId, project };
      await initializeFixtureRepository(project);
      const message = join(project, '.git', 'oversized-message');
      await writeFile(message, 'x'.repeat(GIT_MAX_RESULT_BYTES));
      await runFixtureGit(project, 'commit', '--allow-empty', '-q', '-F', message);
      await expect(client.post('/api/v1/git/history/commits', target))
        .rejects.toMatchObject({ status: 413, body: { errorCode: 'GIT_RESULT_TOO_LARGE' } });
      expect(await client.get(`/api/v1/git/status?${new URLSearchParams(target)}`))
        .toMatchObject({ executorId: client.executorId, branch: 'main' });
    }, { executionBackend, projectRoots: 'separate' });
  }, 60_000);

  test(`Git HTTP reads, staging, mutations and documents belong to the selected executor (${executionBackend})`, async () => {
    await withIntegrationFixture(`git-http-${executionBackend}`, async fixture => {
      const { client } = fixture;
      const executorId = client.executorId;
      const project = fixture.executionDirs.project;
      const target = { executorId, project };
      const query = new URLSearchParams(target);
      await initializeFixtureRepository(project);
      if (executorId !== 'local') await initializeFixtureRepository(fixture.dirs.project);
      const head = await runFixtureGit(project, 'rev-parse', 'HEAD');
      const file = '-literal [file].txt';
      await writeFile(join(project, file), 'no newline');
      const status = await client.get<ExecutionGitResults['getStatus']>(`/api/v1/git/status?${query}`);
      expect(status).toMatchObject({ executorId, branch: 'main', untracked: [file] });
      const snapshot = await client.post<ExecutionGitResults['getWorkbenchSnapshot']>('/api/v1/git/workbench/snapshot', { ...target, mode: 'working', context: 5 });
      if (snapshot.status !== 'ready') throw new Error('Expected workbench');
      const document: GitReviewDocumentRef = { executorId, instanceId: snapshot.instanceId, documentId: snapshot.reviewSummary.documentId };
      const bodies = await client.post<ExecutionGitResults['getReviewDocumentFileBodies']>('/api/v1/git/review-documents/files', { ...target, document, files: [file], purpose: 'visible' });
      if (bodies.status !== 'ready') throw new Error('Expected review body');
      const body = bodies.files[file];
      expect(body.patch).toContain('\\ No newline at end of file');
      const stage = { ...target, file, document, bodyFingerprint: body.bodyFingerprint, patchDigest: body.patchDigest, mode: 'stage', hunkIndex: 0, contextLines: 5 };
      await expect(client.post('/api/v1/git/stage-hunk', { ...stage, patchDigest: '0'.repeat(64) })).rejects.toMatchObject({ status: 409, body: { errorCode: 'GIT_STALE_DOCUMENT' } });
      await client.post('/api/v1/git/stage-hunk', stage);
      expect(await runFixtureGit(project, 'show', `:${file}`)).toBe('no newline');
      await client.post('/api/v1/git/commit-index', { ...target, message: 'Commit exact displayed bytes' });
      expect(await readFile(join(project, file), 'utf8')).toBe('no newline');
      expect(await runFixtureGit(project, 'rev-list', '--count', 'HEAD')).toBe('2\n');
      if (executorId !== 'local') expect(await runFixtureGit(fixture.dirs.project, 'rev-list', '--count', 'HEAD')).toBe('1\n');

      const history = await client.post<ExecutionGitResults['getHistoryCommits']>('/api/v1/git/history/commits', { ...target });
      expect(history.commits).toHaveLength(2);
      const comparison = await client.post<ExecutionGitResults['getComparisonSnapshot']>('/api/v1/git/comparisons/snapshot', { ...target, from: { kind: 'revision', revision: head.trim() }, to: { kind: 'revision', revision: 'HEAD' }, mode: 'direct' });
      expect(comparison).toMatchObject({ executorId, status: 'ready', files: [{ path: file }] });
      expect(await client.get(`/api/v1/git/file-history?${query}&file=${encodeURIComponent(file)}`)).toMatchObject({ executorId, commits: [{ subject: 'Commit exact displayed bytes' }] });
      expect(await client.get(`/api/v1/git/blame?${query}&file=${encodeURIComponent(file)}`)).toMatchObject({ executorId, lines: [{ content: 'no newline' }] });
      expect(await client.get(`/api/v1/git/refs?${query}`)).toMatchObject({ executorId, refs: [{ name: 'main' }] });

      const worktreePath = join(project, 'linked');
      await client.post('/api/v1/git/worktrees/create', { ...target, worktreePath, branch: 'linked' });
      const worktrees = await client.get<ExecutionGitResults['getWorktrees']>(`/api/v1/git/worktrees?${query}`);
      expect(worktrees.worktrees.some(item => item.path === worktreePath)).toBe(true);
      await client.post('/api/v1/git/worktrees/remove', { ...target, worktreePath });
      const outside = join(fixture.dirs.root, 'outside');
      await mkdir(outside);
      await expect(client.post('/api/v1/git/worktrees/create', { ...target, worktreePath: join(outside, 'escape'), branch: 'escape' })).rejects.toMatchObject({ status: 403 });
      await expect(client.get(`/api/v1/git/status?${query}&executorId=local`)).rejects.toMatchObject({ status: 400 });
      await expect(client.post('/api/v1/git/commit-index', { ...target, message: 'not dispatched', shell: 'unexpected' })).rejects.toMatchObject({ status: 400 });

      if (executorId !== 'local') {
        await expect(client.get(`/api/v1/git/status?${new URLSearchParams({ executorId, project: fixture.dirs.project })}`)).rejects.toMatchObject({ status: 403 });
        await fixture.crashAndRestartExecutorWorker();
        await expect(client.post('/api/v1/git/review-documents/files', { ...target, document, files: [file], purpose: 'visible' })).rejects.toMatchObject({ status: 409, body: { errorCode: 'GIT_STALE_DOCUMENT' } });
        expect(await client.get(`/api/v1/git/status?${query}`)).toMatchObject({ executorId, branch: 'main' });
      }
    }, { executionBackend, projectRoots: 'separate' });
  }, 60_000);
}
