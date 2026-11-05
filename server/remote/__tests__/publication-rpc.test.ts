import { expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { runGit } from '../../runtime/git/run.js';
import { gitRpcFixture } from './git-rpc-fixture.js';

for (const dialer of ['controller', 'worker'] as const) {
  test(`publication validates exact identities and reconciles lost replies on Local and ${dialer} dialing`, async () => {
    const fixture = await gitRpcFixture(dialer);
    const originalPath = process.env.PATH;
    const repository = { host: 'git.example.invalid', nameWithOwner: 'synthetic/repository' };
    const actor = { id: 'actor:synthetic', login: 'synthetic' };
    const remote = `https://${repository.host}/${repository.nameWithOwner}.git`;
    const config = { label: 'synthetic', branches: { main: 'a'.repeat(40), delivery: 'b'.repeat(40) } };
    try {
      const bin = path.join(fixture.root, 'bin'); await fs.mkdir(bin);
      await fs.copyFile(new URL('./fixtures/fake-gh.js', import.meta.url), path.join(bin, 'gh'));
      await fs.chmod(path.join(bin, 'gh'), 0o755);
      process.env.PATH = `${bin}:${originalPath}`;
      await runGit(fixture.projectPath, ['remote', 'add', 'origin', remote]);
      const configFile = path.join(fixture.projectPath, 'gh-fixture.json');
      const records = path.join(fixture.projectPath, 'gh-publications.json');
      for (const runtime of [fixture.local, fixture.executor]) {
        const gh = await runtime.getGhService();
        const scope = await runtime.getInfo();
        await fs.writeFile(configFile, JSON.stringify(config));
        const target = { projectPath: fixture.projectPath, remote: 'origin', expectedRemoteUrl: remote, baseBranch: 'main' };
        expect(await gh.getPublicationTarget(target)).toMatchObject({ executorId: scope.executorId, instanceId: scope.instanceId,
          repository, actor, baseCommit: config.branches.main });
        const marker = '<!-- synthetic-publication-marker -->';
        const request = { ...target, repository, actor, baseCommit: config.branches.main, headBranch: 'delivery',
          headCommit: config.branches.delivery, title: 'Synthetic publication', body: `Synthetic body\n${marker}`, draft: false, marker };
        const lookup = { projectPath: fixture.projectPath, repository, actor, headBranch: 'delivery', baseBranch: 'main', marker };
        await expect(gh.createPullRequest(request, { instanceId: 'replaced-runtime' })).rejects.toMatchObject({ outcome: 'not-dispatched', code: 'STALE_RESOURCE' });
        expect(await Bun.file(records).exists()).toBe(false);
        await expect(gh.createPullRequest({ ...request, actor: { ...actor, id: 'changed' } })).rejects.toMatchObject({ code: 'GH_MUTATION_REJECTED' });
        await expect(gh.createPullRequest({ ...request, baseCommit: 'c'.repeat(40) })).rejects.toMatchObject({ code: 'GH_MUTATION_REJECTED' });
        await expect(gh.createPullRequest({ ...request, expectedRemoteUrl: 'https://git.example.invalid/other/repository.git' })).rejects.toMatchObject({ code: 'GH_MUTATION_REJECTED' });
        expect(await Bun.file(records).exists()).toBe(false);
        expect(await gh.createPullRequest(request, { instanceId: scope.instanceId })).toMatchObject({ repository, actor,
          number: 1, state: 'open', headCommit: request.headCommit, baseCommit: request.baseCommit, body: request.body });
        expect((await gh.findPullRequests(lookup)).pulls).toHaveLength(1);
        await fs.rm(records);
        await fs.writeFile(configFile, JSON.stringify({ ...config, publicationFailureAfterWrite: 'Post: connection reset by peer' }));
        await expect(gh.createPullRequest(request)).rejects.toMatchObject({ code: 'GIT_MUTATION_OUTCOME_UNKNOWN' });
        expect((await gh.findPullRequests(lookup)).pulls).toMatchObject([{ number: 1, headCommit: request.headCommit }]);
        await fs.rm(records);
        await fs.writeFile(configFile, JSON.stringify({ ...config, publicationLookup: Array.from({ length: 100 }, () => ({})) }));
        await expect(gh.findPullRequests(lookup)).rejects.toMatchObject({ code: 'GIT_RESULT_TOO_LARGE' });
      }
    } finally { process.env.PATH = originalPath; await fixture.dispose(); }
  }, 30_000);
}
