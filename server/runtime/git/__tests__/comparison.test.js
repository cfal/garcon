import { describe, it, expect, spyOn } from "bun:test";
import { writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createGitOperations } from "../git-service.js";
import { runGitCommand, initRepoWithCommit } from "./repository-fixture.js";
import { GIT_EMPTY_TREE } from "../comparison.js";
import { isUnresolvedRevision, needsRevisionFailureDiagnostics } from "../comparison-errors.js";
import { GIT_REVIEW_DOCUMENT_LIMITS } from "../types.js";
import { materializeReviewResponse } from "./rendered-patch-fixture.js";

function mutateDuringComparisonValidations(filePath, contents) {
  const trace = [];
  let statusCount = 0;
  let validationCount = 0;
  trace.push = function (...entries) {
    const length = Array.prototype.push.apply(this, entries);
    for (const entry of entries) {
      if (!entry.args.includes("--porcelain=v1")) continue;
      statusCount += 1;
      if (statusCount % 2 !== 0) continue;
      const content = contents[validationCount];
      validationCount += 1;
      if (content !== undefined) writeFileSync(filePath, content, "utf-8");
    }
    return length;
  };
  return { trace, validationCount: () => validationCount };
}

describe("comparison operations", () => {
  it("refreshes identical revisions after submodule diff policy changes", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-comparison-policy-"),
    );
    try {
      await initRepoWithCommit(projectPath);
      const first = (
        await runGitCommand(projectPath, ["rev-parse", "HEAD"])
      ).stdout.trim();
      await runGitCommand(projectPath, [
        "commit",
        "--allow-empty",
        "-qm",
        "second gitlink target",
      ]);
      const second = (
        await runGitCommand(projectPath, ["rev-parse", "HEAD"])
      ).stdout.trim();
      await runGitCommand(projectPath, [
        "update-index",
        "--add",
        "--cacheinfo",
        `160000,${first},module`,
      ]);
      await runGitCommand(projectPath, ["commit", "-qm", "base gitlink"]);
      const from = (
        await runGitCommand(projectPath, ["rev-parse", "HEAD"])
      ).stdout.trim();
      await runGitCommand(projectPath, [
        "update-index",
        "--cacheinfo",
        `160000,${second},module`,
      ]);
      await runGitCommand(projectPath, ["commit", "-qm", "changed gitlink"]);
      const to = (
        await runGitCommand(projectPath, ["rev-parse", "HEAD"])
      ).stdout.trim();
      const git = createGitOperations();
      const input = {
        projectPath,
        from: { kind: "revision", revision: from },
        to: { kind: "revision", revision: to },
        mode: "direct",
        context: 3,
      };
      await runGitCommand(projectPath, [
        "config",
        "diff.ignoreSubmodules",
        "all",
      ]);
      const hidden = await git.getComparisonSnapshot(input);
      expect(hidden.files).toEqual([]);
      expect(hidden.firstBodyCandidates).toEqual([]);
      await runGitCommand(projectPath, [
        "config",
        "diff.ignoreSubmodules",
        "none",
      ]);
      const refreshed = await git.getComparisonSnapshot(input);
      expect(refreshed.files.map((file) => file.path)).toEqual(["module"]);
      expect(refreshed.documentId).not.toBe(hidden.documentId);
      await runGitCommand(projectPath, [
        "config",
        "diff.ignoreSubmodules",
        "all",
      ]);
      const hiddenAgain = await git.getComparisonSnapshot(input);
      expect(hiddenAgain.files).toEqual([]);
      expect(hiddenAgain.firstBodyCandidates).toEqual([]);
      expect(hiddenAgain.documentId).not.toBe(refreshed.documentId);
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("refreshes identical revisions after working-tree attributes change", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-comparison-attributes-"),
    );
    try {
      await initRepoWithCommit(projectPath);
      const from = (
        await runGitCommand(projectPath, ["rev-parse", "HEAD"])
      ).stdout.trim();
      await fs.writeFile(path.join(projectPath, "a.txt"), "changed\n");
      await runGitCommand(projectPath, ["commit", "-qam", "target"]);
      const git = createGitOperations();
      const input = {
        projectPath,
        from: { kind: "revision", revision: from },
        to: { kind: "revision", revision: "HEAD" },
        mode: "direct",
        context: 3,
      };
      const text = await git.getComparisonSnapshot(input);
      expect(text.files[0]).toMatchObject({
        path: "a.txt",
        isBinary: false,
        additions: 1,
      });
      await fs.writeFile(
        path.join(projectPath, ".gitattributes"),
        "a.txt -diff\n",
      );
      const binary = await git.getComparisonSnapshot(input);
      expect(binary.files[0]).toMatchObject({
        path: "a.txt",
        isBinary: true,
        bodyState: "binary",
      });
      expect(binary.documentId).not.toBe(text.documentId);
      const binaryBodies = await git.getReviewDocumentFileBodies({
        projectPath,
        documentId: binary.documentId,
        files: ["a.txt"],
        purpose: "visible",
      });
      expect(binaryBodies.files["a.txt"]).toMatchObject({
        bodyState: "binary",
        patch: null,
      });
      await fs.rm(path.join(projectPath, ".gitattributes"));
      const restored = await git.getComparisonSnapshot(input);
      expect(restored.files).toEqual(text.files);
      expect(restored.documentId).not.toBe(binary.documentId);
      const textBodies = await git.getReviewDocumentFileBodies({
        projectPath,
        documentId: restored.documentId,
        files: ["a.txt"],
        purpose: "visible",
      });
      expect(textBodies.files["a.txt"]).toMatchObject({
        bodyState: "loaded",
        isBinary: false,
      });
      expect(textBodies.files["a.txt"].patch).toContain("+changed");
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("reuses unchanged documents but refreshes summaries, aliases, candidates and moved refs", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-comparison-cache-"),
    );
    try {
      await initRepoWithCommit(projectPath);
      await runGitCommand(projectPath, ["branch", "base"]);
      await fs.writeFile(path.join(projectPath, "a.txt"), "changed\n");
      await fs.writeFile(
        path.join(projectPath, "b.ts"),
        "export const value = 1;\n",
      );
      await runGitCommand(projectPath, ["add", "."]);
      await runGitCommand(projectPath, ["commit", "-qm", "target"]);
      await runGitCommand(projectPath, ["branch", "alias"]);
      const git = createGitOperations();
      const input = {
        projectPath,
        from: { kind: "revision", revision: "base" },
        to: { kind: "revision", revision: "HEAD" },
        mode: "direct",
        context: 3,
      };
      const trace = [];
      const first = await git.getComparisonSnapshot({
        ...input,
        trace,
        bodyCandidateCount: 1,
      });
      expect(trace.filter(({ args }) => args[0] === "diff")).toHaveLength(2);
      trace.length = 0;
      const alias = await git.getComparisonSnapshot({
        ...input,
        trace,
        to: { kind: "revision", revision: "alias" },
        bodyCandidateCount: 2,
      });
      expect(alias.documentId).toBe(first.documentId);
      expect(alias.to.requestedRevision).toBe("alias");
      expect(alias.firstBodyCandidates).toHaveLength(2);
      expect(alias.files).toEqual(first.files);
      expect(trace.some(({ args }) => args[0] === "rev-parse")).toBe(true);
      expect(trace.filter(({ args }) => args[0] === "diff")).toHaveLength(2);
      alias.files[0].additions = 999;
      expect((await git.getComparisonSnapshot(input)).files).toEqual(
        first.files,
      );
      for (const changed of [{ context: 5 }, { mode: "merge-base" }]) {
        trace.length = 0;
        const replacement = await git.getComparisonSnapshot({
          ...input,
          ...changed,
          trace,
        });
        expect(replacement.documentId).not.toBe(first.documentId);
        expect(trace.filter(({ args }) => args[0] === "diff")).toHaveLength(2);
      }
      await fs.writeFile(
        path.join(projectPath, "a.txt"),
        "changed again\nnew line\n",
      );
      await runGitCommand(projectPath, ["commit", "-qam", "advance"]);
      trace.length = 0;
      const moved = await git.getComparisonSnapshot({ ...input, trace });
      expect(moved.documentId).not.toBe(first.documentId);
      expect(moved.to.hash).not.toBe(first.to.hash);
      expect(trace.filter(({ args }) => args[0] === "diff")).toHaveLength(2);
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("distinguishes a missing revision from a repository failure", () => {
    expect(isUnresolvedRevision({ code: 1 })).toBe(true);
    expect(isUnresolvedRevision({ code: 128 })).toBe(false);
    expect(
      needsRevisionFailureDiagnostics({ code: 128, stdout: "", stderr: "" }),
    ).toBe(true);
    expect(
      isUnresolvedRevision({
        code: 128,
        stderr: "fatal: log for 'HEAD' only has 1 entries\n",
      }),
    ).toBe(true);
    expect(
      isUnresolvedRevision({ code: 128, stderr: "fatal: bad object HEAD" }),
    ).toBe(false);
    expect(isUnresolvedRevision({ code: 1, timedOut: true })).toBe(false);
    expect(isUnresolvedRevision({ code: 1, aborted: true })).toBe(false);
  });

  it("reports invalid revision syntax through the typed endpoint error", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-comparison-invalid-revision-"),
    );
    const git = createGitOperations();

    try {
      await initRepoWithCommit(projectPath);
      const snapshot = await git.getComparisonSnapshot({
        projectPath,
        from: { kind: "revision", revision: "main..feature" },
        to: { kind: "revision", revision: "HEAD" },
        mode: "direct",
      });

      expect(snapshot).toMatchObject({
        status: "not-found",
        endpoint: "from",
        revision: "main..feature",
      });

      const missingReflogSnapshot = await git.getComparisonSnapshot({
        projectPath,
        from: { kind: "revision", revision: "HEAD@{9999}" },
        to: { kind: "revision", revision: "HEAD" },
        mode: "direct",
      });
      expect(missingReflogSnapshot).toMatchObject({
        status: "not-found",
        endpoint: "from",
        revision: "HEAD@{9999}",
      });
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("propagates repository failures while resolving comparison revisions", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-comparison-corrupt-ref-"),
    );
    const git = createGitOperations();

    try {
      await initRepoWithCommit(projectPath);
      const { stdout: headHash } = await runGitCommand(projectPath, [
        "rev-parse",
        "HEAD",
      ]);
      const objectHash = headHash.trim();
      const objectPath = path.join(
        projectPath,
        ".git",
        "objects",
        objectHash.slice(0, 2),
        objectHash.slice(2),
      );
      await fs.chmod(objectPath, 0o600);
      await fs.writeFile(objectPath, "corrupt-object\n");

      await expect(
        git.getComparisonSnapshot({
          projectPath,
          from: { kind: "revision", revision: "HEAD" },
          to: { kind: "revision", revision: "HEAD" },
          mode: "direct",
        }),
      ).rejects.toMatchObject({ code: 128 });
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("compares resolved revisions and lazily loads bodies", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-comparison-revisions-"),
    );
    const git = createGitOperations();

    try {
      await initRepoWithCommit(projectPath);
      const { stdout: fromHash } = await runGitCommand(projectPath, [
        "rev-parse",
        "HEAD",
      ]);
      await fs.writeFile(
        path.join(projectPath, "a.txt"),
        "one\ntwo\n",
        "utf-8",
      );
      await runGitCommand(projectPath, ["commit", "-am", "add second line"]);

      const snapshot = await git.getComparisonSnapshot({
        projectPath,
        from: { kind: "revision", revision: fromHash.trim() },
        to: { kind: "revision", revision: "HEAD" },
        mode: "direct",
        context: 5,
      });

      expect(snapshot.status).toBe("ready");
      expect(snapshot.from.hash).toBe(fromHash.trim());
      expect(snapshot.to.hash).not.toBe(fromHash.trim());
      expect(snapshot.files).toContainEqual(
        expect.objectContaining({
          path: "a.txt",
          additions: 1,
          bodyState: "unloaded",
        }),
      );

      const bodies = materializeReviewResponse(
        await git.getReviewDocumentFileBodies({
          projectPath,
          documentId: snapshot.documentId,
          files: [{ path: "a.txt" }].map((file) => file.path),
          purpose: "visible",
        }),
      );
      expect(bodies.status).toBe("ready");
      expect(bodies.files["a.txt"].bodyFingerprint).toBe(
        snapshot.files[0].bodyFingerprint,
      );
      expect(bodies.files["a.txt"].renderedRowCount).toBeGreaterThan(0);
      expect(bodies.files["a.txt"].patchBytes).toBeGreaterThan(0);
      expect(bodies.files["a.txt"].rows).toContainEqual(
        expect.objectContaining({ kind: "add", text: "two" }),
      );
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("detects moved requested revisions without changing frozen comparison identities", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-comparison-revision-freshness-"),
    );
    const git = createGitOperations();

    try {
      await initRepoWithCommit(projectPath);
      const { stdout: baseOutput } = await runGitCommand(projectPath, [
        "rev-parse",
        "HEAD",
      ]);
      const baseHash = baseOutput.trim();
      await runGitCommand(projectPath, [
        "update-ref",
        "refs/remotes/origin/main",
        baseHash,
      ]);
      await fs.writeFile(path.join(projectPath, "a.txt"), "feature\n", "utf-8");
      await runGitCommand(projectPath, ["commit", "-am", "feature"]);

      const snapshot = await git.getComparisonSnapshot({
        projectPath,
        from: { kind: "revision", revision: "origin/main" },
        to: { kind: "revision", revision: "HEAD" },
        mode: "direct",
      });
      expect(snapshot.status).toBe("ready");

      const fresh = await git.getComparisonFreshness({
        projectPath,
        from: {
          kind: "revision",
          revision: snapshot.from.requestedRevision,
          hash: snapshot.from.hash,
        },
        to: {
          kind: "revision",
          revision: snapshot.to.requestedRevision,
          hash: snapshot.to.hash,
        },
      });
      expect(fresh).toMatchObject({
        status: "ready",
        changedEndpoints: [],
        fromHash: baseHash,
        to: { kind: "revision", hash: snapshot.to.hash },
      });

      await fs.writeFile(
        path.join(projectPath, "a.txt"),
        "rewritten\n",
        "utf-8",
      );
      await runGitCommand(projectPath, ["add", "a.txt"]);
      await runGitCommand(projectPath, ["commit", "--amend", "--no-edit"]);
      const { stdout: rewrittenOutput } = await runGitCommand(projectPath, [
        "rev-parse",
        "HEAD",
      ]);
      const rewrittenHash = rewrittenOutput.trim();

      const stale = await git.getComparisonFreshness({
        projectPath,
        from: {
          kind: "revision",
          revision: snapshot.from.requestedRevision,
          hash: snapshot.from.hash,
        },
        to: {
          kind: "revision",
          revision: snapshot.to.requestedRevision,
          hash: snapshot.to.hash,
        },
      });
      expect(stale).toMatchObject({
        status: "ready",
        changedEndpoints: ["to"],
        fromHash: baseHash,
        to: { kind: "revision", hash: rewrittenHash },
      });

      const literalHashes = await git.getComparisonFreshness({
        projectPath,
        from: { kind: "revision", revision: baseHash, hash: baseHash },
        to: {
          kind: "revision",
          revision: rewrittenHash,
          hash: rewrittenHash,
        },
      });
      expect(literalHashes).toMatchObject({
        status: "ready",
        changedEndpoints: [],
      });
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("detects a moved From revision in a Working Tree comparison", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(
        os.tmpdir(),
        "garcon-git-comparison-working-tree-base-freshness-",
      ),
    );
    const git = createGitOperations();

    try {
      await initRepoWithCommit(projectPath);
      const { stdout: baseOutput } = await runGitCommand(projectPath, [
        "rev-parse",
        "HEAD",
      ]);
      const baseHash = baseOutput.trim();
      await runGitCommand(projectPath, [
        "update-ref",
        "refs/remotes/origin/main",
        baseHash,
      ]);
      await fs.writeFile(path.join(projectPath, "a.txt"), "feature\n", "utf-8");
      await runGitCommand(projectPath, ["commit", "-am", "feature"]);

      const snapshot = await git.getComparisonSnapshot({
        projectPath,
        from: { kind: "revision", revision: "origin/main" },
        to: { kind: "working-tree" },
        mode: "direct",
      });
      expect(snapshot.status).toBe("ready");
      expect(snapshot.to.kind).toBe("working-tree");

      await runGitCommand(projectPath, [
        "update-ref",
        "refs/remotes/origin/main",
        snapshot.to.headHash,
      ]);
      const freshness = await git.getComparisonFreshness({
        projectPath,
        from: {
          kind: "revision",
          revision: snapshot.from.requestedRevision,
          hash: snapshot.from.hash,
        },
        to: {
          kind: "working-tree",
          fingerprint: snapshot.to.fingerprint,
        },
      });

      expect(freshness).toMatchObject({
        status: "ready",
        changedEndpoints: ["from"],
        fromHash: snapshot.to.headHash,
        to: {
          kind: "working-tree",
          fingerprint: snapshot.to.fingerprint,
        },
      });
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("uses the common ancestor only when requested", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-comparison-merge-base-"),
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
      await runGitCommand(projectPath, ["commit", "-m", "feature"]);
      await runGitCommand(projectPath, ["checkout", "master"]);
      await fs.writeFile(path.join(projectPath, "main.txt"), "main\n", "utf-8");
      await runGitCommand(projectPath, ["add", "main.txt"]);
      await runGitCommand(projectPath, ["commit", "-m", "main"]);

      const direct = await git.getComparisonSnapshot({
        projectPath,
        from: { kind: "revision", revision: "master" },
        to: { kind: "revision", revision: "feature" },
        mode: "direct",
      });
      const sinceCommonAncestor = await git.getComparisonSnapshot({
        projectPath,
        from: { kind: "revision", revision: "master" },
        to: { kind: "revision", revision: "feature" },
        mode: "merge-base",
      });

      expect(direct.status).toBe("ready");
      expect(direct.files.map((file) => file.path).sort()).toEqual([
        "feature.txt",
        "main.txt",
      ]);
      expect(sinceCommonAncestor.status).toBe("ready");
      expect(sinceCommonAncestor.mergeBaseHash).toBeTruthy();
      expect(sinceCommonAncestor.files.map((file) => file.path)).toEqual([
        "feature.txt",
      ]);
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("returns a typed no-merge-base status for the empty tree", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-comparison-empty-tree-"),
    );
    const git = createGitOperations();

    try {
      await initRepoWithCommit(projectPath);
      const snapshot = await git.getComparisonSnapshot({
        projectPath,
        from: { kind: "revision", revision: GIT_EMPTY_TREE },
        to: { kind: "revision", revision: "HEAD" },
        mode: "merge-base",
      });

      expect(snapshot).toMatchObject({
        status: "no-merge-base",
        from: { hash: GIT_EMPTY_TREE },
        message: "These revisions do not have a common ancestor.",
      });
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("retries a Working Tree snapshot once when content changes before validation", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-comparison-working-tree-retry-"),
    );
    const git = createGitOperations();

    try {
      await initRepoWithCommit(projectPath);
      const filePath = path.join(projectPath, "a.txt");
      await fs.writeFile(filePath, "first edit\n", "utf-8");
      const mutation = mutateDuringComparisonValidations(filePath, [
        "second edit\n",
      ]);

      const snapshot = await git.getComparisonSnapshot({
        projectPath,
        from: { kind: "revision", revision: "HEAD" },
        to: { kind: "working-tree" },
        mode: "direct",
        trace: mutation.trace,
      });

      expect(snapshot.status).toBe("ready");
      expect(mutation.validationCount()).toBe(2);
      expect(snapshot.files).toContainEqual(
        expect.objectContaining({ path: "a.txt", additions: 1 }),
      );
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("returns working-tree-changing after two unstable snapshot attempts", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-comparison-working-tree-changing-"),
    );
    const git = createGitOperations();

    try {
      await initRepoWithCommit(projectPath);
      const filePath = path.join(projectPath, "a.txt");
      await fs.writeFile(filePath, "first edit\n", "utf-8");
      const mutation = mutateDuringComparisonValidations(filePath, [
        "second edit\n",
        "third edit\n",
      ]);

      const snapshot = await git.getComparisonSnapshot({
        projectPath,
        from: { kind: "revision", revision: "HEAD" },
        to: { kind: "working-tree" },
        mode: "direct",
        trace: mutation.trace,
      });

      expect(snapshot).toMatchObject({
        status: "working-tree-changing",
        project: projectPath,
      });
      expect(mutation.validationCount()).toBe(2);
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("limits conflicted Working Tree paths instead of requesting their bodies", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-comparison-conflict-"),
    );
    const git = createGitOperations();

    try {
      await initRepoWithCommit(projectPath);
      await runGitCommand(projectPath, ["checkout", "-b", "conflict-side"]);
      await fs.writeFile(path.join(projectPath, "a.txt"), "side\n", "utf-8");
      await runGitCommand(projectPath, ["commit", "-am", "side"]);
      await runGitCommand(projectPath, ["checkout", "master"]);
      await fs.writeFile(path.join(projectPath, "a.txt"), "main\n", "utf-8");
      await runGitCommand(projectPath, ["commit", "-am", "main"]);
      await expect(
        runGitCommand(projectPath, ["merge", "conflict-side"]),
      ).rejects.toThrow();

      const snapshot = await git.getComparisonSnapshot({
        projectPath,
        from: { kind: "revision", revision: "HEAD" },
        to: { kind: "working-tree" },
        mode: "direct",
      });

      expect(snapshot.status).toBe("ready");
      expect(snapshot.files).toContainEqual(
        expect.objectContaining({
          path: "a.txt",
          bodyState: "too-large",
          limitReason: "unsupported-file-kind",
        }),
      );
      expect(snapshot.firstBodyCandidates).not.toContain("a.txt");
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("compares a revision to staged, unstaged, and untracked Working Tree content", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-comparison-working-tree-"),
    );
    const git = createGitOperations();

    try {
      await initRepoWithCommit(projectPath);
      await fs.writeFile(
        path.join(projectPath, ".gitignore"),
        "ignored.txt\n",
        "utf-8",
      );
      await runGitCommand(projectPath, ["add", ".gitignore"]);
      await runGitCommand(projectPath, ["commit", "-m", "ignore fixture"]);
      const { stdout: fromHash } = await runGitCommand(projectPath, [
        "rev-parse",
        "HEAD",
      ]);
      await fs.writeFile(path.join(projectPath, "a.txt"), "staged\n", "utf-8");
      await runGitCommand(projectPath, ["add", "a.txt"]);
      await fs.writeFile(path.join(projectPath, "a.txt"), "final\n", "utf-8");
      await fs.writeFile(
        path.join(projectPath, "new.txt"),
        "new\nsecond\n",
        "utf-8",
      );
      await fs.writeFile(
        path.join(projectPath, "wild[slug].txt"),
        "literal pathspec\n",
        "utf-8",
      );
      await fs.writeFile(
        path.join(projectPath, "ignored.txt"),
        "ignored\n",
        "utf-8",
      );

      const snapshot = await git.getComparisonSnapshot({
        projectPath,
        from: { kind: "revision", revision: fromHash.trim() },
        to: { kind: "working-tree" },
        mode: "direct",
      });

      expect(snapshot.status).toBe("ready");
      expect(snapshot.to.kind).toBe("working-tree");
      expect(snapshot.files.map((file) => file.path)).toEqual([
        "a.txt",
        "new.txt",
        "wild[slug].txt",
      ]);
      expect(snapshot.files.some((file) => file.path === "ignored.txt")).toBe(
        false,
      );
      expect(
        snapshot.files.find((file) => file.path === "new.txt")?.additions,
      ).toBe(2);

      const bodies = materializeReviewResponse(
        await git.getReviewDocumentFileBodies({
          projectPath,
          documentId: snapshot.documentId,
          files: snapshot.files
            .map((file) => ({
              path: file.path,
              originalPath: file.originalPath,
            }))
            .map((file) => file.path),
          purpose: "visible",
        }),
      );
      expect(bodies.status).toBe("ready");
      expect(bodies.files["a.txt"].rows).toContainEqual(
        expect.objectContaining({ kind: "add", text: "final" }),
      );
      expect(bodies.files["new.txt"].rows).toContainEqual(
        expect.objectContaining({ kind: "add", text: "new" }),
      );
      expect(bodies.files["wild[slug].txt"].rows).toContainEqual(
        expect.objectContaining({ kind: "add", text: "literal pathspec" }),
      );

      await fs.writeFile(
        path.join(projectPath, "a.txt"),
        "changed again\n",
        "utf-8",
      );
      const stale = materializeReviewResponse(
        await git.getReviewDocumentFileBodies({
          projectPath,
          documentId: snapshot.documentId,
          files: [{ path: "a.txt" }].map((file) => file.path),
          purpose: "visible",
        }),
      );
      expect(stale.status).toBe("stale");
      expect(stale.actualFingerprint).not.toBe(snapshot.to.fingerprint);
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("rejects Working Tree bodies when content changes while a body is loading", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-comparison-body-race-"),
    );
    const git = createGitOperations();

    try {
      await initRepoWithCommit(projectPath);
      const filePath = path.join(projectPath, "a.txt");
      await fs.writeFile(filePath, "before body load\n", "utf-8");
      const snapshot = await git.getComparisonSnapshot({
        projectPath,
        from: { kind: "revision", revision: "HEAD" },
        to: { kind: "working-tree" },
        mode: "direct",
      });
      expect(snapshot.status).toBe("ready");

      const trace = [];
      let mutated = false;
      trace.push = function (...entries) {
        const length = Array.prototype.push.apply(this, entries);
        for (const entry of entries) {
          if (mutated || !entry.args.some((arg) => arg.startsWith("-U")))
            continue;
          mutated = true;
          writeFileSync(filePath, "changed during body load\n", "utf-8");
        }
        return length;
      };

      const bodies = materializeReviewResponse(
        await git.getReviewDocumentFileBodies({
          projectPath,
          documentId: snapshot.documentId,
          files: [{ path: "a.txt" }].map((file) => file.path),
          trace,
          purpose: "visible",
        }),
      );

      expect(mutated).toBe(true);
      expect(bodies.status).toBe("stale");
      expect(bodies.actualFingerprint).not.toBe(snapshot.to.fingerprint);
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("keeps index-deleted tracked files as deletions when they are also untracked", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-comparison-index-deleted-"),
    );
    const git = createGitOperations();

    try {
      await initRepoWithCommit(projectPath);
      await runGitCommand(projectPath, ["rm", "--cached", "a.txt"]);
      const snapshot = await git.getComparisonSnapshot({
        projectPath,
        from: { kind: "revision", revision: "HEAD" },
        to: { kind: "working-tree" },
        mode: "direct",
      });

      expect(snapshot.status).toBe("ready");
      expect(snapshot.files).toEqual([
        expect.objectContaining({ path: "a.txt", status: "deleted" }),
      ]);
      const bodies = materializeReviewResponse(
        await git.getReviewDocumentFileBodies({
          projectPath,
          documentId: snapshot.documentId,
          files: [{ path: "a.txt" }].map((file) => file.path),
          purpose: "visible",
        }),
      );

      expect(bodies.status).toBe("ready");
      expect(bodies.files["a.txt"].rows).toContainEqual(
        expect.objectContaining({ kind: "del", text: "one" }),
      );
      expect(bodies.files["a.txt"].rows.some((row) => row.kind === "add")).toBe(
        false,
      );
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("keeps files tracked only at From as deletions when they are now untracked", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-comparison-historical-deletion-"),
    );
    const git = createGitOperations();

    try {
      await initRepoWithCommit(projectPath);
      const { stdout: fromHash } = await runGitCommand(projectPath, [
        "rev-parse",
        "HEAD",
      ]);
      await runGitCommand(projectPath, ["rm", "--cached", "a.txt"]);
      await runGitCommand(projectPath, ["commit", "-m", "stop tracking file"]);
      await fs.writeFile(path.join(projectPath, "a.txt"), "changed\n", "utf-8");

      const snapshot = await git.getComparisonSnapshot({
        projectPath,
        from: { kind: "revision", revision: fromHash.trim() },
        to: { kind: "working-tree" },
        mode: "direct",
      });
      expect(snapshot.status).toBe("ready");
      expect(snapshot.files).toEqual([
        expect.objectContaining({ path: "a.txt", status: "deleted" }),
      ]);

      const bodies = materializeReviewResponse(
        await git.getReviewDocumentFileBodies({
          projectPath,
          documentId: snapshot.documentId,
          files: [{ path: "a.txt" }].map((file) => file.path),
          purpose: "visible",
        }),
      );

      expect(bodies.status).toBe("ready");
      expect(bodies.files["a.txt"].rows).toContainEqual(
        expect.objectContaining({ kind: "del", text: "one" }),
      );
      expect(bodies.files["a.txt"].rows.some((row) => row.kind === "add")).toBe(
        false,
      );
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("compares the empty tree to an unborn Working Tree", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-comparison-unborn-"),
    );
    const git = createGitOperations();

    try {
      await runGitCommand(projectPath, ["init"]);
      await fs.writeFile(path.join(projectPath, "new.txt"), "new\n", "utf-8");

      const snapshot = await git.getComparisonSnapshot({
        projectPath,
        from: { kind: "revision", revision: GIT_EMPTY_TREE },
        to: { kind: "working-tree" },
        mode: "direct",
      });

      expect(snapshot).toMatchObject({
        status: "ready",
        to: { kind: "working-tree", headHash: null },
      });
      expect(snapshot.files).toContainEqual(
        expect.objectContaining({ path: "new.txt", status: "added" }),
      );
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("returns an empty document for equal endpoints", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-comparison-equal-"),
    );
    const git = createGitOperations();

    try {
      await initRepoWithCommit(projectPath);
      const snapshot = await git.getComparisonSnapshot({
        projectPath,
        from: { kind: "revision", revision: "HEAD" },
        to: { kind: "revision", revision: "HEAD" },
        mode: "direct",
      });

      expect(snapshot).toMatchObject({
        status: "ready",
        files: [],
        firstBodyCandidates: [],
      });
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("returns a typed status when revisions have no common ancestor", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-comparison-unrelated-"),
    );
    const git = createGitOperations();

    try {
      await initRepoWithCommit(projectPath);
      await runGitCommand(projectPath, ["checkout", "--orphan", "unrelated"]);
      await runGitCommand(projectPath, ["rm", "-rf", "."]);
      await fs.writeFile(
        path.join(projectPath, "unrelated.txt"),
        "unrelated\n",
        "utf-8",
      );
      await runGitCommand(projectPath, ["add", "unrelated.txt"]);
      await runGitCommand(projectPath, ["commit", "-m", "unrelated"]);

      const snapshot = await git.getComparisonSnapshot({
        projectPath,
        from: { kind: "revision", revision: "master" },
        to: { kind: "revision", revision: "unrelated" },
        mode: "merge-base",
      });

      expect(snapshot).toMatchObject({
        status: "no-merge-base",
        message: "These revisions do not have a common ancestor.",
      });
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("limits unsupported, binary, and oversized untracked files", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-comparison-untracked-limits-"),
    );
    const git = createGitOperations();

    try {
      await initRepoWithCommit(projectPath);
      await fs.writeFile(
        path.join(projectPath, "binary.dat"),
        Buffer.from([0, 1, 2]),
      );
      await fs.writeFile(
        path.join(projectPath, "oversized.txt"),
        Buffer.alloc(GIT_REVIEW_DOCUMENT_LIMITS.maxFilePatchBytes + 1, 0x61),
      );
      await fs.symlink("a.txt", path.join(projectPath, "linked.txt"));

      const snapshot = await git.getComparisonSnapshot({
        projectPath,
        from: { kind: "revision", revision: "HEAD" },
        to: { kind: "working-tree" },
        mode: "direct",
      });

      expect(snapshot.status).toBe("ready");
      expect(
        snapshot.files.find((file) => file.path === "binary.dat"),
      ).toMatchObject({
        bodyState: "binary",
        limitReason: "binary",
      });
      expect(
        snapshot.files.find((file) => file.path === "oversized.txt"),
      ).toMatchObject({
        bodyState: "too-large",
        limitReason: "file-too-many-bytes",
      });
      expect(
        snapshot.files.find((file) => file.path === "linked.txt"),
      ).toMatchObject({
        bodyState: "too-large",
        limitReason: "unsupported-file-kind",
      });
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("bounds untracked line counting across the comparison summary", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-comparison-untracked-budget-"),
    );
    const git = createGitOperations();

    try {
      await initRepoWithCommit(projectPath);
      for (const name of ["one.txt", "two.txt", "three.txt"]) {
        await fs.writeFile(
          path.join(projectPath, name),
          Buffer.alloc(4_000_000, 0x61),
        );
      }

      const snapshot = await git.getComparisonSnapshot({
        projectPath,
        from: { kind: "revision", revision: "HEAD" },
        to: { kind: "working-tree" },
        mode: "direct",
      });

      expect(snapshot.status).toBe("ready");
      expect(
        snapshot.files.filter((file) => file.statsKnown === false),
      ).toHaveLength(1);
      expect(
        snapshot.files
          .filter((file) => file.statsKnown !== false)
          .map((file) => file.additions),
      ).toEqual([1, 1]);
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("keeps budget-limited untracked summaries stable across I/O completion orders", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-comparison-budget-order-"),
    );
    const git = createGitOperations();
    const names = ["one.txt", "three.txt", "two.txt"];
    try {
      await initRepoWithCommit(projectPath);
      for (const name of names) {
        await fs.writeFile(path.join(projectPath, name), Buffer.alloc(4_000_000, 0x61));
      }
      const snapshotWithDelayedStat = async (delayedName) => {
        const handles = new Map();
        const stats = new Map();
        const mocks = [];
        const open = fs.open.bind(fs);
        const lstat = fs.lstat.bind(fs);
        try {
          for (const name of names) {
            const filePath = path.join(projectPath, name);
            const handle = await open(filePath, "r");
            const fileStats = await handle.stat();
            handles.set(filePath, handle);
            stats.set(filePath, fileStats);
            mocks.push(spyOn(handle, "stat").mockImplementation(async () => {
              // Controls admission order without depending on filesystem timing.
              if (name === delayedName) {
                for (let turn = 0; turn < 10; turn++) await Promise.resolve();
              }
              return fileStats;
            }));
          }
          mocks.push(spyOn(fs, "open").mockImplementation((filePath, ...args) =>
            handles.has(filePath) ? Promise.resolve(handles.get(filePath)) : open(filePath, ...args),
          ));
          mocks.push(spyOn(fs, "lstat").mockImplementation((filePath, options) =>
            stats.has(filePath) && !options
              ? Promise.resolve(stats.get(filePath))
              : lstat(filePath, options),
          ));
          return await git.getComparisonSnapshot({
            projectPath,
            from: { kind: "revision", revision: "HEAD" },
            to: { kind: "working-tree" },
            mode: "direct",
          });
        } finally {
          for (const mock of mocks) mock.mockRestore();
          for (const handle of handles.values()) await handle.close();
        }
      };
      const first = await snapshotWithDelayedStat("one.txt");
      const repeated = await snapshotWithDelayedStat("two.txt");
      expect(first.status).toBe("ready");
      expect(repeated.status).toBe("ready");
      expect(repeated.to.fingerprint).toBe(first.to.fingerprint);
      expect(repeated.documentId).toBe(first.documentId);
      expect(repeated.files).toEqual(first.files);
      expect(first.files.filter((file) => file.statsKnown === false).map((file) => file.path))
        .toEqual(["two.txt"]);
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });
});
