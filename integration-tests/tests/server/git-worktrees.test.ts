import { describe, expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withIntegrationFixture } from "../../support/integration-fixture.js";

async function runGit(projectPath: string, args: string[]): Promise<void> {
  const child = Bun.spawn(["git", ...args], {
    cwd: projectPath,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stderr, exitCode] = await Promise.all([
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`git ${args[0]} failed: ${stderr.trim()}`);
  }
}

async function getJson<T>(baseUrl: string, endpoint: string): Promise<T> {
  const response = await fetch(`${baseUrl}${endpoint}`);
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
      const projectPath = fixture.dirs.project;
      const linkedPath = join(fixture.dirs.root, "linked");
      const missingPath = join(fixture.dirs.root, "missing");
      await runGit(projectPath, ["init", "-b", "main"]);
      await runGit(projectPath, ["config", "user.email", "test@example.com"]);
      await runGit(projectPath, ["config", "user.name", "Integration Test"]);
      await writeFile(join(projectPath, "tracked.txt"), "tracked\n", "utf8");
      await runGit(projectPath, ["add", "tracked.txt"]);
      await runGit(projectPath, ["commit", "-m", "initial"]);
      await runGit(projectPath, [
        "worktree",
        "add",
        "-b",
        "feature",
        linkedPath,
      ]);
      await runGit(projectPath, [
        "worktree",
        "add",
        "-b",
        "missing",
        missingPath,
      ]);
      await rm(missingPath, { recursive: true, force: true });

      const query = new URLSearchParams({ project: projectPath });
      const { worktrees } = await getJson<{
        worktrees: Array<{
          path: string;
          branch: string;
          isMain: boolean;
          isCurrent: boolean;
          isPathMissing: boolean;
        }>;
      }>(fixture.garcon.baseUrl, `/api/v1/git/worktrees?${query}`);
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

      const { targets } = await getJson<{
        targets: Array<{
          worktreePath: string;
          branch: string;
          source: "chat-project" | "worktree";
          isMissing: boolean;
        }>;
      }>(fixture.garcon.baseUrl, `/api/v1/git/targets?${query}`);
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
    });
  });
});
