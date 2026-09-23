import { expect, test } from 'bun:test';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExecutionGitResults } from '../../../common/git-execution.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { initializeFixtureRepository, runFixtureGit } from '../../support/git-fixture.js';

for (const executionBackend of ['in-process', 'remote-controller-dials', 'remote-node-dials'] as const) {
  test(`Git link entries and historical reads do not dereference current links (${executionBackend})`, async () => {
    await withIntegrationFixture(`git-links-${executionBackend}`, async fixture => {
      const { client } = fixture;
      const project = fixture.executionDirs.project;
      const target = { nodeId: client.nodeId, project };
      await initializeFixtureRepository(project);
      const outside = join(fixture.dirs.root, 'outside');
      await mkdir(outside);
      await writeFile(join(outside, 'file.txt'), 'outside bytes\n');
      await symlink(join(outside, 'file.txt'), join(project, 'staged-link'));
      await symlink(join(outside, 'missing'), join(project, 'committed-link'));
      await client.post('/api/v1/git/stage-paths', { ...target, paths: ['staged-link'], mode: 'stage' });
      expect(await runFixtureGit(project, 'ls-files', '-s', 'staged-link')).toStartWith('120000 ');
      expect(await runFixtureGit(project, 'show', ':staged-link')).toBe(join(outside, 'file.txt'));
      await client.post('/api/v1/git/commit', { ...target, files: ['committed-link'], message: 'Commit link text' });
      expect(await runFixtureGit(project, 'ls-tree', 'HEAD', 'committed-link')).toStartWith('120000 ');
      expect(await runFixtureGit(project, 'show', 'HEAD:committed-link')).toBe(join(outside, 'missing'));

      await mkdir(join(project, 'dir'));
      await writeFile(join(project, 'dir/file.txt'), 'historical bytes\n');
      await runFixtureGit(project, 'add', 'dir/file.txt');
      await runFixtureGit(project, 'commit', '-m', 'Record historical content');
      await rm(join(project, 'dir'), { recursive: true });
      await symlink(outside, join(project, 'dir'));
      const snapshot = await client.post<ExecutionGitResults['getCommitSnapshot']>('/api/v1/git/history/commit/snapshot', { ...target, commit: 'HEAD', context: 2 });
      if (snapshot.status !== 'ready') throw new Error('Expected commit');
      const document = { nodeId: client.nodeId, instanceId: snapshot.instanceId, documentId: snapshot.documentId };
      const bodies = await client.post<ExecutionGitResults['getReviewDocumentFileBodies']>('/api/v1/git/review-documents/files', { ...target, document, files: ['dir/file.txt'], purpose: 'visible' });
      if (bodies.status !== 'ready') throw new Error('Expected historical review');
      expect(bodies.files['dir/file.txt'].patch).toContain('+historical bytes');
      const query = new URLSearchParams({ ...target, file: 'dir/file.txt', ref: 'HEAD', limit: '1' });
      expect(await client.get(`/api/v1/git/blame?${query}`)).toMatchObject({ lines: [{ content: 'historical bytes' }] });
      await expect(client.post('/api/v1/git/stage-paths', { ...target, paths: ['dir/file.txt'], mode: 'stage' })).rejects.toMatchObject({ status: 403, body: { errorCode: 'GIT_OUTSIDE_BASE' } });
      await expect(client.get(`/api/v1/git/conflict-details?${new URLSearchParams({ ...target, file: 'dir/file.txt' })}`)).rejects.toMatchObject({ status: 403, body: { errorCode: 'GIT_OUTSIDE_BASE' } });
      for (const destination of [outside, join(outside, 'missing')]) {
        await rm(join(project, 'dir'));
        await symlink(destination, join(project, 'dir'));
        const working = await client.post<ExecutionGitResults['getWorkbenchSnapshot']>('/api/v1/git/workbench/snapshot', { ...target, mode: 'working', context: 2 });
        if (working.status !== 'ready') throw new Error('Expected working snapshot');
        const deletion = await client.post<ExecutionGitResults['getReviewDocumentFileBodies']>('/api/v1/git/review-documents/files', {
          ...target, document: { nodeId: client.nodeId, instanceId: working.instanceId, documentId: working.reviewSummary.documentId },
          files: ['dir/file.txt'], purpose: 'visible',
        });
        if (deletion.status !== 'ready') throw new Error('Expected deletion review');
        expect(deletion.files['dir/file.txt'].patch).toContain('-historical bytes');
        expect(deletion.files['dir/file.txt'].patch).not.toContain('outside bytes');
      }
    }, { executionBackend, projectRoots: 'separate' });
  }, 60_000);
}
