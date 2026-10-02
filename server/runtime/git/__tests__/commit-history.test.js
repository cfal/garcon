import { describe, it, expect } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createGitOperations } from "../git-service.js";
import { runGitCommand, initRepoWithCommit } from "./repository-fixture.js";
import { materializeReviewResponse } from "./rendered-patch-fixture.js";

describe("commit history operations", () => {
  it("returns structured commit history and lazy commit body rows", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-history-"),
    );
    const git = createGitOperations();

    try {
      await initRepoWithCommit(projectPath);
      await fs.writeFile(
        path.join(projectPath, "a.txt"),
        "one\ntwo\n",
        "utf-8",
      );
      await runGitCommand(projectPath, ["commit", "-am", "add second line"]);

      const history = await git.getHistoryCommits({
        projectPath,
        limit: 10,
        offset: 0,
      });

      expect(history.project).toBe(projectPath);
      expect(history.ref).toBe("HEAD");
      expect(history.commits).toHaveLength(2);
      expect(history.commits[0]).toMatchObject({
        author: "Test User",
        authorEmail: "test@example.com",
        subject: "add second line",
      });
      expect(history.commits[0].parents).toHaveLength(1);

      const snapshot = await git.getCommitSnapshot({
        projectPath,
        commit: history.commits[0].hash,
        context: 5,
        bodyCandidateCount: 4,
      });

      expect(snapshot.status).toBe("ready");
      expect(snapshot.files[0]).toMatchObject({
        path: "a.txt",
        status: "modified",
        additions: 1,
        deletions: 0,
        bodyState: "unloaded",
      });
      expect(snapshot.firstBodyCandidates).toEqual(["a.txt"]);

      const bodies = materializeReviewResponse(
        await git.getReviewDocumentFileBodies({
          projectPath,
          documentId: snapshot.documentId,
          files: [{ path: "a.txt" }].map((file) => file.path),
          purpose: "visible",
        }),
      );
      const body = bodies.files["a.txt"];

      expect(bodies.errors).toEqual({});
      expect(body.bodyFingerprint).toBe(snapshot.files[0].bodyFingerprint);
      expect(
        body.rows.some((row) => row.kind === "add" && row.text === "two"),
      ).toBe(true);
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("renders root commits against the empty tree", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-history-root-"),
    );
    const git = createGitOperations();

    try {
      await initRepoWithCommit(projectPath);
      const { stdout } = await runGitCommand(projectPath, [
        "rev-list",
        "--max-parents=0",
        "HEAD",
      ]);
      const rootCommit = stdout.trim();

      const snapshot = await git.getCommitSnapshot({
        projectPath,
        commit: rootCommit,
        context: 5,
      });

      expect(snapshot.status).toBe("ready");
      expect(snapshot.selectedParent).toBeNull();
      expect(snapshot.files[0]).toMatchObject({
        path: "a.txt",
        status: "added",
        additions: 1,
      });
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("exposes merge parents and rejects non-parent selections", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-history-merge-"),
    );
    const git = createGitOperations();

    try {
      await initRepoWithCommit(projectPath);
      await runGitCommand(projectPath, ["checkout", "-b", "side"]);
      await fs.writeFile(path.join(projectPath, "side.txt"), "side\n", "utf-8");
      await runGitCommand(projectPath, ["add", "side.txt"]);
      await runGitCommand(projectPath, ["commit", "-m", "side change"]);
      await runGitCommand(projectPath, ["checkout", "master"]);
      await fs.writeFile(path.join(projectPath, "main.txt"), "main\n", "utf-8");
      await runGitCommand(projectPath, ["add", "main.txt"]);
      await runGitCommand(projectPath, ["commit", "-m", "main change"]);
      await runGitCommand(projectPath, ["merge", "side", "-m", "merge side"]);

      const snapshot = await git.getCommitSnapshot({
        projectPath,
        commit: "HEAD",
        context: 5,
      });

      expect(snapshot.status).toBe("ready");
      expect(snapshot.parentOptions).toHaveLength(2);
      expect(snapshot.selectedParent).toBe(snapshot.parentOptions[0].hash);

      const secondParentSnapshot = await git.getCommitSnapshot({
        projectPath,
        commit: "HEAD",
        parent: snapshot.parentOptions[1].hash,
        context: 5,
      });
      expect(secondParentSnapshot.status).toBe("ready");
      expect(secondParentSnapshot.selectedParent).toBe(
        snapshot.parentOptions[1].hash,
      );

      await expect(
        git.getCommitSnapshot({
          projectPath,
          commit: "HEAD",
          parent: "HEAD~3",
          context: 5,
        }),
      ).rejects.toMatchObject({
        code: "INVALID_INPUT",
        message: "Requested parent is not a direct parent of the commit.",
      });
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("preserves renamed paths in commit summaries and bodies", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-history-rename-"),
    );
    const git = createGitOperations();

    try {
      await initRepoWithCommit(projectPath);
      await fs.writeFile(
        path.join(projectPath, "a.txt"),
        "one\ntwo\nthree\nfour\n",
        "utf-8",
      );
      await runGitCommand(projectPath, ["commit", "-am", "expand file"]);
      await runGitCommand(projectPath, ["mv", "a.txt", "renamed file.txt"]);
      await fs.appendFile(
        path.join(projectPath, "renamed file.txt"),
        "five\n",
        "utf-8",
      );
      await runGitCommand(projectPath, ["commit", "-am", "rename file"]);

      const snapshot = await git.getCommitSnapshot({
        projectPath,
        commit: "HEAD",
        context: 5,
      });

      expect(snapshot.status).toBe("ready");
      expect(snapshot.files).toContainEqual(
        expect.objectContaining({
          path: "renamed file.txt",
          originalPath: "a.txt",
          status: "renamed",
          additions: 1,
        }),
      );

      const renamedFile = snapshot.files.find(
        (file) => file.path === "renamed file.txt",
      );
      const bodies = materializeReviewResponse(
        await git.getReviewDocumentFileBodies({
          projectPath,
          documentId: snapshot.documentId,
          files: [
            { path: renamedFile.path, originalPath: renamedFile.originalPath },
          ].map((file) => file.path),
          purpose: "visible",
        }),
      );
      const addedRows = bodies.files[renamedFile.path].rows.filter(
        (row) => row.kind === "add",
      );

      expect(addedRows).toEqual([expect.objectContaining({ text: "five" })]);
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("loads historical bodies for paths containing pathspec metacharacters", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-history-literal-path-"),
    );
    const git = createGitOperations();
    const filePath = "wild[slug].txt";

    try {
      await initRepoWithCommit(projectPath);
      await fs.writeFile(path.join(projectPath, filePath), "one\n", "utf-8");
      await runGitCommand(projectPath, ["add", filePath]);
      await runGitCommand(projectPath, ["commit", "-m", "add literal path"]);
      await fs.appendFile(path.join(projectPath, filePath), "two\n", "utf-8");
      await runGitCommand(projectPath, [
        "commit",
        "-am",
        "change literal path",
      ]);

      const snapshot = await git.getCommitSnapshot({
        projectPath,
        commit: "HEAD",
        context: 5,
      });
      expect(snapshot.status).toBe("ready");

      const bodies = materializeReviewResponse(
        await git.getReviewDocumentFileBodies({
          projectPath,
          documentId: snapshot.documentId,
          files: [{ path: filePath }].map((file) => file.path),
          purpose: "visible",
        }),
      );

      expect(bodies.files[filePath].rows).toContainEqual(
        expect.objectContaining({ kind: "add", text: "two" }),
      );
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("ignores user diff renderers when loading exact historical bodies", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-history-normalized-diff-"),
    );
    const git = createGitOperations();

    try {
      await initRepoWithCommit(projectPath);
      await fs.appendFile(path.join(projectPath, "a.txt"), "two\n", "utf-8");
      await runGitCommand(projectPath, ["commit", "-am", "change file"]);
      await runGitCommand(projectPath, [
        "config",
        "diff.external",
        "/bin/true",
      ]);
      await runGitCommand(projectPath, ["config", "color.ui", "always"]);

      const snapshot = await git.getCommitSnapshot({
        projectPath,
        commit: "HEAD",
      });
      expect(snapshot.status).toBe("ready");
      const bodies = materializeReviewResponse(
        await git.getReviewDocumentFileBodies({
          projectPath,
          documentId: snapshot.documentId,
          files: [{ path: "a.txt" }].map((file) => file.path),
          purpose: "visible",
        }),
      );
      expect(bodies.files["a.txt"].bodyState).toBe("loaded");
      expect(bodies.files["a.txt"].rows).toContainEqual(
        expect.objectContaining({ kind: "add", text: "two" }),
      );

      const comparisonSnapshot = await git.getComparisonSnapshot({
        projectPath,
        from: { kind: "revision", revision: "HEAD~1" },
        to: { kind: "revision", revision: "HEAD" },
        mode: "direct",
      });
      expect(comparisonSnapshot.status).toBe("ready");
      const comparisonBodies = materializeReviewResponse(
        await git.getReviewDocumentFileBodies({
          projectPath,
          documentId: comparisonSnapshot.documentId,
          files: [{ path: "a.txt" }].map((file) => file.path),
          purpose: "visible",
        }),
      );
      expect(comparisonBodies.files["a.txt"].bodyState).toBe("loaded");
      expect(comparisonBodies.files["a.txt"].rows).toContainEqual(
        expect.objectContaining({ kind: "add", text: "two" }),
      );
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("keeps a file body separate when the same path becomes a directory", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-history-file-to-directory-"),
    );
    const git = createGitOperations();

    try {
      await initRepoWithCommit(projectPath);
      await fs.mkdir(path.join(projectPath, "bin"));
      await fs.writeFile(
        path.join(projectPath, "bin", "tool"),
        "old\n",
        "utf-8",
      );
      await runGitCommand(projectPath, ["add", "."]);
      await runGitCommand(projectPath, ["commit", "-m", "add tool file"]);
      await fs.rm(path.join(projectPath, "bin", "tool"));
      await fs.mkdir(path.join(projectPath, "bin", "tool"));
      await fs.writeFile(
        path.join(projectPath, "bin", "tool", "main.sh"),
        "new\n",
        "utf-8",
      );
      await runGitCommand(projectPath, ["add", "-A"]);
      await runGitCommand(projectPath, [
        "commit",
        "-m",
        "replace tool with directory",
      ]);

      const snapshot = await git.getCommitSnapshot({
        projectPath,
        commit: "HEAD",
        context: 5,
      });
      expect(snapshot.status).toBe("ready");
      const deletedFile = snapshot.files.find(
        (file) => file.path === "bin/tool",
      );
      expect(deletedFile).toMatchObject({ status: "deleted" });

      const bodies = materializeReviewResponse(
        await git.getReviewDocumentFileBodies({
          projectPath,
          documentId: snapshot.documentId,
          files: [{ path: "bin/tool" }].map((file) => file.path),
          purpose: "visible",
        }),
      );
      const body = bodies.files["bin/tool"];

      expect(body.rows).toContainEqual(
        expect.objectContaining({ kind: "del", text: "old" }),
      );
      expect(body.rows).not.toContainEqual(
        expect.objectContaining({ kind: "add", text: "new" }),
      );
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("isolates prefix-path rename bodies from changed siblings", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-history-prefix-rename-"),
    );
    const git = createGitOperations();
    const content = "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n";
    const renamedContent =
      "one\ntwo\nthree\nfour\nCHANGED\nsix\nseven\neight\n";

    try {
      await initRepoWithCommit(projectPath);
      await fs.mkdir(path.join(projectPath, "bin"));
      await fs.writeFile(
        path.join(projectPath, "bin", "tool"),
        content,
        "utf-8",
      );
      await runGitCommand(projectPath, ["add", "."]);
      await runGitCommand(projectPath, ["commit", "-m", "add tool file"]);
      await fs.rm(path.join(projectPath, "bin", "tool"));
      await fs.mkdir(path.join(projectPath, "bin", "tool"));
      await fs.writeFile(
        path.join(projectPath, "bin", "tool", "main.sh"),
        renamedContent,
        "utf-8",
      );
      await fs.writeFile(
        path.join(projectPath, "bin", "tool", "aaa.sh"),
        "sibling-alpha\n",
        "utf-8",
      );
      await fs.writeFile(
        path.join(projectPath, "bin", "tool", "zzz.bin"),
        Buffer.from([0, 1, 2, 3]),
      );
      await runGitCommand(projectPath, ["add", "-A"]);
      await runGitCommand(projectPath, [
        "commit",
        "-m",
        "move tool below directory",
      ]);

      const snapshot = await git.getCommitSnapshot({
        projectPath,
        commit: "HEAD",
        context: 5,
      });
      expect(snapshot.status).toBe("ready");
      const renamedFile = snapshot.files.find(
        (file) => file.path === "bin/tool/main.sh",
      );
      expect(renamedFile).toMatchObject({
        status: "renamed",
        originalPath: "bin/tool",
        additions: 1,
        deletions: 1,
      });

      const bodies = materializeReviewResponse(
        await git.getReviewDocumentFileBodies({
          projectPath,
          documentId: snapshot.documentId,
          files: [
            { path: renamedFile.path, originalPath: renamedFile.originalPath },
          ].map((file) => file.path),
          purpose: "visible",
        }),
      );

      const body = bodies.files[renamedFile.path];
      expect(body.bodyState).toBe("loaded");
      expect(body.rows).toContainEqual(
        expect.objectContaining({ kind: "add", text: "CHANGED" }),
      );
      expect(body.rows.some((row) => row.text === "sibling-alpha")).toBe(false);

      const comparisonSnapshot = await git.getComparisonSnapshot({
        projectPath,
        from: { kind: "revision", revision: "HEAD~1" },
        to: { kind: "revision", revision: "HEAD" },
        mode: "direct",
      });
      expect(comparisonSnapshot.status).toBe("ready");
      const comparisonRename = comparisonSnapshot.files.find(
        (file) => file.path === "bin/tool/main.sh",
      );
      const comparisonBodies = materializeReviewResponse(
        await git.getReviewDocumentFileBodies({
          projectPath,
          documentId: comparisonSnapshot.documentId,
          files: [
            {
              path: comparisonRename.path,
              originalPath: comparisonRename.originalPath,
            },
          ].map((file) => file.path),
          purpose: "visible",
        }),
      );
      const comparisonBody = comparisonBodies.files[comparisonRename.path];
      expect(comparisonBody.bodyState).toBe("loaded");
      expect(comparisonBody.rows).toContainEqual(
        expect.objectContaining({ kind: "add", text: "CHANGED" }),
      );
      expect(
        comparisonBody.rows.some((row) => row.text === "sibling-alpha"),
      ).toBe(false);
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("loads historical and comparison bodies for submodule changes", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-history-submodule-"),
    );
    const submoduleSource = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-history-submodule-source-"),
    );
    const git = createGitOperations();

    try {
      await initRepoWithCommit(projectPath);
      await initRepoWithCommit(submoduleSource);
      await runGitCommand(projectPath, [
        "-c",
        "protocol.file.allow=always",
        "submodule",
        "add",
        submoduleSource,
        "vendor/sub",
      ]);
      await runGitCommand(projectPath, ["commit", "-am", "add submodule"]);

      await fs.appendFile(
        path.join(submoduleSource, "a.txt"),
        "two\n",
        "utf-8",
      );
      await runGitCommand(submoduleSource, [
        "commit",
        "-am",
        "update submodule",
      ]);
      const { stdout: submoduleHashOutput } = await runGitCommand(
        submoduleSource,
        ["rev-parse", "HEAD"],
      );
      const submodulePath = path.join(projectPath, "vendor", "sub");
      await runGitCommand(submodulePath, [
        "-c",
        "protocol.file.allow=always",
        "fetch",
        "origin",
      ]);
      await runGitCommand(submodulePath, [
        "checkout",
        submoduleHashOutput.trim(),
      ]);
      await runGitCommand(projectPath, ["add", "vendor/sub"]);
      await runGitCommand(projectPath, ["commit", "-m", "advance submodule"]);
      await runGitCommand(projectPath, ["config", "diff.submodule", "log"]);

      const snapshot = await git.getCommitSnapshot({
        projectPath,
        commit: "HEAD",
      });
      expect(snapshot.status).toBe("ready");
      const submoduleFile = snapshot.files.find(
        (file) => file.path === "vendor/sub",
      );
      expect(submoduleFile).toMatchObject({
        status: "modified",
        additions: 1,
        deletions: 1,
      });
      const bodies = materializeReviewResponse(
        await git.getReviewDocumentFileBodies({
          projectPath,
          documentId: snapshot.documentId,
          files: [{ path: "vendor/sub" }].map((file) => file.path),
          purpose: "visible",
        }),
      );
      expect(bodies.files["vendor/sub"].bodyState).toBe("loaded");
      expect(bodies.files["vendor/sub"].rows).toContainEqual(
        expect.objectContaining({
          kind: "add",
          text: expect.stringContaining("Subproject commit"),
        }),
      );

      const comparisonSnapshot = await git.getComparisonSnapshot({
        projectPath,
        from: { kind: "revision", revision: "HEAD~1" },
        to: { kind: "revision", revision: "HEAD" },
        mode: "direct",
      });
      expect(comparisonSnapshot.status).toBe("ready");
      const comparisonBodies = materializeReviewResponse(
        await git.getReviewDocumentFileBodies({
          projectPath,
          documentId: comparisonSnapshot.documentId,
          files: [{ path: "vendor/sub" }].map((file) => file.path),
          purpose: "visible",
        }),
      );
      expect(comparisonBodies.files["vendor/sub"].bodyState).toBe("loaded");
      expect(comparisonBodies.files["vendor/sub"].rows).toContainEqual(
        expect.objectContaining({
          kind: "del",
          text: expect.stringContaining("Subproject commit"),
        }),
      );
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
      await fs.rm(submoduleSource, { recursive: true, force: true });
    }
  });

  it("renders both sides when a historical file changes type", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-history-type-change-"),
    );
    const git = createGitOperations();

    try {
      await initRepoWithCommit(projectPath);
      await fs.rm(path.join(projectPath, "a.txt"));
      await fs.symlink("target.txt", path.join(projectPath, "a.txt"));
      await runGitCommand(projectPath, ["add", "-A"]);
      await runGitCommand(projectPath, [
        "commit",
        "-m",
        "replace file with link",
      ]);

      const snapshot = await git.getCommitSnapshot({
        projectPath,
        commit: "HEAD",
      });
      expect(snapshot.status).toBe("ready");
      expect(
        snapshot.files.find((file) => file.path === "a.txt"),
      ).toMatchObject({
        status: "type-changed",
      });
      const bodies = materializeReviewResponse(
        await git.getReviewDocumentFileBodies({
          projectPath,
          documentId: snapshot.documentId,
          files: [{ path: "a.txt" }].map((file) => file.path),
          purpose: "visible",
        }),
      );
      expect(bodies.files["a.txt"].bodyState).toBe("loaded");
      expect(bodies.files["a.txt"].rows).toContainEqual(
        expect.objectContaining({ kind: "del", text: "one" }),
      );
      expect(bodies.files["a.txt"].rows).toContainEqual(
        expect.objectContaining({ kind: "add", text: "target.txt" }),
      );

      const comparisonSnapshot = await git.getComparisonSnapshot({
        projectPath,
        from: { kind: "revision", revision: "HEAD~1" },
        to: { kind: "revision", revision: "HEAD" },
        mode: "direct",
      });
      expect(comparisonSnapshot.status).toBe("ready");
      const comparisonBodies = materializeReviewResponse(
        await git.getReviewDocumentFileBodies({
          projectPath,
          documentId: comparisonSnapshot.documentId,
          files: [{ path: "a.txt" }].map((file) => file.path),
          purpose: "visible",
        }),
      );
      expect(comparisonBodies.files["a.txt"].rows).toContainEqual(
        expect.objectContaining({ kind: "add", text: "target.txt" }),
      );
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });
});

describe("commit revert operations", () => {
  it("reverts a selected non-HEAD commit by hash", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-revert-commit-"),
    );
    const git = createGitOperations();

    try {
      await initRepoWithCommit(projectPath);
      await fs.writeFile(path.join(projectPath, "b.txt"), "two\n", "utf-8");
      await runGitCommand(projectPath, ["add", "b.txt"]);
      await runGitCommand(projectPath, ["commit", "-m", "add b"]);
      const { stdout: commitToRevert } = await runGitCommand(projectPath, [
        "rev-parse",
        "HEAD",
      ]);

      await fs.writeFile(path.join(projectPath, "c.txt"), "three\n", "utf-8");
      await runGitCommand(projectPath, ["add", "c.txt"]);
      await runGitCommand(projectPath, ["commit", "-m", "add c"]);

      const result = await git.revertCommit({
        projectPath,
        commit: commitToRevert.trim(),
      });

      expect(result.success).toBe(true);
      await expect(
        fs.access(path.join(projectPath, "b.txt")),
      ).rejects.toThrow();
      await fs.access(path.join(projectPath, "c.txt"));
      const { stdout: subject } = await runGitCommand(projectPath, [
        "log",
        "-1",
        "--pretty=%s",
      ]);
      expect(subject.trim()).toBe('Revert "add b"');
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });
});
