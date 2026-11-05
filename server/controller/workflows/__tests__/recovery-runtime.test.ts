import { expect, test } from 'bun:test';
import { chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { WorkflowManagedTarget } from '../../../../common/workflows.js';
import { ExecutionRuntime } from '../../../runtime/execution-runtime.js';
import { runGit } from '../../../runtime/git/run.js';
import { gitRpcFixture } from '../../../remote/__tests__/git-rpc-fixture.js';
import { RUNTIME_BACKENDS, runtimeAdapter } from '../../../remote/__tests__/runtime-adapter.js';
import { inspectRecoveredWorkflowRepository, inspectWorkflowRepository } from '../adapters/repository-runtime.js';
import { createWorkflowPublicationPort, findRecoveredWorkflowPublication } from '../adapters/publication.js';
import type { WorkflowPublication } from '../publication-contracts.js';
import { workflowPublicationMarker } from '../publication-manifest.js';

for (const backend of RUNTIME_BACKENDS) {
  test(`explicit recovery reads retained Git and PR identity from a replacement runtime (${backend})`, async () => {
    const f = await gitRpcFixture(backend === 'worker' ? 'worker' : 'controller');
    const originalPath = process.env.PATH;
    let replacement: ExecutionRuntime | null = null;
    let adapter: Awaited<ReturnType<typeof runtimeAdapter>> | null = null;
    try {
      const original = backend === 'local' ? f.local : f.executor;
      const git = await original.getGitService();
      const scope = await original.getInfo();
      const baseCommit = (await runGit(f.projectPath, ['rev-parse', 'HEAD'])).stdout.trim();
      const request = { projectPath: f.projectPath, worktreePath: join(f.root, 'managed'), operationId: crypto.randomUUID(),
        managedResourceId: crypto.randomUUID(), branch: 'synthetic-managed', baseCommit };
      const created = await git.createManagedWorktree(request);
      const input = await git.inspectCommit({ projectPath: request.worktreePath, commit: baseCommit, ancestor: null });
      const resource: WorkflowManagedTarget = { operationId: request.operationId, managedResourceId: request.managedResourceId,
        repositoryIdentity: created.managed.repositoryIdentity, worktreeIdentity: created.managed.worktreeIdentity,
        branch: request.branch, head: baseCommit, resourceKey: 'a'.repeat(64),
        sourceProjectPath: f.projectPath, instanceId: scope.instanceId, baseTree: input.tree,
        target: { executorId: scope.executorId, projectPath: request.worktreePath, repositoryId: 'synthetic-repository',
          worktreeRoot: f.root, baseCommit, inputTaskId: null, remote: null } };
      await runGit(request.worktreePath, ['commit', '--allow-empty', '-m', 'Synthetic accepted output']);
      const headCommit = (await runGit(request.worktreePath, ['rev-parse', 'HEAD'])).stdout.trim();
      const repository = { host: 'git.example.invalid', nameWithOwner: 'synthetic/repository' };
      const actor = { id: 'actor:synthetic', login: 'synthetic' };
      const remoteUrl = `https://${repository.host}/${repository.nameWithOwner}.git`;
      const operationId = crypto.randomUUID();
      const marker = workflowPublicationMarker(operationId);
      const publication: WorkflowPublication = { executorId: scope.executorId, runtimeInstanceId: scope.instanceId,
        repositoryId: resource.target.repositoryId, projectPath: f.projectPath, repository, actor, remoteUrl,
        baseCommit, headCommit, baseBranch: 'main', headBranch: 'delivery', title: 'Synthetic publication',
        body: `Synthetic body\n${marker}`, draft: false, operationId };
      const bin = join(f.root, 'bin'); await mkdir(bin);
      await copyFile(new URL('../../../remote/__tests__/fixtures/fake-gh.js', import.meta.url), join(bin, 'gh'));
      await chmod(join(bin, 'gh'), 0o755);
      process.env.PATH = `${bin}:${originalPath}`;
      await runGit(f.projectPath, ['remote', 'add', 'origin', remoteUrl]);
      await writeFile(join(f.projectPath, 'gh-fixture.json'), JSON.stringify({ label: 'synthetic', branches: { main: baseCommit, delivery: headCommit } }));
      const gh = await original.getGhService();
      await gh.createPullRequest({ projectPath: f.projectPath, remote: 'origin', expectedRemoteUrl: remoteUrl, repository, actor,
        baseCommit, headCommit, baseBranch: publication.baseBranch, headBranch: publication.headBranch,
        title: publication.title, body: publication.body, draft: false, marker }, { instanceId: scope.instanceId });
      const savedPublication = await readFile(join(f.projectPath, 'gh-publications.json'), 'utf8');
      const savedResource = JSON.stringify(resource);
      await f.controller.dispose(); await f.worker.dispose(); await f.local.dispose();
      replacement = new ExecutionRuntime({ id: scope.executorId, workspaceDir: f.root, projectBasePath: f.root,
        integrations: [], resolveCredential: async () => null });
      adapter = await runtimeAdapter(replacement, backend);
      const current = adapter.executor;
      const replacementScope = await current.getInfo();
      expect(replacementScope.instanceId).not.toBe(scope.instanceId);
      const resolve = async (id: string) => { expect(id).toBe(scope.executorId); return current; };
      const signal = new AbortController().signal;
      await expect(inspectWorkflowRepository(resolve, resource, signal)).rejects.toThrow('prepared runtime');
      expect(await inspectRecoveredWorkflowRepository(resolve, resource, signal)).toMatchObject({ instanceId: replacementScope.instanceId,
        managed: { repositoryIdentity: resource.repositoryIdentity, worktreeIdentity: resource.worktreeIdentity, head: headCommit, dirty: false },
        commit: { commit: headCommit, containsAncestor: true } });
      await expect(createWorkflowPublicationPort(resolve).find(publication, signal)).rejects.toMatchObject({ code: 'STALE_RESOURCE' });
      expect(await findRecoveredWorkflowPublication(resolve, publication, 'origin', signal)).toMatchObject({
        instanceId: replacementScope.instanceId, pulls: [{ number: 1, headCommit, baseCommit, state: 'open' }] });
      expect(await readFile(join(f.projectPath, 'gh-publications.json'), 'utf8')).toBe(savedPublication);
      expect(JSON.stringify(resource)).toBe(savedResource);
      expect(publication.runtimeInstanceId).toBe(scope.instanceId);
    } finally {
      process.env.PATH = originalPath;
      await adapter?.dispose(); await replacement?.dispose(); await f.dispose();
    }
  }, 30_000);
}
