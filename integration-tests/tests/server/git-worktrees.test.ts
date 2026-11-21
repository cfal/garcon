import type { GarconTestClient } from "../../support/garcon-client.js";
import { describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { withIntegrationFixture } from "../../support/integration-fixture.js";
import { initializeFixtureRepository, runFixtureGit } from "../../support/git-fixture.js";
import { rejectionOf } from "../../support/promise-assertions.js";

async function getJson<T>(client: GarconTestClient, endpoint: string): Promise<T> {
  const response = await client.fetch(endpoint);
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(
      `${endpoint} returned ${response.status}: ${JSON.stringify(payload)}`,
    );
  }
  return payload as T;
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
      const { worktrees } = await getJson<{
        worktrees: Array<{
          path: string;
          branch: string;
          isMain: boolean;
          isCurrent: boolean;
          isPathMissing: boolean;
        }>;
      }>(fixture.client, `/api/v1/git/worktrees?${query}`);
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

      const { targets } = await getJson<{
        targets: Array<{
          worktreePath: string;
          branch: string;
          source: "chat-project" | "worktree";
          isMissing: boolean;
        }>;
      }>(fixture.client, `/api/v1/git/targets?${query}`);
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
      for (const conflict of [{ branch: 'existing' }, { detach: true }]) {
        expect(await reject({ project, worktreePath, newBranch: 'fresh-name', ...conflict })).toMatchObject({
          status: 400, body: { errorCode: 'GIT_INVALID_INPUT' },
        });
      }
    });
  });

  test("suggestions require fresh branches; typed names can reuse local branches", async () => {
    await withIntegrationFixture("git-worktree-create", async (fixture) => {
      const projectPath = fixture.executionDirs.project;
      await initializeFixtureRepository(projectPath);
      const create = (options: { branch?: string; newBranch?: string; worktreePath: string }) =>
        fixture.client.fetch('/api/v1/git/worktrees/create', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ executorId: fixture.client.executorId, project: projectPath, ...options }),
        });
      const suggestedPath = join(projectPath, 'suggested');
      await runFixtureGit(projectPath, "branch", "unused-local");
      expect((await create({ worktreePath: suggestedPath, newBranch: 'unused-local' })).ok).toBe(false);
      expect((await create({ worktreePath: suggestedPath, newBranch: 'fresh-name' })).ok).toBe(true);
      expect((await create({ worktreePath: join(projectPath, 'manual'), branch: 'unused-local' })).ok).toBe(true);
    }, { projectRoots: 'separate' });
  });
});
