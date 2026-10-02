import { describe, it, expect } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createGitOperations } from "../git-service.js";
import { runGitCommand, initRepoWithCommit } from "./repository-fixture.js";

describe("getQuickSummary", () => {
  it("returns counts for staged, unstaged, and untracked files", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-quick-summary-"),
    );
    const git = createGitOperations();

    try {
      await initRepoWithCommit(projectPath);
      await fs.writeFile(
        path.join(projectPath, "a.txt"),
        "one\ntwo\n",
        "utf-8",
      );
      await fs.writeFile(
        path.join(projectPath, "b.txt"),
        "new\nfile\n",
        "utf-8",
      );
      await runGitCommand(projectPath, ["add", "b.txt"]);
      await fs.writeFile(
        path.join(projectPath, "c.txt"),
        "loose\nline\n",
        "utf-8",
      );

      const summary = await git.getQuickSummary({ projectPath });

      expect(summary).toMatchObject({
        status: "ready",
        project: projectPath,
        hasCommits: true,
        changedFiles: 3,
        trackedChangedFiles: 2,
        untrackedFiles: 1,
        stagedFiles: 1,
        unstagedFiles: 1,
        additions: 3,
        deletions: 0,
        fingerprintVersion: 1,
      });
      expect("untrackedAdditions" in summary).toBe(false);
      expect("untrackedAdditionsCapped" in summary).toBe(false);
      expect(summary.branch).toBeTruthy();
      expect(summary.fingerprint).toMatch(/^v1:/);
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("returns clean counts for an unchanged repository", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-quick-clean-"),
    );
    const git = createGitOperations();

    try {
      await initRepoWithCommit(projectPath);

      const summary = await git.getQuickSummary({ projectPath });

      expect(summary).toMatchObject({
        status: "ready",
        changedFiles: 0,
        trackedChangedFiles: 0,
        untrackedFiles: 0,
        stagedFiles: 0,
        unstagedFiles: 0,
        additions: 0,
        deletions: 0,
        hasCommits: true,
      });
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("returns ready summary for a repository with no commits", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-quick-unborn-"),
    );
    const git = createGitOperations();

    try {
      await runGitCommand(projectPath, ["init"]);

      const summary = await git.getQuickSummary({ projectPath });

      expect(summary).toMatchObject({
        status: "ready",
        hasCommits: false,
        changedFiles: 0,
        fingerprintVersion: 1,
      });
      expect(summary.branch).toBeTruthy();
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("returns typed non-repository response", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-quick-not-repo-"),
    );
    const git = createGitOperations();

    try {
      const summary = await git.getQuickSummary({ projectPath });

      expect(summary).toMatchObject({
        status: "not-git-repository",
        project: projectPath,
        fingerprintVersion: 1,
        fingerprint: null,
      });
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("does not count untracked file lines", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-quick-untracked-count-"),
    );
    const git = createGitOperations();

    try {
      await initRepoWithCommit(projectPath);
      for (let index = 0; index < 33; index += 1) {
        await fs.writeFile(
          path.join(projectPath, `untracked-${index}.txt`),
          "line\n",
          "utf-8",
        );
      }

      const summary = await git.getQuickSummary({ projectPath });

      expect(summary).toMatchObject({
        status: "ready",
        untrackedFiles: 33,
      });
      expect("untrackedAdditions" in summary).toBe(false);
      expect("untrackedAdditionsCapped" in summary).toBe(false);
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });
});
