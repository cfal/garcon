import { expect, test } from 'bun:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExecutionGitResults, GitReviewDocumentRef } from '../../../common/git-execution.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { initializeFixtureRepository, runFixtureGit } from '../../support/git-fixture.js';

for (const executionBackend of ['in-process', 'remote-controller-dials', 'remote-node-dials'] as const) {
  test(`Git HTTP reads, staging, mutations and documents belong to the selected node (${executionBackend})`, async () => {
    await withIntegrationFixture(`git-http-${executionBackend}`, async fixture => {
      const { client } = fixture;
      const nodeId = client.nodeId;
      const project = fixture.executionDirs.project;
      const target = { nodeId, project };
      const query = new URLSearchParams(target);
      await initializeFixtureRepository(project);
      if (nodeId !== 'local') await initializeFixtureRepository(fixture.dirs.project);
      const head = await runFixtureGit(project, 'rev-parse', 'HEAD');
      const file = '-literal [file].txt';
      await writeFile(join(project, file), 'no newline');
      const status = await client.get<ExecutionGitResults['getStatus']>(`/api/v1/git/status?${query}`);
      expect(status).toMatchObject({ nodeId, branch: 'main', untracked: [file] });
      const snapshot = await client.post<ExecutionGitResults['getWorkbenchSnapshot']>('/api/v1/git/workbench/snapshot', { ...target, mode: 'working', context: 5 });
      if (snapshot.status !== 'ready') throw new Error('Expected workbench');
      const document: GitReviewDocumentRef = { nodeId, instanceId: snapshot.instanceId, documentId: snapshot.reviewSummary.documentId };
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
      if (nodeId !== 'local') expect(await runFixtureGit(fixture.dirs.project, 'rev-list', '--count', 'HEAD')).toBe('1\n');

      const history = await client.post<ExecutionGitResults['getHistoryCommits']>('/api/v1/git/history/commits', { ...target });
      expect(history.commits).toHaveLength(2);
      const comparison = await client.post<ExecutionGitResults['getComparisonSnapshot']>('/api/v1/git/comparisons/snapshot', { ...target, from: { kind: 'revision', revision: head.trim() }, to: { kind: 'revision', revision: 'HEAD' }, mode: 'direct' });
      expect(comparison).toMatchObject({ nodeId, status: 'ready', files: [{ path: file }] });
      expect(await client.get(`/api/v1/git/file-history?${query}&file=${encodeURIComponent(file)}`)).toMatchObject({ nodeId, commits: [{ subject: 'Commit exact displayed bytes' }] });
      expect(await client.get(`/api/v1/git/blame?${query}&file=${encodeURIComponent(file)}`)).toMatchObject({ nodeId, lines: [{ content: 'no newline' }] });
      expect(await client.get(`/api/v1/git/refs?${query}`)).toMatchObject({ nodeId, refs: [{ name: 'main' }] });

      const worktreePath = join(project, 'linked');
      await client.post('/api/v1/git/worktrees/create', { ...target, worktreePath, branch: 'linked' });
      const worktrees = await client.get<ExecutionGitResults['getWorktrees']>(`/api/v1/git/worktrees?${query}`);
      expect(worktrees.worktrees.some(item => item.path === worktreePath)).toBe(true);
      await client.post('/api/v1/git/worktrees/remove', { ...target, worktreePath });
      const outside = join(fixture.dirs.root, 'outside');
      await mkdir(outside);
      await expect(client.post('/api/v1/git/worktrees/create', { ...target, worktreePath: join(outside, 'escape'), branch: 'escape' })).rejects.toMatchObject({ status: 403 });
      await expect(client.get(`/api/v1/git/status?${query}&nodeId=local`)).rejects.toMatchObject({ status: 400 });
      await expect(client.post('/api/v1/git/commit-index', { ...target, message: 'not dispatched', shell: 'unexpected' })).rejects.toMatchObject({ status: 400 });

      if (nodeId !== 'local') {
        await expect(client.get(`/api/v1/git/status?${new URLSearchParams({ nodeId, project: fixture.dirs.project })}`)).rejects.toMatchObject({ status: 403 });
        await fixture.crashAndRestartExecutionWorker();
        await expect(client.post('/api/v1/git/review-documents/files', { ...target, document, files: [file], purpose: 'visible' })).rejects.toMatchObject({ status: 409, body: { errorCode: 'GIT_STALE_DOCUMENT' } });
        expect(await client.get(`/api/v1/git/status?${query}`)).toMatchObject({ nodeId, branch: 'main' });
      }
    }, { executionBackend, projectRoots: 'separate' });
  }, 60_000);
}
