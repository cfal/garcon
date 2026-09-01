import { describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { GitRefsResponse, GitRefSort } from "../../../common/git-refs.js";
import { withIntegrationFixture } from "../../support/integration-fixture.js";

async function runGit(
  projectPath: string,
  args: string[],
  environment: Record<string, string> = {},
): Promise<string> {
  const child = Bun.spawn(["git", ...args], {
    cwd: projectPath,
    env: { ...process.env, ...environment },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0)
    throw new Error(`git ${args[0]} failed: ${stderr.trim()}`);
  return stdout.trim();
}

async function commitAt(
  projectPath: string,
  contents: string,
  message: string,
  timestamp: string,
): Promise<string> {
  await writeFile(join(projectPath, "dated.txt"), contents, "utf8");
  await runGit(projectPath, ["add", "dated.txt"]);
  await runGit(projectPath, ["commit", "-m", message], {
    GIT_AUTHOR_DATE: timestamp,
    GIT_COMMITTER_DATE: timestamp,
  });
  return runGit(projectPath, ["rev-parse", "HEAD"]);
}

async function getRefs(
  baseUrl: string,
  project: string,
  sort?: GitRefSort,
  options: { query?: string; limit?: number } = {},
): Promise<GitRefsResponse> {
  const params = new URLSearchParams({ project });
  if (sort) {
    params.set("sort", sort.key);
    params.set("direction", sort.direction);
  }
  if (options.query) params.set("query", options.query);
  if (options.limit) params.set("limit", String(options.limit));
  const response = await fetch(`${baseUrl}/api/v1/git/refs?${params}`);
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(
      `refs returned ${response.status}: ${JSON.stringify(payload)}`,
    );
  }
  return payload as GitRefsResponse;
}

describe("Git refs HTTP API", () => {
  test("sorts before limiting and exposes canonical branch and tag timestamps", async () => {
    await withIntegrationFixture("git-refs", async (fixture) => {
      const project = fixture.dirs.project;
      const oldTimestamp = "2024-01-01T00:00:00Z";
      const newTimestamp = "2024-03-01T00:00:00Z";
      const tagTimestamp = "2024-04-01T00:00:00Z";
      await runGit(project, ["init", "-b", "main"]);
      await runGit(project, ["config", "user.email", "test@example.com"]);
      await runGit(project, ["config", "user.name", "Integration Test"]);
      const oldHash = await commitAt(project, "old\n", "old", oldTimestamp);
      await runGit(project, ["branch", "candidate-old", oldHash]);
      const newHash = await commitAt(project, "new\n", "new", newTimestamp);
      await runGit(project, ["branch", "candidate-new", newHash]);
      await runGit(project, ["tag", "release-light", oldHash]);
      await runGit(
        project,
        ["tag", "-a", "release-annotated", oldHash, "-m", "release"],
        {
          GIT_AUTHOR_DATE: tagTimestamp,
          GIT_COMMITTER_DATE: tagTimestamp,
        },
      );

      const defaultName = await getRefs(
        fixture.garcon.baseUrl,
        project,
        undefined,
        { query: "candidate" },
      );
      expect(defaultName.refs.map((ref) => ref.name)).toEqual([
        "candidate-new",
        "candidate-old",
      ]);

      const newest = await getRefs(
        fixture.garcon.baseUrl,
        project,
        { key: "updated", direction: "desc" },
        { query: "candidate", limit: 1 },
      );
      expect(newest.refs).toMatchObject([
        {
          name: "candidate-new",
          updatedAt: "2024-03-01T00:00:00.000Z",
        },
      ]);

      const oldest = await getRefs(
        fixture.garcon.baseUrl,
        project,
        { key: "updated", direction: "asc" },
        { query: "candidate" },
      );
      expect(
        oldest.refs.map(({ name, updatedAt }) => ({ name, updatedAt })),
      ).toEqual([
        {
          name: "candidate-old",
          updatedAt: "2024-01-01T00:00:00.000Z",
        },
        {
          name: "candidate-new",
          updatedAt: "2024-03-01T00:00:00.000Z",
        },
      ]);

      const tags = await getRefs(
        fixture.garcon.baseUrl,
        project,
        { key: "updated", direction: "desc" },
        { query: "release" },
      );
      expect(
        tags.refs.map(({ name, updatedAt }) => ({ name, updatedAt })),
      ).toEqual([
        {
          name: "release-annotated",
          updatedAt: "2024-04-01T00:00:00.000Z",
        },
        {
          name: "release-light",
          updatedAt: "2024-01-01T00:00:00.000Z",
        },
      ]);

      const invalid = new URLSearchParams({
        project,
        sort: "updated",
      });
      const invalidResponse = await fetch(
        `${fixture.garcon.baseUrl}/api/v1/git/refs?${invalid}`,
      );
      expect(invalidResponse.status).toBe(400);
      expect(await invalidResponse.json()).toMatchObject({
        error:
          "Invalid ref sort. Expected sort=name|updated and direction=asc|desc together.",
      });
    });
  });

  test("preserves the non-repository API error", async () => {
    await withIntegrationFixture("git-refs-non-repository", async (fixture) => {
      const params = new URLSearchParams({ project: fixture.dirs.project });
      const response = await fetch(
        `${fixture.garcon.baseUrl}/api/v1/git/refs?${params}`,
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "Path is not a Git repository.",
      });
    });
  });
});
