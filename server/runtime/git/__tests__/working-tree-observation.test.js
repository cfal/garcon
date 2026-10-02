import { describe, it, expect } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createGitOperations } from "../git-service.js";
import { runGitCommand, initRepoWithCommit } from "./repository-fixture.js";

describe("getWorkingTreeFingerprint", () => {
  it("matches the ready snapshot baseline for the same workbench state", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-freshness-baseline-"),
    );
    const git = createGitOperations();

    try {
      await initRepoWithCommit(projectPath);
      await fs.writeFile(
        path.join(projectPath, "a.txt"),
        "one\nchanged\n",
        "utf-8",
      );

      const snapshot = await git.getWorkbenchSnapshot({
        projectPath,
        mode: "working",
        context: 5,
      });
      const current = await git.getWorkingTreeFingerprint({ projectPath });

      expect(snapshot.status).toBe("ready");
      expect(current.status).toBe("ready");
      expect(snapshot.workbenchFingerprint).toBe(current.fingerprint);
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("changes for same-status edits, untracked edits, staged changes, and HEAD changes", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-freshness-changes-"),
    );
    const git = createGitOperations();

    try {
      await initRepoWithCommit(projectPath);
      const base = await git.getWorkingTreeFingerprint({ projectPath });
      expect(base.status).toBe("ready");

      await fs.writeFile(
        path.join(projectPath, "a.txt"),
        "one\nfirst modified state\n",
        "utf-8",
      );
      const modified = await git.getWorkingTreeFingerprint({ projectPath });
      expect(modified.status).toBe("ready");
      expect(modified.fingerprint).not.toBe(base.fingerprint);

      await fs.writeFile(
        path.join(projectPath, "a.txt"),
        "one\nsecond modified state with more bytes\n",
        "utf-8",
      );
      const sameStatusModified = await git.getWorkingTreeFingerprint({
        projectPath,
      });
      expect(sameStatusModified.status).toBe("ready");
      expect(sameStatusModified.fingerprint).not.toBe(modified.fingerprint);

      await fs.writeFile(
        path.join(projectPath, "space and\ttab.txt"),
        "new\n",
        "utf-8",
      );
      const untracked = await git.getWorkingTreeFingerprint({ projectPath });
      expect(untracked.status).toBe("ready");
      expect(untracked.fingerprint).not.toBe(sameStatusModified.fingerprint);

      await fs.writeFile(
        path.join(projectPath, "space and\ttab.txt"),
        "new\nchanged\n",
        "utf-8",
      );
      const editedUntracked = await git.getWorkingTreeFingerprint({
        projectPath,
      });
      expect(editedUntracked.status).toBe("ready");
      expect(editedUntracked.fingerprint).not.toBe(untracked.fingerprint);

      await runGitCommand(projectPath, ["add", "a.txt"]);
      const staged = await git.getWorkingTreeFingerprint({ projectPath });
      expect(staged.status).toBe("ready");
      expect(staged.fingerprint).not.toBe(editedUntracked.fingerprint);

      await runGitCommand(projectPath, ["commit", "-m", "update tracked file"]);
      const committed = await git.getWorkingTreeFingerprint({ projectPath });
      expect(committed.status).toBe("ready");
      expect(committed.fingerprint).not.toBe(staged.fingerprint);
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("returns a typed non-repository fingerprint response", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-freshness-not-repo-"),
    );
    const git = createGitOperations();

    try {
      const result = await git.getWorkingTreeFingerprint({ projectPath });
      expect(result).toMatchObject({
        status: "not-git-repository",
        project: projectPath,
        fingerprint: null,
      });
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });
});
