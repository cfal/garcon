import { expect, test } from 'bun:test';
import { mkdir, writeFile, rm, access } from 'node:fs/promises';
import path from 'node:path';
import { gitRpcFixture } from '../../../remote/__tests__/git-rpc-fixture.js';
import { runGit } from '../run.js';

for (const backend of ['local', 'controller', 'worker'] as const) {
  test(`managed removal checks exact identity and never forces dirty resources on ${backend}`, async () => {
    const f = await gitRpcFixture(backend === 'worker' ? 'worker' : 'controller');
    try {
      const git = await (backend === 'local' ? f.local : f.executor).getGitService();
      const baseCommit = (await runGit(f.projectPath, ['rev-parse', 'HEAD'])).stdout.trim();
      const operationId = crypto.randomUUID(); const managedResourceId = crypto.randomUUID();
      const worktreePath = path.join(f.root, 'managed');
      const created = await git.createManagedWorktree({ projectPath: f.projectPath, worktreePath, operationId, managedResourceId,
        branch: `garcon/${managedResourceId}`, baseCommit });
      const request = { projectPath: f.projectPath, worktreePath, operationId, managedResourceId,
        expectedRepositoryIdentity: created.managed.repositoryIdentity, expectedWorktreeIdentity: created.managed.worktreeIdentity,
        expectedHead: baseCommit, expectedBranch: created.managed.branch };
      for (const mismatch of [{ expectedHead: 'f'.repeat(40) }, { operationId: crypto.randomUUID() },
        { expectedRepositoryIdentity: 'changed' }, { expectedWorktreeIdentity: 'changed' }, { expectedBranch: 'changed' }]) {
        await expect(git.removeManagedWorktree({ ...request, ...mismatch })).rejects.toMatchObject({ code: 'GIT_INVALID_INPUT' });
        await access(worktreePath);
      }
      await writeFile(path.join(worktreePath, 'untracked.txt'), 'Synthetic retained work');
      await expect(git.removeManagedWorktree(request)).rejects.toMatchObject({ code: 'GIT_INVALID_INPUT' });
      await rm(path.join(worktreePath, 'untracked.txt'));
      await expect(git.removeManagedWorktree(request, { instanceId: 'replacement' })).rejects.toMatchObject({ code: 'STALE_RESOURCE' });
      expect(await git.removeManagedWorktree(request, { instanceId: created.instanceId })).toMatchObject({ success: true, removed: created.managed });
      await expect(access(worktreePath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await runGit(f.projectPath, ['rev-parse', `refs/heads/${created.managed.branch}`])).stdout.trim()).toBe(baseCommit);
      await mkdir(worktreePath); await writeFile(path.join(worktreePath, 'user.txt'), 'Replacement directory');
      await expect(git.removeManagedWorktree(request)).rejects.toBeDefined();
      await access(path.join(worktreePath, 'user.txt'));
    } finally { await f.dispose(); }
  }, 20_000);
}
