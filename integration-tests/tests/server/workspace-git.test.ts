import { describe, expect, test } from 'bun:test';
import { mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  CommitMessageGenerationResult, GitReviewDocumentFileBodiesResponse, GitWorkbenchSnapshotResponse,
} from '../../../server/git/types.js';
import { withTimeout } from '../../support/deferred.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';

async function git(project: string, args: string[]): Promise<string> {
  const child = Bun.spawn(['git', ...args], { cwd: project, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  if (code !== 0) throw new Error(`git ${args[0]} failed: ${stderr}`);
  return stdout.trim();
}

async function repository(base: string): Promise<{ project: string; alias: string }> {
  const project = join(base, 'repository');
  const alias = join(base, 'repository-alias');
  await mkdir(join(project, 'feature'), { recursive: true });
  await git(project, ['init', '-b', 'main']);
  await git(project, ['config', 'user.email', 'synthetic@example.test']);
  await git(project, ['config', 'user.name', 'Synthetic User']);
  for (const file of ['feature/a.ts', 'feature/b.ts', 'unselected.ts']) {
    await writeFile(join(project, file), 'original source\n');
  }
  await git(project, ['add', '.']);
  await git(project, ['commit', '-m', 'initial']);
  await symlink(project, alias);
  return { project, alias };
}

describe('workspace Git through authenticated HTTP', () => {
  test('composes one Git owner with the nondefault HTTP idle budget', async () => {
    await withIntegrationFixture('workspace-git-timeout', async (fixture) => {
      const { project } = await repository(fixture.dirs.project);
      await fixture.client.get(`/api/v1/git/status?${new URLSearchParams({ project })}`);
      await fixture.client.get(`/api/v1/git/status?${new URLSearchParams({ project })}`);
      expect(await readFile(join(fixture.dirs.root, 'git-timeout.jsonl'), 'utf8'))
        .toBe('{"networkTimeoutMs":8000}\n');
    }, {
      authentication: 'account', bindAddress: '0.0.0.0',
      preloadModules: [fileURLToPath(new URL('../../support/workspace-git-timeout-preload.ts', import.meta.url))],
      serverEnvironment: { GARCON_HTTP_IDLE_TIMEOUT_SECONDS: '10' },
      resolveServerEnvironment: (directories) => ({
        GARCON_TEST_GIT_TIMEOUT_OBSERVATION: join(directories.root, 'git-timeout.jsonl'),
      }),
    });
  });

  test('shares owner review state between alias snapshots and canonical body reads', async () => {
    await withIntegrationFixture('workspace-git-review', async (fixture) => {
      const { project, alias } = await repository(fixture.dirs.project);
      await writeFile(join(project, 'feature/a.ts'), 'captured staged source\n');
      await git(project, ['add', 'feature/a.ts']);
      const snapshot = await fixture.client.post<GitWorkbenchSnapshotResponse>('/api/v1/git/workbench/snapshot', {
        project: alias, mode: 'staged', context: 3,
      });
      expect(snapshot.status).toBe('ready');
      if (snapshot.status !== 'ready') throw new Error('Expected an owner review snapshot');
      const bodies = await fixture.client.post<GitReviewDocumentFileBodiesResponse>('/api/v1/git/review-documents/files', {
        project, documentId: snapshot.reviewSummary.documentId, files: ['feature/a.ts'], purpose: 'visible',
      });
      expect(bodies.status).toBe('ready');
      if (bodies.status === 'ready') expect(bodies.files['feature/a.ts'].patch).toContain('+captured staged source');
    }, { authentication: 'account', bindAddress: '0.0.0.0' });
  });

  test('checks both worktree paths and preserves contained missing-path creation', async () => {
    await withIntegrationFixture('workspace-git-worktrees', async (fixture) => {
      const { project, alias } = await repository(fixture.dirs.project);
      const outside = join(fixture.dirs.root, 'outside-worktree');
      for (const operation of ['create', 'remove']) {
        await expect(fixture.client.post(`/api/v1/git/worktrees/${operation}`, {
          project: alias, worktreePath: outside, detach: true,
        })).rejects.toMatchObject({ status: 403 });
      }
      await expect(stat(outside)).rejects.toMatchObject({ code: 'ENOENT' });
      const worktreePath = join(fixture.dirs.project, 'new-worktree');
      expect(await fixture.client.post('/api/v1/git/worktrees/create', {
        project: alias, worktreePath, detach: true,
      })).toMatchObject({ success: true, worktreePath });
      expect(await readFile(join(worktreePath, 'feature/a.ts'), 'utf8')).toBe('original source\n');
      expect(await fixture.client.post('/api/v1/git/worktrees/remove', {
        project: alias, worktreePath,
      })).toMatchObject({ success: true });
      await expect(stat(worktreePath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await git(project, ['status', '--porcelain'])).toBe('');
    }, { authentication: 'account', bindAddress: '0.0.0.0' });
  });

  test('generates only from the captured selected staged diff and leaves Git unchanged', async () => {
    await withIntegrationFixture('workspace-git-generation', async (fixture) => {
      const { project, alias } = await repository(fixture.dirs.project);
      const selected = ['feature/a.ts', 'feature/b.ts'];
      for (const file of selected) await writeFile(join(project, file), 'selected staged source\n');
      await writeFile(join(project, 'unselected.ts'), 'unselected staged source\n');
      await git(project, ['add', '.']);
      for (const file of selected) await writeFile(join(project, file), 'unstaged source\n');
      const beforeHead = await git(project, ['rev-parse', 'HEAD']);
      const agent = fixture.directAgents.openAi;
      await fixture.client.updateSettings({ ui: { commitMessage: {
        agentId: agent.agentId, model: agent.provider.model, apiProviderId: agent.provider.providerId,
        modelEndpointId: agent.provider.endpointId, modelProtocol: agent.provider.protocol, thinkingMode: 'none',
        customPrompt: 'Selected files:\n{{files}}\nSelected diff:\n{{diff}}', useCommonDirPrefix: true,
      } } });
      const output = fixture.fakeProviders.openAi.holdNext({ model: agent.provider.model });
      const pending = fixture.client.post<CommitMessageGenerationResult>('/api/v1/git/generate-commit-message', {
        project: alias, files: selected,
      });
      void pending.catch(() => undefined);
      try {
        const request = await withTimeout(output.received, 5_000, () => 'Commit generator did not receive the captured source');
        const body = JSON.stringify(request.body);
        expect(body).toContain('Selected files:');
        expect(body).toContain('+selected staged source');
        expect(body).not.toContain('unselected staged source');
        expect(body).not.toContain('unstaged source');
        await writeFile(join(project, 'feature/a.ts'), 'changed after capture\n');
        await git(project, ['add', 'feature/a.ts']);
        const indexAfterExplicitEdit = await git(project, ['write-tree']);
        await fixture.client.updateSettings({ ui: { commitMessage: {
          customPrompt: 'changed after capture: {{diff}}', useCommonDirPrefix: false,
        } } });
        expect(output.releaseText('fix: captured source')).toBeTrue();
        expect(await pending).toEqual({ message: 'feature: fix: captured source', directoryPrefix: 'feature' });
        expect(fixture.fakeProviders.openAi.requests()).toHaveLength(1);
        expect(JSON.stringify(request.body)).toBe(body);
        expect(await git(project, ['rev-parse', 'HEAD'])).toBe(beforeHead);
        expect(await git(project, ['write-tree'])).toBe(indexAfterExplicitEdit);
      } finally {
        output.allowAbort();
        output.releaseText('synthetic cleanup result');
        await pending.catch(() => undefined);
      }
    }, { authentication: 'account', bindAddress: '0.0.0.0' });
  });
});
