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
      process.env.PATH = bin;
      const config = { label: 'synthetic-node', bodyBytes: 1024 * 1024, commentsFail: true };
      await fs.writeFile(path.join(fixture.root, 'gh-fixture.json'), JSON.stringify(config));
      await fs.writeFile(path.join(fixture.projectPath, 'gh-fixture.json'), JSON.stringify(config));
      const gh = await fixture.node.getGhService();
      const { nodeId, instanceId } = await fixture.node.getInfo();
      expect(await gh.getStatus()).toMatchObject({ nodeId, instanceId, available: true, login: config.label, host: 'git.example.invalid' });
      expect(await gh.listPullRequests({ projectPath: fixture.projectPath })).toMatchObject({ nodeId, instanceId, repo: { nameWithOwner: `${config.label}/repository` } });
      const detail = await gh.getPullRequest({ projectPath: fixture.projectPath, number: 1 });
      expect(detail).toMatchObject({ nodeId, instanceId });
      expect(detail.body.length).toBe(config.bodyBytes);
      expect(detail.fileBodies['example.txt'].patch).toContain('+changed');
      expect(detail.threads).toEqual([]);
      await fs.writeFile(path.join(fixture.projectPath, 'gh-fixture.json'), JSON.stringify({ ...config, bodyBytes: 4 * 1024 * 1024 }));
      await expect(gh.getPullRequest({ projectPath: fixture.projectPath, number: 1 })).rejects.toMatchObject({ code: 'GIT_RESULT_TOO_LARGE' });
      expect(fixture.node.availability).toBe('ready');
      await fs.rm(path.join(bin, 'gh'));
      expect(await gh.getStatus()).toMatchObject({ available: false, reason: 'gh_missing' });
    } finally { process.env.PATH = originalPath; await fixture.dispose(); }
  }, 30_000);
}

test('GitHub rejects missing or mismatched payload scope even inside a valid RPC envelope', async () => {
  const fixture = await gitRpcFixture();
  const local = await fixture.local.getGhService();
  const gh = await fixture.node.getGhService();
  const { nodeId, instanceId } = await fixture.node.getInfo();
  const status = spyOn(local, 'getStatus');
  try {
    for (const field of ['nodeId', 'instanceId'] as const) {
      for (const missing of [false, true]) {
        status.mockImplementation(async () => {
          const payload = { nodeId, instanceId, available: false, authenticated: false, reason: 'gh_missing' as const };
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
    const gh = await fixture.node.getGhService();
    const response = gh.getStatus({ signal: controller.signal }).catch(error => error);
    await started.promise;
    controller.abort();
    expect(await response).toBeInstanceOf(Error);
  } finally { watcher.close(); process.env.PATH = originalPath; await fixture.dispose(); }
}, 10_000);
