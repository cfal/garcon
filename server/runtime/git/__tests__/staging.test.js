import { describe, it, expect } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createGitOperations } from "../git-service.js";
import { runGitCommand, initRepoWithCommit } from "./repository-fixture.js";

describe("stage path operations", () => {
  it("stages and unstages multiple pathspecs in one service call", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-stage-paths-"),
    );
    const git = createGitOperations();

    try {
      await initRepoWithCommit(projectPath);
      await fs.writeFile(
        path.join(projectPath, "remove.txt"),
        "delete me\n",
        "utf-8",
      );
      await runGitCommand(projectPath, ["add", "remove.txt"]);
      await runGitCommand(projectPath, ["commit", "-m", "add removable file"]);

      await fs.writeFile(path.join(projectPath, "a.txt"), "changed\n", "utf-8");
      await fs.rm(path.join(projectPath, "remove.txt"));
      await fs.writeFile(
        path.join(projectPath, "new.txt"),
        "new file\n",
        "utf-8",
      );

      await git.stagePaths({
        projectPath,
        paths: ["a.txt", "remove.txt", "new.txt"],
        mode: "stage",
      });

      const staged = await runGitCommand(projectPath, [
        "diff",
        "--cached",
        "--name-status",
      ]);
      expect(staged.stdout.trim().split("\n").sort()).toEqual([
        "A\tnew.txt",
        "D\tremove.txt",
        "M\ta.txt",
      ]);

      await git.stagePaths({
        projectPath,
        paths: ["a.txt", "remove.txt", "new.txt"],
        mode: "unstage",
      });

      const unstaged = await runGitCommand(projectPath, [
        "diff",
        "--cached",
        "--name-only",
      ]);
      expect(unstaged.stdout.trim()).toBe("");
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });
});
