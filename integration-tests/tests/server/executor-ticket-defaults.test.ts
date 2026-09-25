import { expect, test } from 'bun:test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { withIntegrationFixture } from '../../support/integration-fixture.js';

for (const executionBackend of ['remote-controller-dials', 'remote-executor-dials'] as const) {
  test(`ticket defaults use global repository names on the owning executor (${executionBackend})`, async () => {
    await withIntegrationFixture(`ticket-defaults-${executionBackend}`, async (f) => {
      const resolve = (directory: string, executorId: string) =>
        f.client.post('/api/v1/tickets/project-default', { directory, executorId });
      for (const [root, executorId] of [[f.dirs.project, 'local'], [f.executionDirs.project, f.client.executorId]]) {
        const repo = join(root!, 'shared-repo');
        await mkdir(repo);
        const git = async (...args: string[]) => {
          const child = Bun.spawn(['git', '-c', 'user.name=Synthetic Author', '-c', 'user.email=author@example.invalid', ...args],
            { cwd: repo, stdout: 'pipe', stderr: 'pipe' });
          const [code, , stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
          if (code) throw new Error(stderr);
        };
        await git('init');
        await git('commit', '--allow-empty', '-m', 'Synthetic initial commit');
        const linked = join(root!, 'linked');
        await git('worktree', 'add', '-b', 'synthetic', linked);
        await mkdir(join(linked, 'nested'));
        for (const directory of [repo, linked, join(linked, 'nested')]) {
          expect(await resolve(directory, executorId!)).toEqual({ project: 'shared-repo', kind: 'repository' });
        }
        const folder = join(root!, 'plain');
        await mkdir(folder);
        expect(await resolve(folder, executorId!)).toEqual({ project: 'plain', kind: 'folder' });
      }
      await expect(resolve(f.dirs.project, f.client.executorId))
        .rejects.toMatchObject({ status: 503, body: { errorCode: 'TICKET_PROJECT_UNAVAILABLE' } });
      const bootstrap = await f.client.get<{ storeId: string }>('/api/v1/tickets/bootstrap');
      const request = { expectedStoreId: bootstrap.storeId, requestId: crypto.randomUUID(),
        payload: { action: 'create', input: { title: 'Synthetic ticket', project: '/old/explicit-label' } } };
      await f.client.post('/api/v1/tickets/mutate', request);
      await f.restartGarcon();
      const tickets = await f.client.get<{ items: { project: string }[] }>('/api/v1/tickets');
      expect(tickets.items[0]?.project).toBe('/old/explicit-label');
    }, { executionBackend, projectRoots: 'separate' });
  }, 40_000);
}
