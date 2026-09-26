import { expect, test } from 'bun:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { GIT_MAX_RESULT_BYTES, type ExecutionGitResults } from '../../../common/git-execution.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { initializeFixtureRepository, runFixtureGit } from '../../support/git-fixture.js';

for (const executionBackend of ['in-process', 'remote-controller-dials', 'remote-executor-dials'] as const) {
  test.skipIf(process.platform === 'win32')(`bounded Git results survive large internal status reads (${executionBackend})`, async () => {
    await withIntegrationFixture(`git-output-limits-${executionBackend}`, async fixture => {
      const { client, executionDirs } = fixture;
      const project = executionDirs.project;
      await initializeFixtureRepository(project);
      await writeFile(join(project, 'example.txt'), 'modified\n');
      const directory = join(project, ...Array.from({ length: 4 }, (_, i) => `generated-${i}-${'x'.repeat(190)}`));
      await mkdir(directory, { recursive: true });
      for (let start = 0; start < 4608; start += 64) {
        await Promise.all(Array.from({ length: 64 }, (_, i) =>
          writeFile(join(directory, `${'x'.repeat(120)}-${start + i}.txt`), '')));
      }
      const status = await runFixtureGit(project, 'status', '--porcelain=v1', '-z', '-uall');
      expect(Buffer.byteLength(status)).toBeGreaterThan(GIT_MAX_RESULT_BYTES);
      const target = { executorId: client.executorId, project };
      const query = new URLSearchParams(target);
      expect(await client.get(`/api/v1/git/conflicts?${query}`)).toMatchObject({ conflicts: [] });
      const summary = await client.post<ExecutionGitResults['getQuickSummary']>('/api/v1/git/quick-summary', target);
      expect(summary.status).toBe('ready');
      expect(Buffer.byteLength(JSON.stringify(summary))).toBeLessThan(GIT_MAX_RESULT_BYTES);
      await client.post('/api/v1/git/discard', { ...target, file: 'example.txt' });
      expect(await readFile(join(project, 'example.txt'), 'utf8')).toBe('initial\n');
      // Unbounded status inventory still fails at the serialized response boundary.
      await expect(client.get(`/api/v1/git/status?${query}`)).rejects.toMatchObject({
        body: { errorCode: 'GIT_RESULT_TOO_LARGE' },
      });
    }, { executionBackend, projectRoots: 'separate' });
  }, 60_000);
}
