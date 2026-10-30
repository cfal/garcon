import { expect, test } from 'bun:test';
import { chmod, copyFile, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExecutionGhResults } from '../../../common/git-execution.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { initializeFixtureRepository } from '../../support/git-fixture.js';
import { rejectionOf } from '../../support/promise-assertions.js';

for (const executionBackend of ['in-process', 'remote-controller-dials', 'remote-executor-dials'] as const) {
  test(`GitHub HTTP uses the executor environment and bounded results (${executionBackend})`, async () => {
    await withIntegrationFixture(`gh-http-${executionBackend}`, async fixture => {
      const executorId = fixture.client.executorId;
      const project = fixture.executionDirs.project;
      await initializeFixtureRepository(project);
      const query = new URLSearchParams({ executorId, project });
      const status = await fixture.client.get<ExecutionGhResults['getStatus']>(`/api/v1/gh/status?executorId=${executorId}`);
      expect(status).toMatchObject({ executorId, available: true, login: 'synthetic-worker' });
      expect(status.instanceId).toBeString();
      expect(status.instanceId.length).toBeGreaterThan(0);
      const scope = { executorId, instanceId: status.instanceId };
      const list = await fixture.client.get<ExecutionGhResults['listPullRequests']>(`/api/v1/gh/pull-requests?${query}`);
      expect(list).toMatchObject(scope);
      expect(list.repo?.nameWithOwner).toBe('synthetic-worker/repository');
      const pullQuery = new URLSearchParams(query);
      pullQuery.set('repositoryHost', new URL(list.repo!.url).hostname);
      pullQuery.set('repositoryName', list.repo!.nameWithOwner);
      pullQuery.set('number', '1');
      const callsPath = join(project, 'gh-calls.jsonl');
      const takeCalls = async () => {
        const lines = (await Bun.file(callsPath).exists()) ? (await Bun.file(callsPath).text()).trim().split('\n').filter(Boolean) : [];
        await rm(callsPath, { force: true });
        return lines.map(line => (JSON.parse(line) as string[]).slice(0, 2).join(' '));
      };
      const diffQuery = (commits: { baseRefOid: string; headRefOid: string }) => {
        const diffParams = new URLSearchParams(pullQuery);
        diffParams.set('baseRefOid', commits.baseRefOid);
        diffParams.set('headRefOid', commits.headRefOid);
        return `/api/v1/gh/pull-request/diff?${diffParams}`;
      };
      await takeCalls();
      const pullStatus = await fixture.client.get<ExecutionGhResults['getPullRequestStatus']>(`/api/v1/gh/pull-request/status?${pullQuery}`);
      expect(pullStatus).toMatchObject({ ...scope, baseRefOid: 'e'.repeat(40), headRefOid: 'a'.repeat(40) });
      expect(pullStatus.body.length).toBe(1024 * 1024);
      // A status refresh neither reads nor returns the diff or review comments.
      expect(await takeCalls()).toEqual(['repo view', 'pr view']);
      expect(pullStatus).not.toHaveProperty('fileBodies');
      const commits = { baseRefOid: pullStatus.baseRefOid, headRefOid: pullStatus.headRefOid };
      const diff = await fixture.client.get<ExecutionGhResults['getPullRequestDiff']>(diffQuery(commits));
      expect(diff).toMatchObject({ ...scope, ...commits });
      expect(diff.fileBodies['example.txt'].patch).toContain('+changed');
      expect(await takeCalls()).toEqual(['repo view', 'pr view', 'api --hostname', 'pr view']);
      expect(await rejectionOf(fixture.client.get(`/api/v1/gh/pull-request/review-threads?${pullQuery}`))).toMatchObject({ status: 403, body: { errorCode: 'GH_FORBIDDEN' } });
      expect(await rejectionOf(fixture.client.get(diffQuery({ ...commits, headRefOid: 'b'.repeat(40) })))).toMatchObject({ status: 409, body: { errorCode: 'GH_STALE_PULL_REQUEST' } });

      const configPath = join(project, 'gh-fixture.json');
      const specialPath = 'a\tb.txt';
      const movedBase = 'f'.repeat(40);
      await writeFile(configPath, JSON.stringify({
        label: 'synthetic-worker',
        pulls: [{ number: 1, baseRefOid: movedBase }],
        commentPages: [
          [{ id: 1, path: specialPath, line: 1, side: 'RIGHT', body: 'first page' }],
          [{ id: 2, path: specialPath, line: 2, side: 'RIGHT', body: 'second page' }],
        ],
        diff: 'diff --git "a/a\\tb.txt" "b/a\\tb.txt"\n--- "a/a\\tb.txt"\n+++ "b/a\\tb.txt"\n@@ -1 +1 @@\n--- i;\n+++ i;\n',
        files: [{ path: specialPath, additions: 1, deletions: 1 }],
      }));
      await takeCalls();
      const moved = await fixture.client.get<ExecutionGhResults['getPullRequestStatus']>(`/api/v1/gh/pull-request/status?${pullQuery}`);
      expect(moved.baseRefOid).toBe(movedBase);
      const named = await fixture.client.get<ExecutionGhResults['getPullRequestDiff']>(diffQuery({ ...commits, baseRefOid: movedBase }));
      expect(named.files).toMatchObject([{ path: specialPath }]);
      expect(Object.keys(named.fileBodies)).toEqual([specialPath]);
      expect(named.fileBodies[specialPath].patch).toContain('+++ i;');
      // The executor keeps the diff of each commit pair it read and proves access with one light read.
      await takeCalls();
      expect((await fixture.client.get<ExecutionGhResults['getPullRequestDiff']>(diffQuery({ ...commits, baseRefOid: movedBase }))).fileBodies[specialPath].patch).toContain('+++ i;');
      expect(await takeCalls()).toEqual(['repo view', 'pr view']);
      const threads = await fixture.client.get<ExecutionGhResults['getPullRequestReviewThreads']>(`/api/v1/gh/pull-request/review-threads?${pullQuery}`);
      expect(threads).toMatchObject(scope);
      expect(threads.threads.flatMap(thread => thread.comments.map(comment => comment.body))).toEqual(['first page', 'second page']);
      await writeFile(configPath, JSON.stringify({ label: 'synthetic-worker', bodyBytes: 4 * 1024 * 1024 }));
      expect(await rejectionOf(fixture.client.get(`/api/v1/gh/pull-request/status?${pullQuery}`))).toMatchObject({ status: 413, body: { errorCode: 'GIT_RESULT_TOO_LARGE' } });
      const limitedBase = 'd'.repeat(40);
      const largeDiff = `diff --git a/example.txt b/example.txt\n--- a/example.txt\n+++ b/example.txt\n@@ -0,0 +1,350 @@\n${`+${'\t'.repeat(9999)}\n`.repeat(350)}`
        + 'diff --git a/small.txt b/small.txt\n--- a/small.txt\n+++ b/small.txt\n@@ -1 +1 @@\n-old\n+small change\n';
      await writeFile(configPath, JSON.stringify({ label: 'synthetic-worker', diff: largeDiff, pulls: [{ number: 1, baseRefOid: limitedBase }] }));
      const limited = await fixture.client.get<ExecutionGhResults['getPullRequestDiff']>(diffQuery({ ...commits, baseRefOid: limitedBase }));
      expect(limited.fileBodies['example.txt']).toMatchObject({ bodyState: 'too-large', limitReason: 'file-too-many-bytes', patch: null });
      expect(limited.fileBodies['small.txt'].patch).toContain('+small change');
      if (executorId !== 'local') {
        expect(await fixture.client.get('/api/v1/gh/status?executorId=local')).toMatchObject({ executorId: 'local', instanceId: expect.any(String), available: false });
        expect(await rejectionOf(fixture.client.get(`/api/v1/gh/pull-requests?${new URLSearchParams({ executorId, project: fixture.dirs.project })}`))).toMatchObject({ status: 403 });
      }
      await rm(join(fixture.dirs.root, 'gh-bin', 'gh'));
      expect(await fixture.client.get(`/api/v1/gh/status?executorId=${executorId}`)).toMatchObject({ ...scope, available: false, reason: 'gh_missing' });
    }, {
      executionBackend, projectRoots: 'separate',
      resolveServerEnvironment: dirs => ({ PATH: join(dirs.root, 'gh-bin') }),
      prepareWorkspace: async dirs => {
        const bin = join(dirs.root, 'gh-bin');
        await mkdir(bin);
        await copyFile(new URL('../../../server/remote/__tests__/fixtures/fake-gh.js', import.meta.url), join(bin, 'gh'));
        await chmod(join(bin, 'gh'), 0o755);
        await symlink(process.execPath, join(bin, 'bun'));
        await symlink(Bun.which('git')!, join(bin, 'git'));
        await writeFile(join(dirs.project, 'gh-fixture.json'), JSON.stringify({ label: 'synthetic-worker', bodyBytes: 1024 * 1024, commentsFail: true }));
      },
    });
  }, 60_000);
}
