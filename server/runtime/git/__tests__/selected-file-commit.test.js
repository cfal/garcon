import { describe, it, expect } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createGitOperations } from "../git-service.js";
import { runGitCommand, initRepoWithCommit } from "./repository-fixture.js";

async function waitForPath(filePath) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    try {
      await fs.access(filePath);
      return;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

describe("selected-file commits", () => {
  it("excludes unrelated staged changes", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-selected-commit-"),
    );
    const git = createGitOperations();

    try {
      await initRepoWithCommit(projectPath);
      await fs.writeFile(
        path.join(projectPath, "a.txt"),
        "selected\n",
        "utf-8",
      );
      await fs.writeFile(path.join(projectPath, "new.txt"), "new\n", "utf-8");
      await fs.writeFile(
        path.join(projectPath, "HEAD"),
        "untracked\n",
        "utf-8",
      );
      await fs.writeFile(
        path.join(projectPath, "unrelated.txt"),
        "staged\n",
        "utf-8",
      );
      await runGitCommand(projectPath, ["add", "unrelated.txt"]);

      const result = await git.commit({
        projectPath,
        message: "selected change",
        files: ["a.txt", "new.txt"],
      });

      const committed = await runGitCommand(projectPath, [
        "show",
        "--format=",
        "--name-only",
        "HEAD",
        "--",
      ]);
      const staged = await runGitCommand(projectPath, [
        "diff",
        "--cached",
        "--name-only",
      ]);
      expect(result.commitScope).toBe("selected-files");
      expect(result.indexSynchronized).toBe(true);
      expect(committed.stdout.trim().split("\n")).toEqual(["a.txt", "new.txt"]);
      expect(staged.stdout.trim()).toBe("unrelated.txt");
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("serializes concurrent selected-file commits", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-concurrent-selected-commit-"),
    );
    const git = createGitOperations();

    try {
      await initRepoWithCommit(projectPath);
      await fs.writeFile(path.join(projectPath, "a.txt"), "first\n", "utf-8");
      await fs.writeFile(path.join(projectPath, "b.txt"), "second\n", "utf-8");
      const hookPath = path.join(projectPath, ".git", "hooks", "pre-commit");
      await fs.writeFile(hookPath, "#!/bin/sh\nsleep 0.2\n", "utf-8");
      await fs.chmod(hookPath, 0o755);

      await Promise.all([
        git.commit({ projectPath, message: "first change", files: ["a.txt"] }),
        git.commit({ projectPath, message: "second change", files: ["b.txt"] }),
      ]);

      const { stdout } = await runGitCommand(projectPath, [
        "log",
        "-2",
        "--format=%H",
      ]);
      const commits = await Promise.all(
        stdout
          .trim()
          .split("\n")
          .map(async (commit) => {
            const result = await runGitCommand(projectPath, [
              "show",
              "--format=%s",
              "--name-only",
              commit,
            ]);
            return result.stdout.trim().split("\n").filter(Boolean);
          }),
      );
      expect(
        commits.sort((left, right) => left[0].localeCompare(right[0])),
      ).toEqual([
        ["first change", "a.txt"],
        ["second change", "b.txt"],
      ]);
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("reports a durable commit with failed index synchronization", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-locked-index-commit-"),
    );
    const git = createGitOperations();
    const indexLockPath = path.join(projectPath, ".git", "index.lock");

    try {
      await initRepoWithCommit(projectPath);
      await fs.writeFile(
        path.join(projectPath, "a.txt"),
        "selected\n",
        "utf-8",
      );
      await fs.writeFile(indexLockPath, "locked\n", "utf-8");

      await expect(
        git.commit({
          projectPath,
          message: "selected change",
          files: ["a.txt"],
        }),
      ).resolves.toMatchObject({
        success: true,
        commitScope: "selected-files",
        indexSynchronized: false,
      });

      const committed = await runGitCommand(projectPath, [
        "show",
        "HEAD:a.txt",
      ]);
      expect(committed.stdout).toBe("selected\n");
    } finally {
      await fs.rm(indexLockPath, { force: true });
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  }, 20_000);

  it("removes stale temporary index files before committing", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-stale-index-commit-"),
    );
    const git = createGitOperations();

    try {
      await initRepoWithCommit(projectPath);
      await fs.writeFile(
        path.join(projectPath, "a.txt"),
        "selected\n",
        "utf-8",
      );
      const staleIndexPath = path.join(
        projectPath,
        ".git",
        ".garcon-index-stale",
      );
      const staleLockPath = `${staleIndexPath}.lock`;
      await fs.writeFile(staleIndexPath, "stale\n", "utf-8");
      await fs.writeFile(staleLockPath, "stale\n", "utf-8");
      const staleTime = new Date(Date.now() - 25 * 60 * 60 * 1000);
      await Promise.all([
        fs.utimes(staleIndexPath, staleTime, staleTime),
        fs.utimes(staleLockPath, staleTime, staleTime),
      ]);

      await git.commit({
        projectPath,
        message: "selected change",
        files: ["a.txt"],
      });

      await expect(fs.access(staleIndexPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(fs.access(staleLockPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("preserves the real index when a selected-file commit fails", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-failed-selected-commit-"),
    );
    const git = createGitOperations();

    try {
      await initRepoWithCommit(projectPath);
      await fs.writeFile(
        path.join(projectPath, "a.txt"),
        "selected\n",
        "utf-8",
      );
      await fs.writeFile(
        path.join(projectPath, "unrelated.txt"),
        "staged\n",
        "utf-8",
      );
      await runGitCommand(projectPath, ["add", "unrelated.txt"]);
      const hookPath = path.join(projectPath, ".git", "hooks", "pre-commit");
      await fs.writeFile(hookPath, "#!/bin/sh\nexit 1\n", "utf-8");
      await fs.chmod(hookPath, 0o755);

      await expect(
        git.commit({
          projectPath,
          message: "selected change",
          files: ["a.txt"],
        }),
      ).rejects.toThrow();

      const staged = await runGitCommand(projectPath, [
        "diff",
        "--cached",
        "--name-only",
      ]);
      expect(staged.stdout.trim()).toBe("unrelated.txt");
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("synchronizes hook-restaged files after a selected-file commit", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-hook-selected-commit-"),
    );
    const git = createGitOperations();

    try {
      await initRepoWithCommit(projectPath);
      await fs.writeFile(
        path.join(projectPath, "a.txt"),
        "selected\n",
        "utf-8",
      );
      await fs.writeFile(
        path.join(projectPath, "unrelated.txt"),
        "staged\n",
        "utf-8",
      );
      await runGitCommand(projectPath, ["add", "unrelated.txt"]);
      const hookPath = path.join(projectPath, ".git", "hooks", "pre-commit");
      await fs.writeFile(
        hookPath,
        "#!/bin/sh\nprintf 'formatted\\n' > a.txt\ngit add -- a.txt\n",
        "utf-8",
      );
      await fs.chmod(hookPath, 0o755);

      await git.commit({
        projectPath,
        message: "selected change",
        files: ["a.txt"],
      });

      const committed = await runGitCommand(projectPath, [
        "show",
        "HEAD:a.txt",
      ]);
      const staged = await runGitCommand(projectPath, [
        "diff",
        "--cached",
        "--name-only",
      ]);
      expect(committed.stdout).toBe("formatted\n");
      expect(await fs.readFile(path.join(projectPath, "a.txt"), "utf-8")).toBe(
        "formatted\n",
      );
      expect(staged.stdout.trim()).toBe("unrelated.txt");
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("synchronizes unselected paths added by a pre-commit hook", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-hook-added-path-"),
    );
    const git = createGitOperations();

    try {
      await initRepoWithCommit(projectPath);
      await fs.writeFile(
        path.join(projectPath, "a.txt"),
        "selected\n",
        "utf-8",
      );
      await fs.writeFile(
        path.join(projectPath, "extra.txt"),
        "hooked\n",
        "utf-8",
      );
      const hookPath = path.join(projectPath, ".git", "hooks", "pre-commit");
      await fs.writeFile(
        hookPath,
        "#!/bin/sh\ngit add -- extra.txt\n",
        "utf-8",
      );
      await fs.chmod(hookPath, 0o755);

      const result = await git.commit({
        projectPath,
        message: "selected change",
        files: ["a.txt"],
      });

      const committed = await runGitCommand(projectPath, [
        "show",
        "--format=",
        "--name-only",
        "HEAD",
      ]);
      const status = await runGitCommand(projectPath, [
        "status",
        "--porcelain",
      ]);
      expect(result.indexSynchronized).toBe(true);
      expect(committed.stdout.trim().split("\n")).toEqual([
        "a.txt",
        "extra.txt",
      ]);
      expect(status.stdout).toBe("");
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("serializes whole-index commits behind selected-file synchronization", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-serialized-index-commit-"),
    );
    const git = createGitOperations();
    const selectedHookPath = path.join(projectPath, ".selected-hook-entered");
    const realHookPath = path.join(projectPath, ".real-hook-entered");
    const releaseHookPath = path.join(projectPath, ".release-hook");
    let selectedCommit;
    let indexCommitOutcome;

    try {
      await initRepoWithCommit(projectPath);
      await fs.writeFile(
        path.join(projectPath, "a.txt"),
        "selected\n",
        "utf-8",
      );
      const hookPath = path.join(projectPath, ".git", "hooks", "post-commit");
      await fs.writeFile(
        hookPath,
        [
          "#!/bin/sh",
          'case "$GIT_INDEX_FILE" in',
          "  *.garcon-index-*) touch .selected-hook-entered ;;",
          "  *) touch .real-hook-entered ;;",
          "esac",
          "while [ ! -f .release-hook ]; do sleep 0.01; done",
          "",
        ].join("\n"),
        "utf-8",
      );
      await fs.chmod(hookPath, 0o755);

      selectedCommit = git.commit({
        projectPath,
        message: "selected change",
        files: ["a.txt"],
      });
      await waitForPath(selectedHookPath);
      indexCommitOutcome = git
        .commitIndex({
          projectPath,
          message: "stale index",
        })
        .then(
          (result) => ({ status: "fulfilled", result }),
          (error) => ({ status: "rejected", error }),
        );

      await Bun.sleep(500);
      await expect(fs.access(realHookPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
      await fs.writeFile(releaseHookPath, "released\n", "utf-8");
      await selectedCommit;
      const outcome = await indexCommitOutcome;
      expect(outcome.status).toBe("rejected");
      expect(outcome.error?.message).toMatch(/nothing (?:added )?to commit/);

      const log = await runGitCommand(projectPath, ["log", "--format=%s"]);
      expect(log.stdout.trim().split("\n")).toEqual([
        "selected change",
        "initial",
      ]);
    } finally {
      await fs
        .writeFile(releaseHookPath, "released\n", "utf-8")
        .catch(() => undefined);
      await Promise.allSettled(
        [selectedCommit, indexCommitOutcome].filter(Boolean),
      );
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  }, 10_000);

  it("completes a conflicted merge with the resolved index", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-merge-commit-"),
    );
    const git = createGitOperations();

    try {
      await initRepoWithCommit(projectPath);
      await runGitCommand(projectPath, ["checkout", "-b", "feature"]);
      await fs.writeFile(path.join(projectPath, "a.txt"), "feature\n", "utf-8");
      await runGitCommand(projectPath, ["commit", "-am", "feature"]);
      await runGitCommand(projectPath, ["checkout", "master"]);
      await fs.writeFile(path.join(projectPath, "a.txt"), "main\n", "utf-8");
      await runGitCommand(projectPath, ["commit", "-am", "main"]);
      await expect(
        runGitCommand(projectPath, ["merge", "feature"]),
      ).rejects.toThrow("CONFLICT");
      await fs.writeFile(
        path.join(projectPath, "a.txt"),
        "resolved\n",
        "utf-8",
      );

      const result = await git.commit({
        projectPath,
        message: "merge feature",
        files: ["a.txt"],
      });

      const parents = await runGitCommand(projectPath, [
        "show",
        "-s",
        "--format=%P",
        "HEAD",
      ]);
      expect(result.commitScope).toBe("whole-index");
      expect(parents.stdout.trim().split(" ")).toHaveLength(2);
      const status = await runGitCommand(projectPath, [
        "status",
        "--porcelain",
      ]);
      expect(status.stdout).toBe("");
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("completes a conflicted cherry-pick with the resolved index", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-cherry-pick-commit-"),
    );
    const git = createGitOperations();

    try {
      await initRepoWithCommit(projectPath);
      await runGitCommand(projectPath, ["checkout", "-b", "feature"]);
      await fs.writeFile(path.join(projectPath, "a.txt"), "feature\n", "utf-8");
      await fs.writeFile(path.join(projectPath, "b.txt"), "feature\n", "utf-8");
      await runGitCommand(projectPath, ["add", "a.txt", "b.txt"]);
      await runGitCommand(projectPath, ["commit", "-m", "feature change"]);
      const featureCommit = await runGitCommand(projectPath, [
        "rev-parse",
        "HEAD",
      ]);

      await runGitCommand(projectPath, ["checkout", "master"]);
      await fs.writeFile(path.join(projectPath, "a.txt"), "main\n", "utf-8");
      await runGitCommand(projectPath, ["commit", "-am", "main change"]);
      await expect(
        runGitCommand(projectPath, [
          "cherry-pick",
          featureCommit.stdout.trim(),
        ]),
      ).rejects.toThrow();
      await fs.writeFile(
        path.join(projectPath, "a.txt"),
        "resolved\n",
        "utf-8",
      );

      await git.commit({
        projectPath,
        message: "feature change",
        files: ["a.txt"],
      });

      const committed = await runGitCommand(projectPath, [
        "show",
        "--format=",
        "--name-only",
        "HEAD",
      ]);
      expect(committed.stdout.trim().split("\n")).toEqual(["a.txt", "b.txt"]);
      const status = await runGitCommand(projectPath, [
        "status",
        "--porcelain",
      ]);
      expect(status.stdout).toBe("");
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("completes a conflicted revert with the resolved index", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-revert-commit-"),
    );
    const git = createGitOperations();

    try {
      await initRepoWithCommit(projectPath);
      await fs.writeFile(path.join(projectPath, "a.txt"), "target\n", "utf-8");
      await fs.writeFile(path.join(projectPath, "b.txt"), "target\n", "utf-8");
      await runGitCommand(projectPath, ["add", "a.txt", "b.txt"]);
      await runGitCommand(projectPath, ["commit", "-m", "two-file change"]);
      const reverted = await runGitCommand(projectPath, ["rev-parse", "HEAD"]);

      await fs.writeFile(path.join(projectPath, "a.txt"), "later\n", "utf-8");
      await runGitCommand(projectPath, ["commit", "-am", "later change"]);
      await expect(
        runGitCommand(projectPath, ["revert", reverted.stdout.trim()]),
      ).rejects.toThrow("could not revert");
      await fs.writeFile(path.join(projectPath, "a.txt"), "one\n", "utf-8");

      await git.commit({
        projectPath,
        message: "revert two-file change",
        files: ["a.txt"],
      });

      const committed = await runGitCommand(projectPath, [
        "show",
        "--format=",
        "--name-only",
        "HEAD",
      ]);
      expect(committed.stdout.trim().split("\n")).toEqual(["a.txt", "b.txt"]);
      const status = await runGitCommand(projectPath, [
        "status",
        "--porcelain",
      ]);
      expect(status.stdout).toBe("");
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("completes a conflicted rebase with the resolved index", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-rebase-commit-"),
    );
    const git = createGitOperations();

    try {
      await initRepoWithCommit(projectPath);
      await runGitCommand(projectPath, ["checkout", "-b", "feature"]);
      await fs.writeFile(path.join(projectPath, "a.txt"), "feature\n", "utf-8");
      await fs.writeFile(path.join(projectPath, "b.txt"), "feature\n", "utf-8");
      await runGitCommand(projectPath, ["add", "a.txt", "b.txt"]);
      await runGitCommand(projectPath, ["commit", "-m", "feature change"]);

      await runGitCommand(projectPath, ["checkout", "master"]);
      await fs.writeFile(path.join(projectPath, "a.txt"), "main\n", "utf-8");
      await runGitCommand(projectPath, ["commit", "-am", "main change"]);
      await runGitCommand(projectPath, ["checkout", "feature"]);
      await expect(
        runGitCommand(projectPath, ["rebase", "master"]),
      ).rejects.toThrow("could not apply");
      await fs.writeFile(
        path.join(projectPath, "a.txt"),
        "resolved\n",
        "utf-8",
      );

      await git.commit({
        projectPath,
        message: "feature change",
        files: ["a.txt"],
      });

      const committed = await runGitCommand(projectPath, [
        "show",
        "--format=",
        "--name-only",
        "HEAD",
      ]);
      expect(committed.stdout.trim().split("\n")).toEqual(["a.txt", "b.txt"]);
      await runGitCommand(projectPath, ["rebase", "--continue"]);
      const commitCount = await runGitCommand(projectPath, [
        "rev-list",
        "--count",
        "HEAD",
      ]);
      expect(commitCount.stdout.trim()).toBe("3");
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("completes an apply-backend rebase conflict with the resolved index", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-rebase-apply-commit-"),
    );
    const git = createGitOperations();

    try {
      await initRepoWithCommit(projectPath);
      await runGitCommand(projectPath, ["checkout", "-b", "feature"]);
      await fs.writeFile(path.join(projectPath, "a.txt"), "feature\n", "utf-8");
      await fs.writeFile(path.join(projectPath, "b.txt"), "feature\n", "utf-8");
      await runGitCommand(projectPath, ["add", "a.txt", "b.txt"]);
      await runGitCommand(projectPath, ["commit", "-m", "feature change"]);

      await runGitCommand(projectPath, ["checkout", "master"]);
      await fs.writeFile(path.join(projectPath, "a.txt"), "main\n", "utf-8");
      await runGitCommand(projectPath, ["commit", "-am", "main change"]);
      await runGitCommand(projectPath, ["checkout", "feature"]);
      await expect(
        runGitCommand(projectPath, ["rebase", "--apply", "master"]),
      ).rejects.toThrow();
      await fs.access(path.join(projectPath, ".git", "rebase-apply"));
      await fs.writeFile(
        path.join(projectPath, "a.txt"),
        "resolved\n",
        "utf-8",
      );

      await git.commit({
        projectPath,
        message: "feature change",
        files: ["a.txt"],
      });

      const committed = await runGitCommand(projectPath, [
        "show",
        "--format=",
        "--name-only",
        "HEAD",
      ]);
      expect(committed.stdout.trim().split("\n")).toEqual(["a.txt", "b.txt"]);
      const status = await runGitCommand(projectPath, [
        "status",
        "--porcelain",
      ]);
      expect(status.stdout).toBe("");
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("keeps selected-file isolation at an interactive rebase edit stop", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-rebase-edit-commit-"),
    );
    const git = createGitOperations();

    try {
      await initRepoWithCommit(projectPath);
      await runGitCommand(projectPath, ["checkout", "-b", "feature"]);
      await fs.writeFile(
        path.join(projectPath, "feature.txt"),
        "feature\n",
        "utf-8",
      );
      await runGitCommand(projectPath, ["add", "feature.txt"]);
      await runGitCommand(projectPath, ["commit", "-m", "feature change"]);

      await runGitCommand(projectPath, ["checkout", "master"]);
      await fs.writeFile(path.join(projectPath, "main.txt"), "main\n", "utf-8");
      await runGitCommand(projectPath, ["add", "main.txt"]);
      await runGitCommand(projectPath, ["commit", "-m", "main change"]);
      await runGitCommand(projectPath, ["checkout", "feature"]);

      const sequenceEditorPath = path.join(
        projectPath,
        ".git",
        "sequence-editor.cjs",
      );
      await fs.writeFile(
        sequenceEditorPath,
        [
          "const fs = require('node:fs');",
          "const todoPath = process.argv.at(-1);",
          "const todo = fs.readFileSync(todoPath, 'utf8');",
          "fs.writeFileSync(todoPath, todo.replace(/^pick /m, 'edit '));",
        ].join("\n"),
        "utf-8",
      );
      await runGitCommand(projectPath, ["rebase", "-i", "master"], {
        env: {
          GIT_SEQUENCE_EDITOR: `${JSON.stringify(process.execPath)} ${JSON.stringify(sequenceEditorPath)}`,
        },
      });
      await fs.access(path.join(projectPath, ".git", "rebase-merge", "amend"));

      await fs.writeFile(
        path.join(projectPath, "a.txt"),
        "selected\n",
        "utf-8",
      );
      await fs.writeFile(
        path.join(projectPath, "unrelated.txt"),
        "unrelated\n",
        "utf-8",
      );
      await runGitCommand(projectPath, ["add", "unrelated.txt"]);

      await git.commit({
        projectPath,
        message: "selected change",
        files: ["a.txt"],
      });

      const committed = await runGitCommand(projectPath, [
        "show",
        "--format=",
        "--name-only",
        "HEAD",
      ]);
      expect(committed.stdout.trim()).toBe("a.txt");
      const status = await runGitCommand(projectPath, [
        "status",
        "--porcelain",
      ]);
      expect(status.stdout.trim()).toBe("A  unrelated.txt");
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });
});
