import { describe, it, expect } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createGitOperations } from "../git-service.js";
import { runGitCommand, initRepoWithCommit } from "./repository-fixture.js";
import { GIT_REVIEW_DOCUMENT_LIMITS } from "../types.js";
import { materializeReviewResponse } from "./rendered-patch-fixture.js";

describe("review document file bodies", () => {
  it("does not create a trailing context row from the terminal patch newline", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-rendered-row-"),
    );
    const git = createGitOperations();

    try {
      await initRepoWithCommit(projectPath);
      await fs.writeFile(
        path.join(projectPath, "a.txt"),
        "one\ntwo\n",
        "utf-8",
      );

      const workingSnapshot = await git.getWorkbenchSnapshot({
        projectPath,
        mode: "working",
        context: 3,
      });
      expect(workingSnapshot.status).toBe("ready");
      const result = materializeReviewResponse(
        await git.getReviewDocumentFileBodies({
          projectPath,
          documentId: workingSnapshot.reviewSummary.documentId,
          files: ["a.txt"],
          purpose: "visible",
        }),
      );
      const review = result.files["a.txt"];
      const lastRow = review.rows[review.rows.length - 1];

      expect(lastRow).toMatchObject({ kind: "add", text: "two" });
      expect(review.rows).not.toContainEqual(
        expect.objectContaining({
          kind: "context",
          text: "",
          beforeLine: 2,
          afterLine: 3,
        }),
      );
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("classifies deleted binary files as binary review data", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-binary-delete-"),
    );
    const git = createGitOperations();

    try {
      await initRepoWithCommit(projectPath);
      await fs.writeFile(
        path.join(projectPath, "blob.bin"),
        Buffer.from([0, 1, 2, 3, 255, 0, 10]),
      );
      await runGitCommand(projectPath, ["add", "blob.bin"]);
      await runGitCommand(projectPath, ["commit", "-m", "add binary"]);
      await fs.rm(path.join(projectPath, "blob.bin"));

      const workingSnapshot = await git.getWorkbenchSnapshot({
        projectPath,
        mode: "working",
        context: 3,
      });
      expect(workingSnapshot.status).toBe("ready");
      const result = materializeReviewResponse(
        await git.getReviewDocumentFileBodies({
          projectPath,
          documentId: workingSnapshot.reviewSummary.documentId,
          files: ["blob.bin"],
          purpose: "visible",
        }),
      );
      const review = result.files["blob.bin"];

      expect(review.bodyState).toBe("binary");
      expect(review.isBinary).toBe(true);
      expect(review.limitReason).toBe("binary");
      expect(review.rows).toEqual([]);
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("parses batch review data for paths with spaces", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-batch-spaces-"),
    );
    const git = createGitOperations();

    try {
      await initRepoWithCommit(projectPath);
      await fs.writeFile(path.join(projectPath, "a b.txt"), "old\n", "utf-8");
      await runGitCommand(projectPath, ["add", "a b.txt"]);
      await runGitCommand(projectPath, ["commit", "-m", "add spaced path"]);
      await fs.writeFile(path.join(projectPath, "a b.txt"), "new\n", "utf-8");

      const workingSnapshot = await git.getWorkbenchSnapshot({
        projectPath,
        mode: "working",
        context: 3,
      });
      expect(workingSnapshot.status).toBe("ready");
      const batch = materializeReviewResponse(
        await git.getReviewDocumentFileBodies({
          projectPath,
          documentId: workingSnapshot.reviewSummary.documentId,
          files: ["a b.txt"],
          purpose: "visible",
        }),
      );
      const review = batch.files["a b.txt"];

      expect(batch.errors).toEqual({});
      expect(
        review.rows.some((row) => row.kind === "del" && row.text === "old"),
      ).toBe(true);
      expect(
        review.rows.some((row) => row.kind === "add" && row.text === "new"),
      ).toBe(true);
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("returns bounded preview rows for long untracked text files", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-preview-long-"),
    );
    const git = createGitOperations();

    try {
      await initRepoWithCommit(projectPath);
      await fs.writeFile(
        path.join(projectPath, "long.md"),
        Array.from({ length: 2_500 }, (_, index) => `line ${index + 1}`).join(
          "\n",
        ) + "\n",
        "utf-8",
      );

      const workingSnapshot = await git.getWorkbenchSnapshot({
        projectPath,
        mode: "working",
        context: 3,
      });
      expect(workingSnapshot.status).toBe("ready");
      const batch = materializeReviewResponse(
        await git.getReviewDocumentFileBodies({
          projectPath,
          documentId: workingSnapshot.reviewSummary.documentId,
          files: ["long.md"],
          purpose: "visible",
        }),
      );
      const review = batch.files["long.md"];

      expect(batch.errors).toEqual({});
      expect(review.bodyState).toBe("loaded");
      expect(review.rows.length).toBeGreaterThan(2_000);
      expect(
        review.rows.some((row) => row.kind === "add" && row.text === "line 1"),
      ).toBe(true);
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("keeps staged and working deletion review modes separate", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-review-"),
    );
    const git = createGitOperations();

    try {
      await initRepoWithCommit(projectPath);
      await fs.writeFile(
        path.join(projectPath, "a.txt"),
        "one\nstaged\n",
        "utf-8",
      );
      await runGitCommand(projectPath, ["add", "a.txt"]);
      await fs.rm(path.join(projectPath, "a.txt"));

      const stagedSnapshot = await git.getWorkbenchSnapshot({
        projectPath,
        mode: "staged",
        context: 3,
      });
      expect(stagedSnapshot.status).toBe("ready");
      const staged = materializeReviewResponse(
        await git.getReviewDocumentFileBodies({
          projectPath,
          documentId: stagedSnapshot.reviewSummary.documentId,
          files: ["a.txt"],
          purpose: "visible",
        }),
      ).files["a.txt"];
      const workingSnapshot = await git.getWorkbenchSnapshot({
        projectPath,
        mode: "working",
        context: 3,
      });
      expect(workingSnapshot.status).toBe("ready");
      const working = materializeReviewResponse(
        await git.getReviewDocumentFileBodies({
          projectPath,
          documentId: workingSnapshot.reviewSummary.documentId,
          files: ["a.txt"],
          purpose: "visible",
        }),
      ).files["a.txt"];

      expect(staged.bodyState).toBe("loaded");
      expect(staged.isBinary).toBe(false);
      expect(
        staged.rows.some((row) => row.kind === "add" && row.text === "staged"),
      ).toBe(true);
      expect(staged.rows.some((row) => row.kind === "del")).toBe(false);
      expect(staged.hunks.length).toBeGreaterThan(0);

      expect(working.bodyState).toBe("loaded");
      expect(working.isBinary).toBe(false);
      expect(
        working.rows.some((row) => row.kind === "del" && row.text === "staged"),
      ).toBe(true);
      expect(working.rows.some((row) => row.kind === "add")).toBe(false);
      expect(working.hunks.length).toBeGreaterThan(0);
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("returns too-large for files over the hard row limit", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-hard-limit-"),
    );
    const git = createGitOperations();

    try {
      await initRepoWithCommit(projectPath);
      await fs.writeFile(
        path.join(projectPath, "huge.md"),
        Array.from(
          { length: GIT_REVIEW_DOCUMENT_LIMITS.maxFileRows + 1 },
          (_, index) => `line ${index + 1}`,
        ).join("\n") + "\n",
        "utf-8",
      );

      const workingSnapshot = await git.getWorkbenchSnapshot({
        projectPath,
        mode: "working",
        context: 3,
      });
      expect(workingSnapshot.status).toBe("ready");
      const batch = materializeReviewResponse(
        await git.getReviewDocumentFileBodies({
          projectPath,
          documentId: workingSnapshot.reviewSummary.documentId,
          files: ["huge.md"],
          purpose: "visible",
        }),
      );
      const review = batch.files["huge.md"];

      expect(review.bodyState).toBe("too-large");
      expect(review.limitReason).toBe("file-too-many-rows");
      expect(review.rows).toEqual([]);
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });
});
