import type { GarconTestClient } from "../../support/garcon-client.js";
import type { CreateWorktreeOptions } from "../../../common/git.js";
import type { ExecutionGitResults } from "../../../common/git-execution.js";
import { describe, expect, test } from "bun:test";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withIntegrationFixture } from "../../support/integration-fixture.js";
import { initializeFixtureRepository, runFixtureGit } from "../../support/git-fixture.js";
import { rejectionOf } from "../../support/promise-assertions.js";

function worktreeCreator(client: GarconTestClient, project: string) {
  return (options: Omit<CreateWorktreeOptions, 'projectPath'>) =>
    client.post<ExecutionGitResults['createWorktree']>('/api/v1/git/worktrees/create', {
      executorId: client.executorId, project, ...options,
    });
}

describe("Git worktree HTTP API", () => {
  test("lists linked and missing worktrees and builds target candidates", async () => {
    await withIntegrationFixture("git-worktrees", async (fixture) => {
      const projectPath = fixture.executionDirs.project;
      const linkedPath = join(projectPath, "linked");
      const missingPath = join(projectPath, "missing");
      const outsidePath = join(fixture.dirs.root, "outside");
      await initializeFixtureRepository(projectPath);
      await runFixtureGit(projectPath, "worktree", "add", "-b", "feature", linkedPath);
      await runFixtureGit(projectPath, "worktree", "add", "-b", "missing", missingPath);
      await rm(missingPath, { recursive: true, force: true });
      await runFixtureGit(projectPath, "worktree", "add", "-b", "outside", outsidePath);

      const query = new URLSearchParams({ executorId: fixture.client.executorId, project: projectPath });
      const { worktrees } = await fixture.client.get<ExecutionGitResults['getWorktrees']>(`/api/v1/git/worktrees?${query}`);
      expect(worktrees).toMatchObject([
        {
          path: projectPath,
          branch: "main",
          isMain: true,
          isCurrent: true,
          isPathMissing: false,
        },
        {
          path: linkedPath,
          branch: "feature",
          isMain: false,
          isCurrent: false,
          isPathMissing: false,
        },
        {
          path: missingPath,
          branch: "missing",
          isMain: false,
          isCurrent: false,
          isPathMissing: true,
        },
      ]);
      expect(worktrees.some(worktree => worktree.path === outsidePath)).toBe(false);

      const { targets } = await fixture.client.get<ExecutionGitResults['getTargetCandidates']>(`/api/v1/git/targets?${query}`);
      expect(targets[0]).toMatchObject({
        worktreePath: projectPath,
        branch: "main",
        source: "chat-project",
        isMissing: false,
      });
      expect(targets.find((target) => target.worktreePath === missingPath)).toMatchObject({
        branch: "missing",
        source: "worktree",
        isMissing: true,
      });
    }, { projectRoots: 'separate' });
  });

  test("distinguishes missing paths from conflicting branch options", async () => {
    await withIntegrationFixture("git-worktree-create-validation", async ({ client, executionDirs }) => {
      const project = executionDirs.project;
      const worktreePath = join(project, 'linked');
      const reject = (fields: Record<string, unknown>) => rejectionOf(
        client.post('/api/v1/git/worktrees/create', { executorId: client.executorId, ...fields }),
      );
      for (const fields of [{ project }, { worktreePath }]) {
        expect(await reject(fields)).toMatchObject({
          status: 400,
          body: { errorCode: 'VALIDATION_FAILED', error: 'Missing required parameters: project and worktreePath.' },
        });
      }
      for (const fields of [{ newBranch: '' }, { newBranch: 'fresh-name', branch: 'existing' }, { newBranch: 'fresh-name', detach: true }]) {
        expect(await reject({ project, worktreePath, ...fields })).toMatchObject({
          status: 400, body: { errorCode: 'GIT_INVALID_INPUT' },
        });
      }
    });
  });

  test("suggestions require fresh branches; typed names can reuse local branches", async () => {
    await withIntegrationFixture("git-worktree-create", async (fixture) => {
      const projectPath = fixture.executionDirs.project;
      await initializeFixtureRepository(projectPath);
      const create = worktreeCreator(fixture.client, projectPath);
      const suggestedPath = join(projectPath, 'suggested');
      await runFixtureGit(projectPath, "branch", "unused-local");
      expect(await rejectionOf(create({ worktreePath: suggestedPath, newBranch: 'unused-local' }))).toMatchObject({
        body: { error: expect.stringContaining('unused-local') },
      });
      expect((await create({ worktreePath: suggestedPath, newBranch: 'fresh-name', detach: false })).success).toBe(true);
      expect((await create({ worktreePath: join(projectPath, 'manual'), branch: 'unused-local' })).success).toBe(true);
    }, { projectRoots: 'separate' });
  });

  test("an occupied destination does not consume a fresh branch name", async () => {
    await withIntegrationFixture("git-worktree-occupied", async ({ client, executionDirs }) => {
      const project = executionDirs.project;
      await initializeFixtureRepository(project);
      const occupied = join(project, 'occupied');
      await mkdir(occupied);
      const file = join(occupied, 'existing.txt');
      await writeFile(file, 'Existing content\n');
      const missing = join(project, 'missing');
      await runFixtureGit(project, 'worktree', 'add', '-b', 'registered', missing);
      await rm(missing, { recursive: true });
      const newBranch = 'fresh-name';
      const create = worktreeCreator(client, project);
      if (process.platform !== 'win32') {
        const dangling = join(project, 'dangling');
        await symlink('absent-directory', dangling);
        expect(await rejectionOf(create({ worktreePath: dangling, newBranch }))).toMatchObject({ status: 400, body: { errorCode: 'GIT_INVALID_INPUT' } });
        expect((await runFixtureGit(project, 'branch', '--list', newBranch)).trim()).toBe('');
      }
      for (const worktreePath of [occupied, file, missing]) {
        expect(await rejectionOf(create({ worktreePath, newBranch }))).toMatchObject({ status: 409, body: { errorCode: 'GIT_CONFLICT' } });
        expect((await runFixtureGit(project, 'branch', '--list', newBranch)).trim()).toBe('');
      }
      const empty = join(project, 'empty');
      await mkdir(empty);
      await create({ worktreePath: empty, newBranch });
      expect((await runFixtureGit(empty, 'branch', '--show-current')).trim()).toBe(newBranch);

      expect(await rejectionOf(create({ worktreePath: occupied }))).toMatchObject({ status: 409, body: { errorCode: 'GIT_CONFLICT' } });
      expect((await runFixtureGit(project, 'branch', '--list', 'occupied')).trim()).toBe('');
      const branch = 'typed-fresh';
      const oldBase = (await runFixtureGit(project, 'rev-parse', 'HEAD')).trim();
      await runFixtureGit(project, 'commit', '--allow-empty', '-m', 'New retry base');
      const failure = await rejectionOf(create({ worktreePath: occupied, branch, baseRef: oldBase }));
      expect(failure).toMatchObject({ status: 409, body: { errorCode: 'GIT_CONFLICT' } });
      expect((await runFixtureGit(project, 'branch', '--list', branch)).trim()).toBe('');
      const corrected = join(project, 'corrected');
      await create({ worktreePath: corrected, branch, baseRef: 'main' });
      expect(await runFixtureGit(corrected, 'rev-parse', 'HEAD')).toBe(await runFixtureGit(project, 'rev-parse', 'main'));
    });
  });

  test("respects Git's case rule for a missing registered destination before creating a branch", async () => {
    await withIntegrationFixture("git-worktree-registered-case", async ({ client, executionDirs }) => {
      const project = executionDirs.project;
      await initializeFixtureRepository(project);
      const registered = join(project, 'Registered');
      const worktreePath = join(project, 'registered');
      const create = worktreeCreator(client, project);
      const newBranch = 'fresh-case';
      await runFixtureGit(project, 'worktree', 'add', '-b', 'old-linked', registered);
      await rm(registered, { recursive: true });
      await runFixtureGit(project, 'config', 'core.ignoreCase', 'true');
      expect(await rejectionOf(create({ worktreePath, newBranch }))).toMatchObject({
        status: 409, body: { errorCode: 'GIT_CONFLICT' },
      });
      expect((await runFixtureGit(project, 'branch', '--list', newBranch)).trim()).toBe('');

      if (process.platform !== 'win32') {
        await runFixtureGit(project, 'config', 'core.ignoreCase', 'false');
        expect((await create({ worktreePath, newBranch })).success).toBe(true);
      }
    });
  });
});
