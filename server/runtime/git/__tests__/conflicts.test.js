import { describe, it, expect } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createGitOperations } from "../git-service.js";
import { runGitCommand, initRepoWithCommit } from "./repository-fixture.js";
import { materializeReviewResponse } from "./rendered-patch-fixture.js";

describe("porcelain conflict and comparison robustness", () => {
  it("returns bounded conflict details for large conflicted files", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-conflict-limit-"),
    );
    const git = createGitOperations();

    try {
      await initRepoWithCommit(projectPath);
      await runGitCommand(projectPath, ["checkout", "-b", "side"]);
      await fs.writeFile(
        path.join(projectPath, "a.txt"),
        `one\n${"side\n".repeat(70_000)}`,
        "utf-8",
      );
      await runGitCommand(projectPath, ["commit", "-am", "side edit"]);
      await runGitCommand(projectPath, ["checkout", "master"]);
      await fs.writeFile(
        path.join(projectPath, "a.txt"),
        `one\n${"main\n".repeat(70_000)}`,
        "utf-8",
      );
      await runGitCommand(projectPath, ["commit", "-am", "main edit"]);
      try {
        await runGitCommand(projectPath, ["merge", "side"]);
      } catch {
        // Expected merge conflict.
      }

      const { conflicts } = await git.getConflicts({ projectPath });
      const conflict = conflicts.find((entry) => entry.path === "a.txt");
      const details = await git.getConflictDetails({
        projectPath,
        file: "a.txt",
      });

      expect(conflict).toMatchObject({
        status: "UU",
        baseAvailable: true,
        oursAvailable: true,
        theirsAvailable: true,
      });
      expect(details.truncated).toBe(true);
      expect(details.ours).toMatchObject({
        content: null,
        truncated: true,
        limitReason: "content-too-large",
      });
      expect(details.theirs).toMatchObject({
        content: null,
        truncated: true,
        limitReason: "content-too-large",
      });
      expect(details.working.byteLength).toBeGreaterThan(0);

      const comparison = await git.getComparisonSnapshot({
        projectPath,
        from: { kind: "revision", revision: "HEAD" },
        to: { kind: "working-tree" },
        mode: "direct",
      });
      expect(
        comparison.files.find((file) => file.path === "a.txt"),
      ).toMatchObject({
        bodyState: "too-large",
        limitReason: "unsupported-file-kind",
      });
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("reports no conflicts when a rename source name parses as an unmerged status", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-conflict-rename-"),
    );
    const git = createGitOperations();

    try {
      await initRepoWithCommit(projectPath);
      await runGitCommand(projectPath, ["config", "status.renames", "true"]);
      // A rename source literally named "UU a.txt" turns into a second
      // porcelain token; a parser that fails to consume it would fabricate a
      // UU conflict from the file name itself.
      await fs.writeFile(path.join(projectPath, "UU a.txt"), "one\n", "utf-8");
      await runGitCommand(projectPath, ["add", "UU a.txt"]);
      await runGitCommand(projectPath, ["commit", "-m", "add named source"]);
      await fs.copyFile(
        path.join(projectPath, "UU a.txt"),
        path.join(projectPath, "dst.txt"),
      );
      await runGitCommand(projectPath, ["add", "dst.txt"]);
      await runGitCommand(projectPath, ["commit", "-m", "add dst"]);
      await runGitCommand(projectPath, ["rm", "--cached", "dst.txt"]);
      await runGitCommand(projectPath, ["add", "-N", "dst.txt"]);
      await fs.rm(path.join(projectPath, "UU a.txt"));
      expect(
        (await runGitCommand(projectPath, ["status", "--porcelain", "-z"]))
          .stdout,
      ).toBe("DR dst.txt\0UU a.txt\0");

      const { conflicts } = await git.getConflicts({ projectPath });

      expect(conflicts).toEqual([]);
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("parses compare output for paths containing tabs", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-compare-z-"),
    );
    const git = createGitOperations();
    const tabbedPath = "a\tb.txt";
    const renamedPath = "c\td.txt";

    try {
      await runGitCommand(projectPath, ["init"]);
      await runGitCommand(projectPath, [
        "config",
        "user.email",
        "test@example.com",
      ]);
      await runGitCommand(projectPath, ["config", "user.name", "Test User"]);
      await fs.writeFile(path.join(projectPath, tabbedPath), "one\n", "utf-8");
      await runGitCommand(projectPath, ["add", tabbedPath]);
      await runGitCommand(projectPath, ["commit", "-m", "initial"]);
      await runGitCommand(projectPath, ["checkout", "-b", "next"]);
      await runGitCommand(projectPath, ["mv", tabbedPath, renamedPath]);
      await fs.writeFile(
        path.join(projectPath, renamedPath),
        "one\ntwo\n",
        "utf-8",
      );
      await runGitCommand(projectPath, ["commit", "-am", "rename tabbed path"]);

      const compare = await git.getComparisonSnapshot({
        projectPath,
        from: { kind: "revision", revision: "master" },
        to: { kind: "revision", revision: "next" },
        mode: "direct",
      });

      expect(compare.status).toBe("ready");
      expect(compare.files).toContainEqual(
        expect.objectContaining({
          status: "renamed",
          rawStatus: expect.stringMatching(/^R/),
          originalPath: tabbedPath,
          path: renamedPath,
          additions: 1,
          deletions: 0,
        }),
      );

      const bodies = materializeReviewResponse(
        await git.getReviewDocumentFileBodies({
          projectPath,
          documentId: compare.documentId,
          files: [{ path: renamedPath, originalPath: tabbedPath }].map(
            (file) => file.path,
          ),
          purpose: "visible",
        }),
      );
      expect(bodies.files[renamedPath]).toMatchObject({
        path: renamedPath,
        bodyFingerprint: compare.files[0].bodyFingerprint,
      });
      expect(bodies.files[renamedPath].rows).toContainEqual(
        expect.objectContaining({ kind: "add", text: "two" }),
      );
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });
});
