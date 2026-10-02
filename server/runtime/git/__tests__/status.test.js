import { describe, it, expect } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createGitOperations } from "../git-service.js";
import { runGitCommand, initRepoWithCommit } from "./repository-fixture.js";
import { plantUnmergedStages } from "./repository-fixture.js";

describe("getStatus", () => {
  const git = createGitOperations();

  it("preserves literal filenames rather than porcelain quoting or trimming", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-status-literal-"),
    );
    try {
      await initRepoWithCommit(projectPath);
      const names = ["-literal [file].txt", " line\nbreak ", 'quote".txt'];
      for (const name of names)
        await fs.writeFile(path.join(projectPath, name), "synthetic");
      expect((await git.getStatus({ projectPath })).untracked.sort()).toEqual(
        names.sort(),
      );
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("classifies typechanged, unmerged, and mixed-status paths instead of dropping them", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-status-"),
    );
    try {
      await initRepoWithCommit(projectPath);
      // Unstaged typechange: tracked file swapped for a symlink.
      await fs.rm(path.join(projectPath, "a.txt"));
      await fs.symlink("nowhere", path.join(projectPath, "a.txt"));
      // Staged typechange: same path shape, staged through the index.
      await fs.writeFile(path.join(projectPath, "t.txt"), "one\n", "utf-8");
      await runGitCommand(projectPath, ["add", "t.txt"]);
      await runGitCommand(projectPath, ["commit", "-m", "add t"]);
      await fs.rm(path.join(projectPath, "t.txt"));
      await fs.symlink("nowhere", path.join(projectPath, "t.txt"));
      await runGitCommand(projectPath, ["add", "t.txt"]);
      // Staged addition whose worktree copy was deleted.
      await fs.writeFile(path.join(projectPath, "ad.txt"), "staged\n", "utf-8");
      await runGitCommand(projectPath, ["add", "ad.txt"]);
      await fs.rm(path.join(projectPath, "ad.txt"));
      // Both-modified conflict.
      await plantUnmergedStages(projectPath, "uu.txt", [
        [1, "base\n"],
        [2, "ours\n"],
        [3, "theirs\n"],
      ]);
      await fs.writeFile(
        path.join(projectPath, "untracked.txt"),
        "new\n",
        "utf-8",
      );

      const status = await git.getStatus({ projectPath });

      expect(status.modified).toEqual(["a.txt", "t.txt", "uu.txt"]);
      expect(status.added).toEqual(["ad.txt"]);
      expect(status.deleted).toEqual([]);
      expect(status.untracked).toEqual(["untracked.txt"]);
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("drops rename entries instead of leaking the arrow string as a path", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-status-"),
    );
    try {
      await initRepoWithCommit(projectPath);
      // Pins rename detection on so the precondition cannot depend on the
      // machine's global git configuration.
      await runGitCommand(projectPath, ["config", "status.renames", "true"]);
      await runGitCommand(projectPath, ["mv", "a.txt", "moved.txt"]);
      await fs.writeFile(path.join(projectPath, "moved.txt"), "two\n", "utf-8");
      expect(
        (
          await runGitCommand(projectPath, ["status", "--porcelain"])
        ).stdout.trim(),
      ).toBe("RM a.txt -> moved.txt");

      const status = await git.getStatus({ projectPath });

      expect(status.modified).toEqual([]);
      expect(status.added).toEqual([]);
      expect(status.deleted).toEqual([]);
      expect(status.untracked).toEqual([]);
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("drops unstaged rename entries reported through an intent-to-add destination", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-status-"),
    );
    try {
      await initRepoWithCommit(projectPath);
      await runGitCommand(projectPath, ["config", "status.renames", "true"]);
      // Both files committed alike, then the destination is turned into an
      // intent-to-add entry and the source vanishes from the worktree: git
      // pairs that as an unstaged rename and reports R in the second column.
      await fs.copyFile(
        path.join(projectPath, "a.txt"),
        path.join(projectPath, "dst.txt"),
      );
      await runGitCommand(projectPath, ["add", "dst.txt"]);
      await runGitCommand(projectPath, ["commit", "-m", "add dst"]);
      await runGitCommand(projectPath, ["rm", "--cached", "dst.txt"]);
      await runGitCommand(projectPath, ["add", "-N", "dst.txt"]);
      await fs.rm(path.join(projectPath, "a.txt"));
      expect(
        (
          await runGitCommand(projectPath, ["status", "--porcelain"])
        ).stdout.trim(),
      ).toBe("DR a.txt -> dst.txt");

      const status = await git.getStatus({ projectPath });

      expect(status.modified).toEqual([]);
      expect(status.added).toEqual([]);
      expect(status.deleted).toEqual([]);
      expect(status.untracked).toEqual([]);
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });
});
