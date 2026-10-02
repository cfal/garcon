import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createGitOperations } from "../git-service.js";
import { runGitCommand, initRepoWithCommit } from "./repository-fixture.js";
import { createWorktreeOperations, serializeWorktreeMtime } from "../worktrees.js";

function detectReftableSupport() {
  const probePath = mkdtempSync(
    path.join(os.tmpdir(), "garcon-reftable-probe-"),
  );
  try {
    const result = spawnSync(
      "git",
      ["init", "--ref-format=reftable", probePath],
      { encoding: "utf8" },
    );
    if (result.status === 0) return true;

    const output = `${result.stderr || ""}${result.stdout || ""}`;
    if (/unknown option|unknown ref storage format|unsupported/i.test(output)) {
      return false;
    }
    throw new Error(`Git reftable capability probe failed: ${output}`);
  } finally {
    rmSync(probePath, { recursive: true, force: true });
  }
}

const supportsReftable = detectReftableSupport();

async function initRepoWithLinkedFeature(projectPath, linkedPath) {
  await initRepoWithCommit(projectPath);
  await runGitCommand(projectPath, [
    "worktree",
    "add",
    "-b",
    "feature",
    linkedPath,
  ]);
}

describe("getTargetCandidates", () => {
  it("reports the current branch on the chat-project candidate", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-targets-"),
    );
    const git = createGitOperations();

    try {
      await initRepoWithCommit(projectPath);
      await runGitCommand(projectPath, ["branch", "-M", "work"]);

      const { targets } = await git.getTargetCandidates({ projectPath });
      const chatProject = targets.find(
        (target) => target.source === "chat-project",
      );

      expect(chatProject).toBeDefined();
      expect(chatProject.isCurrent).toBe(true);
      expect(chatProject.branch).toBe("work");
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });
});

