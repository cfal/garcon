import { expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import { watch } from 'node:fs';
import path from 'node:path';
import { GH_DETAIL_TIMEOUT_MS, GIT_OPERATION_TIMEOUT_MS } from '../../../common/git-execution.js';
import * as gitOperation from '../../runtime/git/operation-context.js';
import { gitRpcFixture } from './git-rpc-fixture.js';

test('paginated GitHub policy reads retain their detail budget on Local and remote', async () => {
  const fixture = await gitRpcFixture();
  const originalPath = process.env.PATH;
  const operation = spyOn(gitOperation, 'withGitOperation');
  function expectDetailBudget(): void {
    expect(operation).toHaveBeenCalledTimes(1);
    const timeoutMs = operation.mock.calls[0]![1]?.timeoutMs;
    expect(timeoutMs).toBeGreaterThan(GIT_OPERATION_TIMEOUT_MS);
    expect(timeoutMs).toBeLessThanOrEqual(GH_DETAIL_TIMEOUT_MS);
    operation.mockClear();
  }
  try {
    const bin = path.join(fixture.root, 'bin');
    await fs.mkdir(bin);
    await fs.copyFile(new URL('./fixtures/fake-gh.js', import.meta.url), path.join(bin, 'gh'));
    await fs.chmod(path.join(bin, 'gh'), 0o755);
    process.env.PATH = `${bin}:${originalPath}`;
    await fs.writeFile(path.join(fixture.projectPath, 'gh-fixture.json'), JSON.stringify({
      label: 'synthetic', pageSize: 1, pulls: [{ number: 1 }, { number: 2 }],
    }));
    for (const service of [await fixture.local.getGhService(), await fixture.executor.getGhService()]) {
      const repository = {host: "git.example.invalid", nameWithOwner: "synthetic/repository"};
      const list = await service.listPullRequests({ projectPath: fixture.projectPath });
      expect(list.pulls.map(pull => pull.number)).toEqual([1, 2]);
      expectDetailBudget();
      expect((await service.getPullRequestReviewTarget({ projectPath: fixture.projectPath, repository, number: 1, marker: 'garcon-review synthetic/repository#1 ' })).state).toBe('open');
      expectDetailBudget();
    }
  } finally { operation.mockRestore(); process.env.PATH = originalPath; await fixture.dispose(); }
}, 10_000);

for (const dialer of ['controller', 'worker'] as const) {
  test(`GitHub posting rechecks preflight state and preserves delivered failures with ${dialer} dialing`, async () => {
    const fixture = await gitRpcFixture(dialer);
    const originalPath = process.env.PATH;
    try {
      const bin = path.join(fixture.root, 'bin');
      await fs.mkdir(bin);
      await fs.copyFile(new URL('./fixtures/fake-gh.js', import.meta.url), path.join(bin, 'gh'));
      await fs.chmod(path.join(bin, 'gh'), 0o755);
      process.env.PATH = `${bin}:${originalPath}`;
      const config = { label: 'synthetic', holdPostingActor: true, pulls: [{ number: 1 }] };
      const configFile = path.join(fixture.projectPath, 'gh-fixture.json');
      const releaseFile = path.join(fixture.projectPath, 'gh-actor-release');
      const repository = { host: 'git.example.invalid', nameWithOwner: 'synthetic/repository' };
      const actor = { id: 'actor:synthetic', login: 'synthetic' };
      const expected = { state: 'open', headRefOid: 'a'.repeat(40) } as const;
      const body = `Synthetic review\n<!-- garcon-review synthetic/repository#1 ${expected.headRefOid} -->`;
      for (const service of [await fixture.local.getGhService(), await fixture.executor.getGhService()]) {
        for (const change of [{ state: 'CLOSED' }, { headRefOid: 'b'.repeat(40) }]) {
          await fs.rm(releaseFile, { force: true });
          await fs.writeFile(configFile, JSON.stringify(config));
          const started = Promise.withResolvers<void>();
          const watcher = watch(fixture.projectPath, (_event, file) => { if (file === 'gh-actor-started') started.resolve(); });
          const posting = service.createPullRequestComment({ projectPath: fixture.projectPath, repository, actor, expected, number: 1, body });
          const outcome = posting.then(result => result, error => error);
          try {
            await started.promise;
            await fs.writeFile(configFile, JSON.stringify({ ...config, pulls: [{ number: 1, ...change }] }));
            await fs.writeFile(releaseFile, 'released');
            expect(await outcome).toMatchObject({ code: 'GH_STALE_PULL_REQUEST' });
            expect(await Bun.file(path.join(fixture.projectPath, 'gh-comments.json')).exists()).toBe(false);
          } finally {
            watcher.close();
            await fs.writeFile(releaseFile, 'released');
            await outcome;
          }
        }
        await fs.writeFile(configFile, JSON.stringify({ ...config, holdPostingActor: false, commentRejection: 'gh: Resource not accessible by integration (HTTP 403)' }));
        await expect(service.createPullRequestComment({ projectPath: fixture.projectPath, repository, actor, expected, number: 1, body }))
          .rejects.toMatchObject({ code: 'GH_MUTATION_REJECTED' });
        expect(await Bun.file(path.join(fixture.projectPath, 'gh-comments.json')).exists()).toBe(false);
        await fs.writeFile(configFile, JSON.stringify({ ...config, holdPostingActor: false, commentFailureAfterWrite: 'Post: connection reset by peer' }));
        await expect(service.createPullRequestComment({ projectPath: fixture.projectPath, repository, actor, expected, number: 1, body }))
          .rejects.toMatchObject({ code: 'GIT_MUTATION_OUTCOME_UNKNOWN' });
        await fs.writeFile(configFile, JSON.stringify({ ...config, holdPostingActor: false, pulls: [{ number: 1, state: 'CLOSED', headRefOid: 'b'.repeat(40) }] }));
        const target = await service.getPullRequestReviewTarget({ projectPath: fixture.projectPath, repository, number: 1, marker: 'garcon-review synthetic/repository#1 ' });
        expect(target.markedComments).toMatchObject([{ author: actor, marker: expect.stringContaining(expected.headRefOid) }]);
        await fs.rm(path.join(fixture.projectPath, 'gh-comments.json'));
      }
    } finally { process.env.PATH = originalPath; await fixture.dispose(); }
  }, 20_000);

  test(`GitHub queries enforce the inline result limit with ${dialer} dialing`, async () => {
    const fixture = await gitRpcFixture(dialer);
    const originalPath = process.env.PATH;
    try {
      const bin = path.join(fixture.root, 'bin');
      await fs.mkdir(bin);
      await fs.copyFile(new URL('./fixtures/fake-gh.js', import.meta.url), path.join(bin, 'gh'));
      await fs.chmod(path.join(bin, 'gh'), 0o755);
      await fs.symlink(process.execPath, path.join(bin, 'bun'));
      await fs.symlink(Bun.which('git')!, path.join(bin, 'git'));
      await fs.symlink(Bun.which('bash')!, path.join(bin, 'bash'));
      process.env.PATH = bin;
      const config = { label: 'synthetic-executor', bodyBytes: 1024 * 1024, commentsFail: true };
      await fs.writeFile(path.join(fixture.root, 'gh-fixture.json'), JSON.stringify(config));
      await fs.writeFile(path.join(fixture.projectPath, 'gh-fixture.json'), JSON.stringify(config));
      const gh = await fixture.executor.getGhService();
      const { executorId, instanceId } = await fixture.executor.getInfo();
      expect(await gh.getStatus()).toMatchObject({ executorId, instanceId, available: true, login: config.label, host: 'git.example.invalid' });
      expect(await gh.listPullRequests({ projectPath: fixture.projectPath })).toMatchObject({
        executorId, instanceId, repo: { nameWithOwner: `${config.label}/repository` }, viewerLogin: config.label,
        pulls: [{ number: 1, headRefOid: 'a'.repeat(40), authorAssociation: 'member', reviewRequest: null }],
      });
      const repository = {host: "git.example.invalid", nameWithOwner: `${config.label}/repository`};
      const expected = { state: "open", headRefOid: "a".repeat(40) } as const;
      const actor = {id: `actor:${config.label}`, login: config.label};
      const marker = `garcon-review ${config.label}/repository#1 `;
      const created = await gh.createPullRequestComment({ projectPath: fixture.projectPath, repository, actor, expected, number: 1, body: `Synthetic review\n<!-- ${marker}${'a'.repeat(40)} -->` });
      expect(created).toMatchObject({ executorId, instanceId, id: 'comment-1' });
      expect(await gh.getPullRequestReviewTarget({ projectPath: fixture.projectPath, repository, number: 1, marker })).toMatchObject({
        executorId, instanceId, state: 'open', headRefOid: 'a'.repeat(40), markedComments: [{ id: created.id, isMinimized: false }],
      });
      expect(await gh.minimizePullRequestComment({ projectPath: fixture.projectPath, repository, actor, commentId: created.id })).toMatchObject({ executorId, instanceId, minimized: true });
      await expect(gh.createPullRequestComment({ projectPath: fixture.projectPath, repository, actor, expected, number: 1, body: 'x'.repeat(65_537) }))
        .rejects.toMatchObject({ code: 'GIT_INVALID_INPUT' });
      await expect(gh.createPullRequestComment({ projectPath: fixture.projectPath, repository, actor, expected, number: 9, body: 'Synthetic review' }))
        .rejects.toMatchObject({ code: 'GH_MUTATION_REJECTED' });
      const detail = await gh.getPullRequest({ projectPath: fixture.projectPath, repository, number: 1 });
      expect(detail).toMatchObject({ executorId, instanceId });
      expect(detail.body.length).toBe(config.bodyBytes);
      expect(detail.fileBodies['example.txt'].patch).toContain('+changed');
      expect(detail.threads).toEqual([]);
      const specialPath = 'a\tb.txt';
      const diff = 'diff --git "a/a\\tb.txt" "b/a\\tb.txt"\n--- "a/a\\tb.txt"\n+++ "b/a\\tb.txt"\n@@ -1 +1 @@\n--- i;\n+++ i;\n';
      await fs.writeFile(path.join(fixture.projectPath, 'gh-fixture.json'), JSON.stringify({
        ...config, diff, files: [{ path: specialPath, additions: 1, deletions: 1 }],
      }));
      const named = await gh.getPullRequest({ projectPath: fixture.projectPath, repository, number: 1 });
      expect(named.files).toMatchObject([{ path: specialPath }]);
      expect(Object.keys(named.fileBodies)).toEqual([specialPath]);
      expect(named.fileBodies[specialPath].patch).toContain('+++ i;');
      await fs.writeFile(path.join(fixture.projectPath, 'gh-fixture.json'), JSON.stringify({
        ...config, commentsFail: false, commentPages: [
          [{ id: 1, path: 'example.txt', line: 1, side: 'RIGHT', body: 'first page' }],
          [{ id: 2, path: 'example.txt', line: 2, side: 'RIGHT', body: 'second page' }],
        ],
      }));
      const paginated = await gh.getPullRequest({ projectPath: fixture.projectPath, repository, number: 1 });
      expect(paginated.threads.flatMap(thread => thread.comments.map(comment => comment.body))).toEqual(['first page', 'second page']);
      await fs.writeFile(path.join(fixture.projectPath, 'gh-fixture.json'), JSON.stringify({ ...config, bodyBytes: 4 * 1024 * 1024 }));
      await expect(gh.getPullRequest({ projectPath: fixture.projectPath, repository, number: 1 })).rejects.toMatchObject({ code: 'GIT_RESULT_TOO_LARGE' });
      expect(fixture.executor.availability).toBe('ready');
      const labels = Array.from({ length: 101 }, (_, index) => `label-${index}`);
      await fs.rm(path.join(fixture.projectPath, 'gh-comments.json'));
      await fs.writeFile(path.join(fixture.projectPath, 'gh-fixture.json'), JSON.stringify({
        label: config.label,
        pulls: Array.from({ length: 101 }, (_, index) => ({ number: index + 1, labels: index === 100 ? labels : [] })),
        comments: Array.from({ length: 101 }, (_, index) => ({ id: `comment-${index}`, number: 1, body: `<!-- ${marker}${'a'.repeat(40)} -->` })),
      }));
      // Both paths validate the complete result after the runtime has read every page.
      for (const service of [await fixture.local.getGhService(), gh]) {
        const list = await service.listPullRequests({ projectPath: fixture.projectPath });
        expect(list.pulls).toHaveLength(101);
        expect(list.pulls[100].labels).toEqual(labels);
        const target = await service.getPullRequestReviewTarget({ projectPath: fixture.projectPath, repository, number: 1, marker });
        expect(target.markedComments).toHaveLength(101);
      }
      await fs.rm(path.join(bin, 'gh'));
      expect(await gh.getStatus()).toMatchObject({ available: false, reason: 'gh_missing' });
    } finally { process.env.PATH = originalPath; await fixture.dispose(); }
  }, 30_000);
}

test('GitHub rejects missing or mismatched payload scope even inside a valid RPC envelope', async () => {
  const fixture = await gitRpcFixture();
  const local = await fixture.local.getGhService();
  const gh = await fixture.executor.getGhService();
  const { executorId, instanceId } = await fixture.executor.getInfo();
  const status = spyOn(local, 'getStatus');
  try {
    for (const field of ['executorId', 'instanceId'] as const) {
      for (const missing of [false, true]) {
        status.mockImplementation(async () => {
          const payload = { executorId, instanceId, available: false, authenticated: false, reason: 'gh_missing' as const };
          if (missing) Reflect.deleteProperty(payload, field);
          else payload[field] = 'wrong';
          return payload;
        });
        await expect(gh.getStatus()).rejects.toMatchObject({ code: 'GIT_INVALID_RESULT' });
      }
    }
  } finally { status.mockRestore(); await fixture.dispose(); }
});

test('cancelled GitHub status is not published as unauthenticated', async () => {
  const fixture = await gitRpcFixture();
  const originalPath = process.env.PATH;
  const started = Promise.withResolvers<void>();
  const watcher = watch(fixture.root, (_event, file) => { if (file === 'gh-started') started.resolve(); });
  try {
    const bin = path.join(fixture.root, 'bin');
    await fs.mkdir(bin);
    await fs.copyFile(new URL('./fixtures/fake-gh.js', import.meta.url), path.join(bin, 'gh'));
    await fs.chmod(path.join(bin, 'gh'), 0o755);
    process.env.PATH = `${bin}:${originalPath}`;
    await fs.writeFile(path.join(fixture.root, 'gh-fixture.json'), JSON.stringify({ wait: true }));
    const controller = new AbortController();
    const gh = await fixture.executor.getGhService();
    const response = gh.getStatus({ signal: controller.signal }).catch(error => error);
    await started.promise;
    controller.abort();
    expect(await response).toBeInstanceOf(Error);
  } finally { watcher.close(); process.env.PATH = originalPath; await fixture.dispose(); }
}, 10_000);
