import { describe, expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withIntegrationFixture } from '../../support/integration-fixture.js';

async function runGit(projectPath: string, args: string[]): Promise<string> {
  const process = Bun.spawn(['git', ...args], {
    cwd: projectPath,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) throw new Error(`git ${args[0]} failed: ${stderr.trim()}`);
  return stdout.trim();
}

async function postJson<T>(baseUrl: string, path: string, body: unknown): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok)
    throw new Error(`${path} returned ${response.status}: ${JSON.stringify(payload)}`);
  return payload as T;
}

describe('Git comparison HTTP API', () => {
  test('rejects a repository root outside the configured project base', async () => {
    await withIntegrationFixture('git-comparison-boundary', async (fixture) => {
      await runGit(fixture.dirs.root, ['init', '-b', 'main']);

      const response = await fetch(`${fixture.garcon.baseUrl}/api/v1/git/comparisons/snapshot`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          project: fixture.dirs.project,
          from: { kind: 'revision', revision: 'HEAD' },
          to: { kind: 'working-tree' },
          mode: 'direct',
          context: 5,
        }),
      });

      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        errorCode: 'outside_project_base',
      });
    });
  });

  test('compares revisions, merge bases, and a mutable Working Tree through lazy bodies', async () => {
    await withIntegrationFixture('git-comparison-api', async (fixture) => {
      const project = fixture.dirs.project;
      await runGit(project, ['init', '-b', 'main']);
      await runGit(project, ['config', 'user.email', 'test@example.com']);
      await runGit(project, ['config', 'user.name', 'Integration Test']);
      await writeFile(join(project, 'shared.txt'), 'base\n', 'utf8');
      await runGit(project, ['add', 'shared.txt']);
      await runGit(project, ['commit', '-m', 'base']);
      const base = await runGit(project, ['rev-parse', 'HEAD']);

      await writeFile(join(project, 'main.txt'), 'main\n', 'utf8');
      await runGit(project, ['add', 'main.txt']);
      await runGit(project, ['commit', '-m', 'main']);
      const main = await runGit(project, ['rev-parse', 'HEAD']);

      await runGit(project, ['checkout', '-b', 'feature', base]);
      await writeFile(join(project, 'feature.txt'), 'feature\n', 'utf8');
      await runGit(project, ['add', 'feature.txt']);
      await runGit(project, ['commit', '-m', 'feature']);
      const feature = await runGit(project, ['rev-parse', 'HEAD']);

      const direct = await postJson<{
        status: string;
        effectiveFromHash: string;
        files: Array<{ path: string }>;
      }>(fixture.garcon.baseUrl, '/api/v1/git/comparisons/snapshot', {
        project,
        from: { kind: 'revision', revision: base },
        to: { kind: 'revision', revision: main },
        mode: 'direct',
        context: 5,
      });
      expect(direct.status).toBe('ready');
      expect(direct.effectiveFromHash).toBe(base);
      expect(direct.files.map((file) => file.path)).toEqual(['main.txt']);

      const mergeBase = await postJson<{
        status: string;
        effectiveFromHash: string;
        mergeBaseHash: string;
        files: Array<{ path: string }>;
      }>(fixture.garcon.baseUrl, '/api/v1/git/comparisons/snapshot', {
        project,
        from: { kind: 'revision', revision: main },
        to: { kind: 'revision', revision: feature },
        mode: 'merge-base',
        context: 5,
      });
      expect(mergeBase.status).toBe('ready');
      expect(mergeBase.mergeBaseHash).toBe(base);
      expect(mergeBase.effectiveFromHash).toBe(base);
      expect(mergeBase.files.map((file) => file.path)).toEqual(['feature.txt']);

      await writeFile(join(project, 'feature.txt'), 'feature\nworking\n', 'utf8');
      await writeFile(join(project, 'untracked.txt'), 'first\nsecond\n', 'utf8');
      const nestedProject = join(project, 'nested');
      await mkdir(nestedProject);
      const workingTree = await postJson<{
        status: string;
        documentId: string;
        effectiveFromHash: string;
        to: { kind: 'working-tree'; fingerprint: string };
        files: Array<{ path: string; additions: number }>;
      }>(fixture.garcon.baseUrl, '/api/v1/git/comparisons/snapshot', {
        project: nestedProject,
        from: { kind: 'revision', revision: feature },
        to: { kind: 'working-tree' },
        mode: 'direct',
        context: 5,
      });
      expect(workingTree.status).toBe('ready');
      expect(workingTree.files.map((file) => file.path)).toEqual(['feature.txt', 'untracked.txt']);
      expect(workingTree.files.find((file) => file.path === 'untracked.txt')?.additions).toBe(2);

      const bodies = await postJson<{
        status: string;
        files: Record<string, { rows: Array<{ kind: string; text: string }> }>;
      }>(fixture.garcon.baseUrl, '/api/v1/git/comparisons/files', {
        project: nestedProject,
        documentId: workingTree.documentId,
        effectiveFromHash: workingTree.effectiveFromHash,
        to: { kind: 'working-tree', fingerprint: workingTree.to.fingerprint },
        context: 5,
        files: [{ path: 'untracked.txt' }],
      });
      expect(bodies.status).toBe('ready');
      expect(bodies.files['untracked.txt']?.rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'add', text: 'first' }),
          expect.objectContaining({ kind: 'add', text: 'second' }),
        ]),
      );

      const fingerprint = await postJson<{
        status: string;
        fingerprint: string;
      }>(fixture.garcon.baseUrl, '/api/v1/git/working-tree/fingerprint', {
        project,
      });
      expect(fingerprint).toMatchObject({
        status: 'ready',
        fingerprint: workingTree.to.fingerprint,
      });
    });
  });
});