describe("worktree listing metadata", () => {
  it("reports root mtimes and keeps missing worktrees available to target discovery", async () => {
    const projectPath = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "garcon-worktree-times-")),
    );
    const linkedPath = `${projectPath}-Zed`;
    const missingPath = `${projectPath}-apple`;
    const git = createGitOperations();

    try {
      await initRepoWithCommit(projectPath);
      await runGitCommand(projectPath, ["config", "core.ignorecase", "true"]);
      await runGitCommand(projectPath, [
        "worktree",
        "add",
        "-b",
        "feature",
        linkedPath,
      ]);
      await runGitCommand(projectPath, [
        "worktree",
        "add",
        "-b",
        "missing",
        missingPath,
      ]);

      const modifiedAt = new Date("2026-07-15T10:00:00.000Z");
      await fs.utimes(linkedPath, modifiedAt, modifiedAt);
      await fs.rm(missingPath, { recursive: true, force: true });

      const trace = [];
      const { worktrees } = await git.getWorktrees({ projectPath, trace });
      const gitTrace = [];
      const gitSourceOperations = createWorktreeOperations({ source: "git" });
      const gitResult = await gitSourceOperations.getWorktrees({
        projectPath,
        trace: gitTrace,
      });
      // Source parity complements the absolute assertions below and the HTTP contract test.
      expect(gitResult).toEqual({ worktrees });
      expect(worktrees.map((worktree) => worktree.path)).toEqual([
        projectPath,
        linkedPath,
        missingPath,
      ]);
      expect(
        worktrees.find((worktree) => worktree.path === projectPath),
      ).toMatchObject({
        isPathMissing: false,
        lastModifiedAt: expect.any(String),
      });
      expect(
        worktrees.find((worktree) => worktree.path === linkedPath)
          ?.lastModifiedAt,
      ).toBe(modifiedAt.toISOString());
      expect(
        worktrees.find((worktree) => worktree.path === missingPath),
      ).toMatchObject({
        isPathMissing: true,
        lastModifiedAt: null,
      });
      const automaticUsedGit = trace.some((entry) =>
        entry.args.includes("worktree"),
      );
      const { stdout: refFormat } = await runGitCommand(projectPath, [
        "rev-parse",
        "--show-ref-format",
      ]);
      expect(automaticUsedGit).toBe(refFormat.trim() !== "files");
      if (!automaticUsedGit) {
        expect(trace).toHaveLength(1);
        expect(trace[0].args).toContain("--show-ref-format");
      }
      expect(gitTrace.some((entry) => entry.args.includes("worktree"))).toBe(
        true,
      );

      await fs.rm(linkedPath, { recursive: true, force: true });
      await fs.writeFile(linkedPath, "not a directory");
      const { worktrees: worktreesWithFile } = await git.getWorktrees({
        projectPath,
      });
      expect(
        worktreesWithFile.find((worktree) => worktree.path === linkedPath),
      ).toMatchObject({
        isPathMissing: true,
        lastModifiedAt: null,
      });

      const targetTrace = [];
      const { targets } = await git.getTargetCandidates({
        projectPath,
        trace: targetTrace,
      });
      const gitSourceTargetTrace = [];
      const gitSourceTargets = await gitSourceOperations.getTargetCandidates({
        projectPath,
        trace: gitSourceTargetTrace,
      });
      expect(gitSourceTargets).toEqual({ targets });
      expect(targetTrace.some((entry) => entry.args.includes("worktree"))).toBe(
        automaticUsedGit,
      );
      expect(
        gitSourceTargetTrace.some((entry) => entry.args.includes("worktree")),
      ).toBe(true);
      expect(
        targets.find((target) => target.worktreePath === missingPath),
      ).toMatchObject({
        source: "worktree",
        isMissing: true,
      });
    } finally {
      await fs.rm(linkedPath, { recursive: true, force: true });
      await fs.rm(missingPath, { recursive: true, force: true });
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("returns null when an mtime cannot be represented as ISO-8601", () => {
    expect(serializeWorktreeMtime(new Date(Number.NaN))).toBeNull();
  });

  it("uses porcelain for a separate Git directory", async () => {
    const fixtureRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-worktree-separate-git-dir-"),
    );
    const projectPath = path.join(fixtureRoot, "project");
    const gitDir = path.join(fixtureRoot, "repository.git");
    const git = createGitOperations();

    try {
      await fs.mkdir(projectPath);
      await runGitCommand(projectPath, ["init", "--separate-git-dir", gitDir]);
      const trace = [];
      const { worktrees } = await git.getWorktrees({ projectPath, trace });

      expect(worktrees).toHaveLength(1);
      expect(trace.some((entry) => entry.args.includes("worktree"))).toBe(true);
    } finally {
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("uses porcelain when worktree admin metadata is unreadable", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-worktree-invalid-admin-"),
    );
    const git = createGitOperations();

    try {
      await initRepoWithCommit(projectPath);
      await fs.writeFile(
        path.join(projectPath, ".git", "worktrees"),
        "invalid",
      );
      const trace = [];
      const { worktrees } = await git.getWorktrees({ projectPath, trace });

      expect(worktrees).toHaveLength(1);
      expect(trace.some((entry) => entry.args.includes("worktree"))).toBe(true);
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("uses porcelain for linked symlink-based HEAD refs", async () => {
    const projectPath = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "garcon-worktree-symlink-head-")),
    );
    const linkedPath = `${projectPath}-linked`;
    const git = createGitOperations();

    try {
      await initRepoWithLinkedFeature(projectPath, linkedPath);
      const { stdout } = await runGitCommand(linkedPath, [
        "rev-parse",
        "--path-format=absolute",
        "--git-path",
        "HEAD",
      ]);
      const linkedHeadPath = stdout.trim();
      await fs.rm(linkedHeadPath);
      await fs.symlink("refs/heads/feature", linkedHeadPath);

      const trace = [];
      const { worktrees } = await git.getWorktrees({
        projectPath: linkedPath,
        trace,
      });

      expect(
        worktrees.find((worktree) => worktree.path === linkedPath),
      ).toMatchObject({ branch: "feature", name: "feature" });
      expect(trace.some((entry) => entry.args.includes("worktree"))).toBe(true);
    } finally {
      await fs.rm(linkedPath, { recursive: true, force: true });
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("uses porcelain when the main repository is configured as bare", async () => {
    const projectPath = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "garcon-worktree-bare-main-")),
    );
    const linkedPath = `${projectPath}-linked`;
    const git = createGitOperations();

    try {
      await initRepoWithLinkedFeature(projectPath, linkedPath);
      await runGitCommand(projectPath, ["config", "core.bare", "true"]);

      const trace = [];
      const { worktrees } = await git.getWorktrees({
        projectPath: linkedPath,
        trace,
      });

      expect(worktrees[0]).toMatchObject({
        path: projectPath,
        branch: "",
        name: path.basename(projectPath),
      });
      expect(trace.some((entry) => entry.args.includes("worktree"))).toBe(true);
    } finally {
      await fs.rm(linkedPath, { recursive: true, force: true });
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it.skipIf(!supportsReftable)(
    "uses porcelain when Git reports a non-files ref backend",
    async () => {
      const projectPath = await fs.mkdtemp(
        path.join(os.tmpdir(), "garcon-worktree-reftable-"),
      );
      const git = createGitOperations();

      try {
        await runGitCommand(projectPath, ["init", "--ref-format=reftable"]);
        await runGitCommand(projectPath, [
          "config",
          "user.email",
          "test@example.com",
        ]);
        await runGitCommand(projectPath, ["config", "user.name", "Test User"]);
        await fs.writeFile(path.join(projectPath, "a.txt"), "one\n", "utf-8");
        await runGitCommand(projectPath, ["add", "a.txt"]);
        await runGitCommand(projectPath, ["commit", "-m", "initial"]);

        const trace = [];
        const { worktrees } = await git.getWorktrees({ projectPath, trace });

        expect(worktrees[0].branch).not.toBe(".invalid");
        expect(trace.some((entry) => entry.args.includes("worktree"))).toBe(
          true,
        );
      } finally {
        await fs.rm(projectPath, { recursive: true, force: true });
      }
    },
  );
});

describe("worktree creation", () => {
  it("does not track a remote base when creating a branch", async () => {
    const projectPath = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "garcon-worktree-no-track-")),
    );
    const linkedPath = `${projectPath}-feature`;
    const git = createGitOperations();

    try {
      await initRepoWithCommit(projectPath);
      await runGitCommand(projectPath, ["branch", "-M", "main"]);
      await runGitCommand(projectPath, [
        "remote",
        "add",
        "origin",
        "https://example.invalid/repository.git",
      ]);
      await runGitCommand(projectPath, [
        "update-ref",
        "refs/remotes/origin/main",
        "HEAD",
      ]);
      await runGitCommand(projectPath, [
        "config",
        "branch.autoSetupMerge",
        "always",
      ]);

      await git.createWorktree({
        projectPath,
        worktreePath: linkedPath,
        branch: "feature",
        baseRef: "origin/main",
      });

      const { stdout: upstream } = await runGitCommand(projectPath, [
        "for-each-ref",
        "--format=%(upstream)",
        "refs/heads/feature",
      ]);
      expect(upstream.trim()).toBe("");
    } finally {
      await fs.rm(linkedPath, { recursive: true, force: true });
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });
});
