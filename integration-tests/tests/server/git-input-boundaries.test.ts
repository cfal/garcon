import { expect, test } from 'bun:test';
import { readFile, readlink, symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExecutionGitResults } from '../../../common/git-execution.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { initializeFixtureRepository, runFixtureGit } from '../../support/git-fixture.js';

for (const executionBackend of ['in-process', 'remote-controller-dials', 'remote-executor-dials'] as const) {
  test(`large selections and missing projects preserve Git HTTP contracts (${executionBackend})`, async () => {
    await withIntegrationFixture(`git-input-${executionBackend}`, async fixture => {
      const { client } = fixture;
      const project = fixture.executionDirs.project;
      const target = { executorId: client.executorId, project };
      await initializeFixtureRepository(project);
      const files = Array.from({ length: 6000 }, (_, index) => `file-${index.toString().padStart(6, '0')}-${'x'.repeat(29)}.txt`);
      for (let offset = 0; offset < files.length; offset += 32) {
        await Promise.all(files.slice(offset, offset + 32).map(file => writeFile(join(project, file), 'synthetic\n')));
      }
      expect(await client.post('/api/v1/git/stage-paths', { ...target, paths: files, mode: 'stage' })).toMatchObject({ success: true });
      expect((await runFixtureGit(project, 'diff', '--cached', '--name-only', '-z')).split('\0').filter(Boolean).sort()).toEqual([...files].sort());
      expect(await client.post('/api/v1/git/commit', { ...target, files, message: 'Selected synthetic files' })).toMatchObject({ success: true });
      expect((await runFixtureGit(project, 'diff-tree', '--no-commit-id', '--name-only', '-r', '-z', 'HEAD')).split('\0').filter(Boolean).sort()).toEqual([...files].sort());
      expect(await runFixtureGit(project, 'rev-list', '--count', 'HEAD')).toBe('2\n');
      await expect(client.post('/api/v1/git/stage-paths', { ...target, paths: Array(2000).fill('x'.repeat(3000)), mode: 'stage' }))
        .rejects.toMatchObject({ status: 413, body: { errorCode: 'GIT_REQUEST_TOO_LARGE' } });

      const missingPaths = ['missing', 'example.txt/nested'];
      if (process.platform !== 'win32') {
        await symlink('missing-target', join(project, 'dangling-project'));
        missingPaths.push('dangling-project');
      }
      for (const missing of missingPaths) {
        const absent = { ...target, project: join(project, missing) };
        expect(await client.post<ExecutionGitResults['getQuickSummary']>('/api/v1/git/quick-summary', absent)).toMatchObject({ status: 'not-git-repository' });
        expect(await client.post<ExecutionGitResults['getWorkingTreeFingerprint']>('/api/v1/git/working-tree/fingerprint', absent)).toMatchObject({ status: 'not-git-repository' });
        expect(await client.post<ExecutionGitResults['getWorkbenchSnapshot']>('/api/v1/git/workbench/snapshot', { ...absent, mode: 'working', context: 2 })).toMatchObject({ status: 'not-git-repository' });
        await expect(client.get(`/api/v1/git/status?${new URLSearchParams(absent)}`))
          .rejects.toMatchObject({ status: 400, body: { errorCode: 'GIT_NOT_REPO', error: 'Git project directory is unavailable' } });
      }

      if (process.platform !== 'win32') {
        await symlink('example.txt', join(project, 'link'));
        await runFixtureGit(project, 'add', 'link');
        await runFixtureGit(project, 'commit', '-m', 'Synthetic symlink');
        for (const destination of ['absent', '../outside']) {
          await unlink(join(project, 'link'));
          await symlink(destination, join(project, 'link'));
          expect(await client.post('/api/v1/git/discard', { ...target, file: 'link' })).toMatchObject({ success: true });
          expect(await readlink(join(project, 'link'))).toBe('example.txt');
          expect(await readFile(join(project, 'example.txt'), 'utf8')).toBe('initial\n');
        }
      }
    }, { executionBackend, projectRoots: 'separate' });
  }, 90_000);
}
