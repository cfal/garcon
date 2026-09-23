import { expect, test } from 'bun:test';
import { chmod, copyFile, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExecutionGhResults } from '../../../common/git-execution.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { initializeFixtureRepository } from '../../support/git-fixture.js';

for (const executionBackend of ['in-process', 'remote-controller-dials', 'remote-node-dials'] as const) {
  test(`GitHub HTTP uses the node environment and bounded transfers (${executionBackend})`, async () => {
    await withIntegrationFixture(`gh-http-${executionBackend}`, async fixture => {
      const nodeId = fixture.client.nodeId;
      const project = fixture.executionDirs.project;
      await initializeFixtureRepository(project);
      const query = new URLSearchParams({ nodeId, project });
      const status = await fixture.client.get<ExecutionGhResults['getStatus']>(`/api/v1/gh/status?nodeId=${nodeId}`);
      expect(status).toMatchObject({ nodeId, available: true, login: 'synthetic-worker' });
      expect(status.instanceId).toBeString();
      expect(status.instanceId.length).toBeGreaterThan(0);
      const scope = { nodeId, instanceId: status.instanceId };
      const list = await fixture.client.get<ExecutionGhResults['listPullRequests']>(`/api/v1/gh/pull-requests?${query}`);
      expect(list).toMatchObject(scope);
      expect(list.repo?.nameWithOwner).toBe('synthetic-worker/repository');
      const detail = await fixture.client.get<ExecutionGhResults['getPullRequest']>(`/api/v1/gh/pull-request?${query}&number=1`);
      expect(detail).toMatchObject(scope);
      expect(detail.body.length).toBe(17 * 1024 * 1024);
      expect(detail.fileBodies['example.txt'].patch).toContain('+changed');
      expect(detail.threads).toEqual([]);
      if (nodeId !== 'local') {
        expect(await fixture.client.get('/api/v1/gh/status?nodeId=local')).toMatchObject({ nodeId: 'local', instanceId: expect.any(String), available: false });
        await expect(fixture.client.get(`/api/v1/gh/pull-requests?${new URLSearchParams({ nodeId, project: fixture.dirs.project })}`)).rejects.toMatchObject({ status: 403 });
      }
      await rm(join(fixture.dirs.root, 'gh-bin', 'gh'));
      expect(await fixture.client.get(`/api/v1/gh/status?nodeId=${nodeId}`)).toMatchObject({ ...scope, available: false, reason: 'gh_missing' });
    }, {
      executionBackend, projectRoots: 'separate',
      resolveServerEnvironment: dirs => ({ PATH: join(dirs.root, 'gh-bin') }),
      prepareWorkspace: async dirs => {
        const bin = join(dirs.root, 'gh-bin');
        await mkdir(bin);
        await copyFile(new URL('../../../server/execution-nodes/__tests__/fixtures/fake-gh.js', import.meta.url), join(bin, 'gh'));
        await chmod(join(bin, 'gh'), 0o755);
        await symlink(process.execPath, join(bin, 'bun'));
        await symlink(Bun.which('git')!, join(bin, 'git'));
        await writeFile(join(dirs.project, 'gh-fixture.json'), JSON.stringify({ label: 'synthetic-worker', bodyBytes: 17 * 1024 * 1024, commentsFail: true }));
      },
    });
  }, 60_000);
}
