import { describe, it, expect } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createGitOperations } from "../git-service.js";
import { runGitCommand, initRepoWithCommit } from "./repository-fixture.js";
import { runGitWithStdin } from "../run.js";
import { plantUnmergedStages } from "./repository-fixture.js";

describe("discard", () => {
  const git = createGitOperations();
  it("discards only worktree edits for staged-added files, keeping the addition", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-discard-"),
    );
    try {
      await initRepoWithCommit(projectPath);
      await fs.writeFile(
        path.join(projectPath, "added.txt"),
        "staged\n",
        "utf-8",
      );
      await runGitCommand(projectPath, ["add", "added.txt"]);
      await fs.writeFile(
        path.join(projectPath, "added.txt"),
        "staged\nmodified\n",
        "utf-8",
      );
      expect(
        (
          await runGitCommand(projectPath, ["status", "--porcelain"])
        ).stdout.trim(),
      ).toBe("AM added.txt");

      await git.discard({ projectPath, file: "added.txt" });

      expect(
        (
          await runGitCommand(projectPath, ["status", "--porcelain"])
        ).stdout.trim(),
      ).toBe("A  added.txt");
      expect(
        await fs.readFile(path.join(projectPath, "added.txt"), "utf-8"),
      ).toBe("staged\n");
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("restores worktree-deleted staged-added files instead of dropping the addition", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-discard-"),
    );
    try {
      await initRepoWithCommit(projectPath);
      await fs.writeFile(
        path.join(projectPath, "added.txt"),
        "staged\n",
        "utf-8",
      );
      await runGitCommand(projectPath, ["add", "added.txt"]);
      await fs.rm(path.join(projectPath, "added.txt"));
      expect(
        (
          await runGitCommand(projectPath, ["status", "--porcelain"])
        ).stdout.trim(),
      ).toBe("AD added.txt");

      await git.discard({ projectPath, file: "added.txt" });

      expect(
        (
          await runGitCommand(projectPath, ["status", "--porcelain"])
        ).stdout.trim(),
      ).toBe("A  added.txt");
      expect(
        await fs.readFile(path.join(projectPath, "added.txt"), "utf-8"),
      ).toBe("staged\n");
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("restores typechanged staged-added files instead of silently no-opping", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-discard-"),
    );
    try {
      await initRepoWithCommit(projectPath);
      await fs.writeFile(
        path.join(projectPath, "added.txt"),
        "staged\n",
        "utf-8",
      );
      await runGitCommand(projectPath, ["add", "added.txt"]);
      await fs.rm(path.join(projectPath, "added.txt"));
      await fs.symlink("elsewhere.txt", path.join(projectPath, "added.txt"));
      expect(
        (
          await runGitCommand(projectPath, ["status", "--porcelain"])
        ).stdout.trim(),
      ).toBe("AT added.txt");

      await git.discard({ projectPath, file: "added.txt" });

      expect(
        (
          await runGitCommand(projectPath, ["status", "--porcelain"])
        ).stdout.trim(),
      ).toBe("A  added.txt");
      const stats = await fs.lstat(path.join(projectPath, "added.txt"));
      expect(stats.isSymbolicLink()).toBe(false);
      expect(
        await fs.readFile(path.join(projectPath, "added.txt"), "utf-8"),
      ).toBe("staged\n");
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("restores unstaged typechanges on tracked files", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-discard-"),
    );
    try {
      await initRepoWithCommit(projectPath);
      await fs.rm(path.join(projectPath, "a.txt"));
      await fs.symlink("elsewhere.txt", path.join(projectPath, "a.txt"));
      // Strips only the trailing newline: trim() would eat the leading space
      // that carries the unstaged half of the status.
      const porcelain = async () =>
        (
          await runGitCommand(projectPath, ["status", "--porcelain"])
        ).stdout.replace(/\n$/, "");
      expect(await porcelain()).toBe(" T a.txt");

      await git.discard({ projectPath, file: "a.txt" });

      expect(await porcelain()).toBe("");
      const stats = await fs.lstat(path.join(projectPath, "a.txt"));
      expect(stats.isSymbolicLink()).toBe(false);
      expect(await fs.readFile(path.join(projectPath, "a.txt"), "utf-8")).toBe(
        "one\n",
      );
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("unstages index-only staged additions, which have no worktree changes to restore", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-discard-"),
    );
    try {
      await initRepoWithCommit(projectPath);
      await fs.writeFile(
        path.join(projectPath, "added.txt"),
        "staged\n",
        "utf-8",
      );
      await runGitCommand(projectPath, ["add", "added.txt"]);
      expect(
        (
          await runGitCommand(projectPath, ["status", "--porcelain"])
        ).stdout.trim(),
      ).toBe("A  added.txt");

      await git.discard({ projectPath, file: "added.txt" });

      expect(
        (
          await runGitCommand(projectPath, ["status", "--porcelain"])
        ).stdout.trim(),
      ).toBe("?? added.txt");
      expect(
        await fs.readFile(path.join(projectPath, "added.txt"), "utf-8"),
      ).toBe("staged\n");
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("resolves unmerged added-by-them files instead of silently no-opping", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-discard-"),
    );
    try {
      await initRepoWithCommit(projectPath);
      await fs.writeFile(path.join(projectPath, "u.txt"), "theirs\n", "utf-8");
      const { stdout: hash } = await runGitCommand(projectPath, [
        "hash-object",
        "-w",
        "u.txt",
      ]);
      // Plants a stage-3-only index entry, the layout behind UA status.
      await runGitWithStdin(
        projectPath,
        ["update-index", "--index-info"],
        `100644 ${hash.trim()} 3\tu.txt\n`,
      );
      expect(
        (
          await runGitCommand(projectPath, ["status", "--porcelain"])
        ).stdout.trim(),
      ).toBe("UA u.txt");

      await git.discard({ projectPath, file: "u.txt" });

      expect(
        (
          await runGitCommand(projectPath, ["status", "--porcelain"])
        ).stdout.trim(),
      ).toBe("?? u.txt");
      expect(await fs.readFile(path.join(projectPath, "u.txt"), "utf-8")).toBe(
        "theirs\n",
      );
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("resolves unmerged added-by-us files instead of silently no-opping", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-discard-"),
    );
    try {
      await initRepoWithCommit(projectPath);
      await fs.writeFile(path.join(projectPath, "ours.txt"), "ours\n", "utf-8");
      const { stdout: hash } = await runGitCommand(projectPath, [
        "hash-object",
        "-w",
        "ours.txt",
      ]);
      // Plants a stage-2-only index entry, the layout behind AU status.
      await runGitWithStdin(
        projectPath,
        ["update-index", "--index-info"],
        `100644 ${hash.trim()} 2\tours.txt\n`,
      );
      expect(
        (
          await runGitCommand(projectPath, ["status", "--porcelain"])
        ).stdout.trim(),
      ).toBe("AU ours.txt");

      await git.discard({ projectPath, file: "ours.txt" });

      expect(
        (
          await runGitCommand(projectPath, ["status", "--porcelain"])
        ).stdout.trim(),
      ).toBe("?? ours.txt");
      expect(
        await fs.readFile(path.join(projectPath, "ours.txt"), "utf-8"),
      ).toBe("ours\n");
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("reverts both-modified conflicts to the HEAD version", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-discard-"),
    );
    try {
      await initRepoWithCommit(projectPath);
      await plantUnmergedStages(projectPath, "a.txt", [
        [1, "base\n"],
        [2, "ours\n"],
        [3, "theirs\n"],
      ]);
      // The merge leaves conflict markers in the worktree; without this,
      // reset alone would already match the assertions below.
      await fs.writeFile(
        path.join(projectPath, "a.txt"),
        "<<<<<<< ours\n",
        "utf-8",
      );
      expect(
        (
          await runGitCommand(projectPath, ["status", "--porcelain"])
        ).stdout.trim(),
      ).toBe("UU a.txt");

      await git.discard({ projectPath, file: "a.txt" });

      expect(
        (
          await runGitCommand(projectPath, ["status", "--porcelain"])
        ).stdout.trim(),
      ).toBe("");
      expect(await fs.readFile(path.join(projectPath, "a.txt"), "utf-8")).toBe(
        "one\n",
      );
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("reverts modified-by-us-deleted-by-them conflicts to the HEAD version", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-discard-"),
    );
    try {
      await initRepoWithCommit(projectPath);
      await plantUnmergedStages(projectPath, "a.txt", [
        [1, "base\n"],
        [2, "ours\n"],
      ]);
      await fs.writeFile(
        path.join(projectPath, "a.txt"),
        "<<<<<<< ours\n",
        "utf-8",
      );
      expect(
        (
          await runGitCommand(projectPath, ["status", "--porcelain"])
        ).stdout.trim(),
      ).toBe("UD a.txt");

      await git.discard({ projectPath, file: "a.txt" });

      expect(
        (
          await runGitCommand(projectPath, ["status", "--porcelain"])
        ).stdout.trim(),
      ).toBe("");
      expect(await fs.readFile(path.join(projectPath, "a.txt"), "utf-8")).toBe(
        "one\n",
      );
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("resolves deleted-by-us conflicts leaving the worktree copy untracked", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-discard-"),
    );
    try {
      await initRepoWithCommit(projectPath);
      await plantUnmergedStages(projectPath, "u.txt", [
        [1, "base\n"],
        [3, "theirs\n"],
      ]);
      // The merge leaves their version in the worktree even though our side
      // deleted the path; discard keeps it as an untracked leftover.
      await fs.writeFile(path.join(projectPath, "u.txt"), "theirs\n", "utf-8");
      expect(
        (
          await runGitCommand(projectPath, ["status", "--porcelain"])
        ).stdout.trim(),
      ).toBe("DU u.txt");

      await git.discard({ projectPath, file: "u.txt" });

      expect(
        (
          await runGitCommand(projectPath, ["status", "--porcelain"])
        ).stdout.trim(),
      ).toBe("?? u.txt");
      expect(await fs.readFile(path.join(projectPath, "u.txt"), "utf-8")).toBe(
        "theirs\n",
      );
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("resolves both-deleted conflicts cleanly", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-discard-"),
    );
    try {
      await initRepoWithCommit(projectPath);
      await plantUnmergedStages(projectPath, "u.txt", [[1, "base\n"]]);
      expect(
        (
          await runGitCommand(projectPath, ["status", "--porcelain"])
        ).stdout.trim(),
      ).toBe("DD u.txt");

      await git.discard({ projectPath, file: "u.txt" });

      expect(
        (
          await runGitCommand(projectPath, ["status", "--porcelain"])
        ).stdout.trim(),
      ).toBe("");
      await expect(fs.stat(path.join(projectPath, "u.txt"))).rejects.toThrow();
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("reverts both-added conflicts to the HEAD version without leaving markers", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-discard-"),
    );
    try {
      await initRepoWithCommit(projectPath);
      // A real add/add conflict: HEAD keeps its own version while the
      // worktree holds the merge markers.
      await runGitCommand(projectPath, ["checkout", "-b", "other"]);
      await fs.writeFile(path.join(projectPath, "f.txt"), "theirs\n", "utf-8");
      await runGitCommand(projectPath, ["add", "f.txt"]);
      await runGitCommand(projectPath, ["commit", "-m", "theirs adds"]);
      await runGitCommand(projectPath, ["checkout", "master"]);
      await fs.writeFile(path.join(projectPath, "f.txt"), "ours\n", "utf-8");
      await runGitCommand(projectPath, ["add", "f.txt"]);
      await runGitCommand(projectPath, ["commit", "-m", "ours adds"]);
      try {
        await runGitCommand(projectPath, ["merge", "other"]);
      } catch {
        // Expected merge conflict.
      }
      expect(
        (
          await runGitCommand(projectPath, ["status", "--porcelain"])
        ).stdout.trim(),
      ).toBe("AA f.txt");

      await git.discard({ projectPath, file: "f.txt" });

      expect(
        (
          await runGitCommand(projectPath, ["status", "--porcelain"])
        ).stdout.trim(),
      ).toBe("");
      expect(await fs.readFile(path.join(projectPath, "f.txt"), "utf-8")).toBe(
        "ours\n",
      );
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("reverts unstaged renames by restoring both source and destination", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-discard-"),
    );
    try {
      await initRepoWithCommit(projectPath);
      await runGitCommand(projectPath, ["config", "status.renames", "true"]);
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

      await git.discard({ projectPath, file: "dst.txt" });

      // The source reappears at its index content and the destination returns
      // to its committed state, so the tree is fully clean.
      expect(
        (
          await runGitCommand(projectPath, ["status", "--porcelain"])
        ).stdout.trim(),
      ).toBe("");
      expect(await fs.readFile(path.join(projectPath, "a.txt"), "utf-8")).toBe(
        "one\n",
      );
      expect(
        await fs.readFile(path.join(projectPath, "dst.txt"), "utf-8"),
      ).toBe("one\n");
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("preserves worktree content when discarding a rename onto a new path", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-discard-"),
    );
    try {
      await initRepoWithCommit(projectPath);
      await runGitCommand(projectPath, ["config", "status.renames", "true"]);
      await fs.writeFile(
        path.join(projectPath, "a.txt"),
        "one\ntwo\nthree\nfour\n",
        "utf-8",
      );
      await runGitCommand(projectPath, ["commit", "-am", "longer source"]);
      // The destination is an edited copy well above the rename similarity
      // threshold, so git pairs it as an unstaged rename.
      await fs.writeFile(
        path.join(projectPath, "renamed.txt"),
        "one\ntwo\nthree\nfour\nfive\n",
        "utf-8",
      );
      await runGitCommand(projectPath, ["add", "-N", "renamed.txt"]);
      await fs.rm(path.join(projectPath, "a.txt"));
      expect(
        (
          await runGitCommand(projectPath, ["status", "--porcelain"])
        ).stdout.trim(),
      ).toBe("R a.txt -> renamed.txt");

      await git.discard({ projectPath, file: "renamed.txt" });

      // The source restores to its index content; resetting the destination's
      // intent-to-add entry keeps the edited worktree copy as untracked
      // instead of truncating it to the empty index blob.
      expect(
        (
          await runGitCommand(projectPath, ["status", "--porcelain"])
        ).stdout.trim(),
      ).toBe("?? renamed.txt");
      expect(await fs.readFile(path.join(projectPath, "a.txt"), "utf-8")).toBe(
        "one\ntwo\nthree\nfour\n",
      );
      expect(
        await fs.readFile(path.join(projectPath, "renamed.txt"), "utf-8"),
      ).toBe("one\ntwo\nthree\nfour\nfive\n");
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("discards worktree renames from their source path", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-discard-"),
    );
    try {
      await initRepoWithCommit(projectPath);
      await runGitCommand(projectPath, ["config", "status.renames", "true"]);
      await fs.copyFile(
        path.join(projectPath, "a.txt"),
        path.join(projectPath, "renamed.txt"),
      );
      await runGitCommand(projectPath, ["add", "-N", "renamed.txt"]);
      await fs.rm(path.join(projectPath, "a.txt"));
      expect(
        (
          await runGitCommand(projectPath, ["status", "--porcelain"])
        ).stdout.trim(),
      ).toBe("R a.txt -> renamed.txt");

      await git.discard({ projectPath, file: "a.txt" });

      expect(
        (
          await runGitCommand(projectPath, ["status", "--porcelain"])
        ).stdout.trim(),
      ).toBe("?? renamed.txt");
      expect(await fs.readFile(path.join(projectPath, "a.txt"), "utf-8")).toBe(
        "one\n",
      );
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("preserves worktree content when discarding intent-to-add entries", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-discard-"),
    );
    try {
      await initRepoWithCommit(projectPath);
      await fs.writeFile(
        path.join(projectPath, "new.txt"),
        "content\n",
        "utf-8",
      );
      await runGitCommand(projectPath, ["add", "-N", "new.txt"]);
      expect(
        (
          await runGitCommand(projectPath, ["status", "--porcelain"])
        ).stdout.trim(),
      ).toBe("A new.txt");

      await git.discard({ projectPath, file: "new.txt" });

      expect(
        (
          await runGitCommand(projectPath, ["status", "--porcelain"])
        ).stdout.trim(),
      ).toBe("?? new.txt");
      expect(
        await fs.readFile(path.join(projectPath, "new.txt"), "utf-8"),
      ).toBe("content\n");
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("discards through a project path below the repository root", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-discard-"),
    );
    try {
      await initRepoWithCommit(projectPath);
      await fs.mkdir(path.join(projectPath, "sub"));
      await fs.writeFile(
        path.join(projectPath, "sub", "x.txt"),
        "sub content\n",
        "utf-8",
      );
      await runGitCommand(projectPath, ["add", "sub/x.txt"]);
      await runGitCommand(projectPath, ["commit", "-m", "add sub"]);
      await fs.writeFile(
        path.join(projectPath, "sub", "x.txt"),
        "edited\n",
        "utf-8",
      );

      await git.discard({
        projectPath: path.join(projectPath, "sub"),
        file: "x.txt",
      });

      expect(
        (
          await runGitCommand(projectPath, ["status", "--porcelain"])
        ).stdout.trim(),
      ).toBe("");
      expect(
        await fs.readFile(path.join(projectPath, "sub", "x.txt"), "utf-8"),
      ).toBe("sub content\n");
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("keeps a tracked rename destination as a modification when its content differs", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-discard-"),
    );
    try {
      await initRepoWithCommit(projectPath);
      await runGitCommand(projectPath, ["config", "status.renames", "true"]);
      await fs.writeFile(
        path.join(projectPath, "a.txt"),
        "one\ntwo\nthree\nfour\n",
        "utf-8",
      );
      await runGitCommand(projectPath, ["commit", "-am", "longer source"]);
      await fs.copyFile(
        path.join(projectPath, "a.txt"),
        path.join(projectPath, "dst.txt"),
      );
      await runGitCommand(projectPath, ["add", "dst.txt"]);
      await runGitCommand(projectPath, ["commit", "-m", "add dst"]);
      await runGitCommand(projectPath, ["rm", "--cached", "dst.txt"]);
      await runGitCommand(projectPath, ["add", "-N", "dst.txt"]);
      // The destination drifts from its committed content while staying
      // similar enough for the rename pairing.
      await fs.writeFile(
        path.join(projectPath, "dst.txt"),
        "one\ntwo\nthree\nfour\nedited\n",
        "utf-8",
      );
      await fs.rm(path.join(projectPath, "a.txt"));
      expect(
        (
          await runGitCommand(projectPath, ["status", "--porcelain"])
        ).stdout.trim(),
      ).toBe("DR a.txt -> dst.txt");

      await git.discard({ projectPath, file: "dst.txt" });

      // Resetting the destination leaves the never-hashed edit as an unstaged
      // modification instead of truncating it to the committed content.
      expect(
        (
          await runGitCommand(projectPath, ["status", "--porcelain"])
        ).stdout.trim(),
      ).toBe("M dst.txt");
      expect(await fs.readFile(path.join(projectPath, "a.txt"), "utf-8")).toBe(
        "one\ntwo\nthree\nfour\n",
      );
      expect(
        await fs.readFile(path.join(projectPath, "dst.txt"), "utf-8"),
      ).toBe("one\ntwo\nthree\nfour\nedited\n");
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("treats a conflicted file named like a pathspec glob literally", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-discard-"),
    );
    try {
      await initRepoWithCommit(projectPath);
      // A conflicted path literally named "*" must not expand in the reset
      // and restore pathspecs: globbed, it would rewrite every tracked file.
      await fs.writeFile(path.join(projectPath, "*"), "head-star\n", "utf-8");
      await runGitCommand(projectPath, ["add", "*"]);
      await runGitCommand(projectPath, ["commit", "-m", "add star"]);
      await plantUnmergedStages(projectPath, "*", [
        [1, "base\n"],
        [2, "ours\n"],
        [3, "theirs\n"],
      ]);
      await fs.writeFile(path.join(projectPath, "a.txt"), "edited\n", "utf-8");
      expect(
        (
          await runGitCommand(projectPath, ["status", "--porcelain"])
        ).stdout.trim(),
      ).toBe("UU *\n M a.txt");

      await git.discard({ projectPath, file: "*" });

      expect(
        (
          await runGitCommand(projectPath, ["status", "--porcelain"])
        ).stdout.trim(),
      ).toBe("M a.txt");
      expect(await fs.readFile(path.join(projectPath, "*"), "utf-8")).toBe(
        "head-star\n",
      );
      expect(await fs.readFile(path.join(projectPath, "a.txt"), "utf-8")).toBe(
        "edited\n",
      );
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("prefers the requested path's own entry over a rename original", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-discard-"),
    );
    try {
      await initRepoWithCommit(projectPath);
      await runGitCommand(projectPath, ["config", "status.renames", "copies"]);
      await fs.writeFile(path.join(projectPath, "z.txt"), "one\n", "utf-8");
      await runGitCommand(projectPath, ["rm", "a.txt"]);
      await runGitCommand(projectPath, ["add", "z.txt"]);
      await runGitCommand(projectPath, ["commit", "-m", "add z"]);
      // The copy destination sorts before its source, so the copy entry is
      // listed first. The rename-only fallback gate keeps that entry from
      // ever matching the source: this fixture pins a copy-source discard
      // reverting the source's own modification while the copy's index
      // entry stays untouched.
      await fs.copyFile(
        path.join(projectPath, "z.txt"),
        path.join(projectPath, "a2.txt"),
      );
      await runGitCommand(projectPath, ["add", "-N", "a2.txt"]);
      await fs.writeFile(
        path.join(projectPath, "z.txt"),
        "one\nedit\n",
        "utf-8",
      );
      const listed = (
        await runGitCommand(projectPath, ["status", "--porcelain"])
      ).stdout;
      expect(listed).toContain("C z.txt -> a2.txt");
      expect(listed).toContain("M z.txt");

      await git.discard({ projectPath, file: "z.txt" });

      // The source's own modification entry governs: its edit reverts while
      // the copy destination keeps its intent-to-add entry untouched.
      expect(await fs.readFile(path.join(projectPath, "z.txt"), "utf-8")).toBe(
        "one\n",
      );
      expect(
        (await runGitCommand(projectPath, ["ls-files", "--cached", "a2.txt"]))
          .stdout,
      ).toContain("a2.txt");
      expect(await fs.readFile(path.join(projectPath, "a2.txt"), "utf-8")).toBe(
        "one\n",
      );
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("resets only the destination when discarding a worktree copy", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-discard-"),
    );
    try {
      await initRepoWithCommit(projectPath);
      await runGitCommand(projectPath, ["config", "status.renames", "copies"]);
      await fs.writeFile(path.join(projectPath, "z.txt"), "one\n", "utf-8");
      await runGitCommand(projectPath, ["rm", "a.txt"]);
      await runGitCommand(projectPath, ["add", "z.txt"]);
      await runGitCommand(projectPath, ["commit", "-m", "add z"]);
      // The copy source carries its own unstaged edit, which the discard of
      // the copy destination must not touch.
      await fs.copyFile(
        path.join(projectPath, "z.txt"),
        path.join(projectPath, "a2.txt"),
      );
      await runGitCommand(projectPath, ["add", "-N", "a2.txt"]);
      await fs.writeFile(
        path.join(projectPath, "z.txt"),
        "one\nedit\n",
        "utf-8",
      );
      const listed = (
        await runGitCommand(projectPath, ["status", "--porcelain"])
      ).stdout;
      expect(listed).toContain("C z.txt -> a2.txt");

      await git.discard({ projectPath, file: "a2.txt" });

      expect(
        (
          await runGitCommand(projectPath, ["status", "--porcelain"])
        ).stdout.trim(),
      ).toBe("M z.txt\n?? a2.txt");
      expect(await fs.readFile(path.join(projectPath, "z.txt"), "utf-8")).toBe(
        "one\nedit\n",
      );
      expect(await fs.readFile(path.join(projectPath, "a2.txt"), "utf-8")).toBe(
        "one\n",
      );
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("discards through a project path containing a newline", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-discard-"),
    );
    try {
      await initRepoWithCommit(projectPath);
      await fs.mkdir(path.join(projectPath, "sub\nline"), { recursive: true });
      await fs.writeFile(
        path.join(projectPath, "sub\nline", "x.txt"),
        "sub content\n",
        "utf-8",
      );
      await runGitCommand(projectPath, ["add", "--", "sub\nline/x.txt"]);
      await runGitCommand(projectPath, ["commit", "-m", "add nested"]);
      await fs.writeFile(
        path.join(projectPath, "sub\nline", "x.txt"),
        "edited\n",
        "utf-8",
      );

      await git.discard({
        projectPath: path.join(projectPath, "sub\nline"),
        file: "x.txt",
      });

      expect(
        (
          await runGitCommand(projectPath, ["status", "--porcelain"])
        ).stdout.trim(),
      ).toBe("");
      expect(
        await fs.readFile(
          path.join(projectPath, "sub\nline", "x.txt"),
          "utf-8",
        ),
      ).toBe("sub content\n");
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("restores a staged addition consumed by a worktree rename", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-discard-"),
    );
    try {
      await initRepoWithCommit(projectPath);
      await runGitCommand(projectPath, ["config", "status.renames", "true"]);
      await fs.writeFile(
        path.join(projectPath, "b.txt"),
        "staged content\n",
        "utf-8",
      );
      await runGitCommand(projectPath, ["add", "b.txt"]);
      await fs.rename(
        path.join(projectPath, "b.txt"),
        path.join(projectPath, "c.txt"),
      );
      await runGitCommand(projectPath, ["add", "-N", "c.txt"]);
      // The staged-only entry for the source shadows the worktree rename that
      // consumed it; the request names the rename's source side.
      expect(
        (
          await runGitCommand(projectPath, ["status", "--porcelain"])
        ).stdout.trim(),
      ).toBe("A  b.txt\n R b.txt -> c.txt");

      await git.discard({ projectPath, file: "b.txt" });

      expect(
        (
          await runGitCommand(projectPath, ["status", "--porcelain"])
        ).stdout.trim(),
      ).toBe("A  b.txt\n?? c.txt");
      expect(await fs.readFile(path.join(projectPath, "b.txt"), "utf-8")).toBe(
        "staged content\n",
      );
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("restores a staged modification consumed by a worktree rename", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-discard-"),
    );
    try {
      await initRepoWithCommit(projectPath);
      await runGitCommand(projectPath, ["config", "status.renames", "true"]);
      await fs.writeFile(path.join(projectPath, "s.txt"), "base\n", "utf-8");
      await runGitCommand(projectPath, ["add", "s.txt"]);
      await runGitCommand(projectPath, ["commit", "-m", "add s"]);
      await fs.writeFile(
        path.join(projectPath, "s.txt"),
        "staged edit\n",
        "utf-8",
      );
      await runGitCommand(projectPath, ["add", "s.txt"]);
      await fs.rename(
        path.join(projectPath, "s.txt"),
        path.join(projectPath, "t.txt"),
      );
      await runGitCommand(projectPath, ["add", "-N", "t.txt"]);
      expect(
        (
          await runGitCommand(projectPath, ["status", "--porcelain"])
        ).stdout.trim(),
      ).toBe("M  s.txt\n R s.txt -> t.txt");

      await git.discard({ projectPath, file: "s.txt" });

      expect(
        (
          await runGitCommand(projectPath, ["status", "--porcelain"])
        ).stdout.trim(),
      ).toBe("M  s.txt\n?? t.txt");
      expect(await fs.readFile(path.join(projectPath, "s.txt"), "utf-8")).toBe(
        "staged edit\n",
      );
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("leaves index-only deletions untouched instead of failing restore", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-discard-"),
    );
    try {
      await initRepoWithCommit(projectPath);
      await fs.rm(path.join(projectPath, "a.txt"));
      await runGitCommand(projectPath, ["rm", "--cached", "a.txt"]);
      expect(
        (
          await runGitCommand(projectPath, ["status", "--porcelain"])
        ).stdout.trim(),
      ).toBe("D  a.txt");

      await git.discard({ projectPath, file: "a.txt" });

      expect(
        (
          await runGitCommand(projectPath, ["status", "--porcelain"])
        ).stdout.trim(),
      ).toBe("D  a.txt");
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });
});
