import { expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import { watch } from 'node:fs';
import path from 'node:path';
import { gitRpcFixture } from './git-rpc-fixture.js';

for (const dialer of ['controller', 'worker'] as const) {
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
      expect(await gh.listPullRequests({ projectPath: fixture.projectPath })).toMatchObject({ executorId, instanceId, repo: { nameWithOwner: `${config.label}/repository` } });
      const detail = await gh.getPullRequest({ projectPath: fixture.projectPath, number: 1 });
      expect(detail).toMatchObject({ executorId, instanceId });
      expect(detail.body.length).toBe(config.bodyBytes);
      expect(detail.fileBodies['example.txt'].patch).toContain('+changed');
      expect(detail.threads).toEqual([]);
      const specialPath = 'a\tb.txt';
      const diff = 'diff --git "a/a\\tb.txt" "b/a\\tb.txt"\n--- "a/a\\tb.txt"\n+++ "b/a\\tb.txt"\n@@ -1 +1 @@\n--- i;\n+++ i;\n';
      await fs.writeFile(path.join(fixture.projectPath, 'gh-fixture.json'), JSON.stringify({
        ...config, diff, files: [{ path: specialPath, additions: 1, deletions: 1 }],
      }));
      const named = await gh.getPullRequest({ projectPath: fixture.projectPath, number: 1 });
      expect(named.files).toMatchObject([{ path: specialPath }]);
      expect(Object.keys(named.fileBodies)).toEqual([specialPath]);
      expect(named.fileBodies[specialPath].patch).toContain('+++ i;');
      await fs.writeFile(path.join(fixture.projectPath, 'gh-fixture.json'), JSON.stringify({
        ...config, commentsFail: false, commentPages: [
          [{ id: 1, path: 'example.txt', line: 1, side: 'RIGHT', body: 'first page' }],
          [{ id: 2, path: 'example.txt', line: 2, side: 'RIGHT', body: 'second page' }],
        ],
      }));
      const paginated = await gh.getPullRequest({ projectPath: fixture.projectPath, number: 1 });
      expect(paginated.threads.flatMap(thread => thread.comments.map(comment => comment.body))).toEqual(['first page', 'second page']);
      await fs.writeFile(path.join(fixture.projectPath, 'gh-fixture.json'), JSON.stringify({ ...config, bodyBytes: 4 * 1024 * 1024 }));
      await expect(gh.getPullRequest({ projectPath: fixture.projectPath, number: 1 })).rejects.toMatchObject({ code: 'GIT_RESULT_TOO_LARGE' });
      expect(fixture.executor.availability).toBe('ready');
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
