import { expect, test } from 'bun:test';
import { chmod, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { initializeFixtureRepository, runFixtureGit } from '../../support/git-fixture.js';

test('Local Git HTTP reports an expired upstream probe instead of clearing remote status', async () => {
  const realGit = Bun.which('git');
  if (!realGit) throw new Error('Git is required for this integration test');
  await withIntegrationFixture('git-read-deadline', async fixture => {
    const project = fixture.dirs.project;
    await initializeFixtureRepository(project);
    await runFixtureGit(project, 'remote', 'add', 'origin', '/synthetic-no-network');
    await runFixtureGit(project, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    await runFixtureGit(project, 'branch', '--set-upstream-to=origin/main');
    const endpoint = `/api/v1/git/remote-status?${new URLSearchParams({ nodeId: 'local', project })}`;
    const expected = { nodeId: 'local', hasRemote: true, hasUpstream: true, remoteName: 'origin' };
    expect(await fixture.client.get(endpoint)).toMatchObject(expected);

    const hold = join(project, '.git', 'hold-upstream-probe');
    await writeFile(hold, 'hold');
    await expect(fixture.client.get(endpoint)).rejects.toMatchObject({ status: 504, body: { errorCode: 'GIT_TIMEOUT' } });
    expect(await readFile(join(project, '.git', 'upstream-probe-started'), 'utf8')).toBe('started');
    await rm(hold);
    expect(await fixture.client.get(endpoint)).toMatchObject(expected);
  }, {
    executionBackend: 'in-process',
    serverEnvironment: { GARCON_HTTP_IDLE_TIMEOUT_SECONDS: '5' },
    resolveServerEnvironment: dirs => ({ PATH: join(dirs.root, 'git-bin') }),
    prepareWorkspace: async dirs => {
      const bin = join(dirs.root, 'git-bin');
      await mkdir(bin);
      await symlink(process.execPath, join(bin, 'bun'));
      const executable = join(bin, 'git');
      await writeFile(executable, `#!${process.execPath}
const args = process.argv.slice(2);
if (args.includes('main@{upstream}') && await Bun.file('.git/hold-upstream-probe').exists()) {
  await Bun.write('.git/upstream-probe-started', 'started');
  await Bun.sleep(60_000);
}
const child = Bun.spawn([${JSON.stringify(realGit)}, ...args], { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' });
process.exit(await child.exited);
`);
      await chmod(executable, 0o755);
    },
  });
}, 60_000);
