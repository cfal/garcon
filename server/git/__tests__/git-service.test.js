import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { GitDomainError } from "../git-types.js";
import { createGitService as createProductionGitService } from "../git-service.js";
import { runGitWithStdin } from "../run.js";
import { resolveNetworkGitTimeoutMs } from "../status.js";
import { generateCommitMessage } from "../commit-message.js";
import { collectCommitMessageDiffContext } from "../status.js";
import { runGitTraced } from "../run.js";
import { GIT_EMPTY_TREE } from "../comparison.js";
import {
  isUnresolvedRevision,
  needsRevisionFailureDiagnostics,
} from "../comparison-errors.js";
import { GIT_REVIEW_DOCUMENT_LIMITS } from "../types.js";
import { parseUnifiedPatchToRenderedRows } from "../rendered-diff.js";
import {
  createWorktreeOperations,
  serializeWorktreeMtime,
} from "../worktrees.js";

// Minimal classifier stub for toHttpError tests
function mockClassifyGitError(error) {
  const msg = error?.message || "";
  if (msg.includes("hostname")) {
    return {
      code: "NETWORK",
      status: 502,
      message: "Could not reach the remote host.",
      details: "Verify network access.",
    };
  }
  return {
    code: "UNKNOWN",
    status: 500,
    message: msg || "Git operation failed.",
  };
}

const mockAgents = {
  runSingleQuery: () => Promise.resolve("chore: stub"),
};

function materializeReviewResponse(response) {
  if (response.status !== "ready") return response;
  return {
    ...response,
    files: Object.fromEntries(
      Object.entries(response.files).map(([filePath, body]) => {
        const rendered = body.patch
          ? parseUnifiedPatchToRenderedRows(body.patch, { allowMultipleFileSections: true })
          : { rows: [], hunks: [] };
        return [filePath, { ...body, ...rendered }];
      }),
    ),
  };
}

function createGitService(options) {
  const service = createProductionGitService(options);
  return {
    ...service,
    async getReviewFileBodies(request) {
      let response = await service.getReviewDocumentFileBodies({
        projectPath: request.projectPath,
        documentId: request.documentId,
        files: request.files,
        purpose: "visible",
        trace: request.trace,
        signal: request.signal,
      });
      if (response.status === "document-expired") {
        const snapshot = await service.getWorkbenchSnapshot({
          projectPath: request.projectPath,
          mode: request.mode,
          context: request.context,
          trace: request.trace,
          signal: request.signal,
        });
        if (snapshot.status !== "ready") throw new Error(snapshot.message);
        response = await service.getReviewDocumentFileBodies({
          projectPath: request.projectPath,
          documentId: snapshot.reviewSummary.documentId,
          files: request.files,
          purpose: "visible",
          trace: request.trace,
          signal: request.signal,
        });
      }
      return materializeReviewResponse(response);
    },
    async getCommitFileBodies(request) {
      return materializeReviewResponse(await service.getReviewDocumentFileBodies({
        projectPath: request.projectPath,
        documentId: request.documentId,
        files: request.files.map((file) => file.path),
        purpose: "visible",
        trace: request.trace,
        signal: request.signal,
      }));
    },
    async getComparisonFileBodies(request) {
      return materializeReviewResponse(await service.getReviewDocumentFileBodies({
        projectPath: request.projectPath,
        documentId: request.documentId,
        files: request.files.map((file) => file.path),
        purpose: "visible",
        trace: request.trace,
        signal: request.signal,
      }));
    },
  };
}

async function runGitCommand(cwd, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      ...(options.env ? { env: { ...process.env, ...options.env } } : {}),
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(`git ${args.join(" ")} failed: ${stderr || stdout}`));
    });
  });
}

function detectReftableSupport() {
  const probePath = mkdtempSync(path.join(os.tmpdir(), "garcon-reftable-probe-"));
  try {
    const result = spawnSync(
      "git",
      ["init", "--ref-format=reftable", probePath],
      { encoding: "utf8" },
    );
    if (result.status === 0) return true;

    const output = `${result.stderr || ""}${result.stdout || ""}`;
    if (/unknown option|unknown ref storage format|unsupported/i.test(output)) {
      return false;
    }
    throw new Error(`Git reftable capability probe failed: ${output}`);
  } finally {
    rmSync(probePath, { recursive: true, force: true });
  }
}

const supportsReftable = detectReftableSupport();

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

async function initRepoWithCommit(projectPath) {
  await runGitCommand(projectPath, ["init"]);
  await runGitCommand(projectPath, [
    "config",
    "user.email",
    "test@example.com",
  ]);
  await runGitCommand(projectPath, ["config", "user.name", "Test User"]);
  await fs.writeFile(path.join(projectPath, "a.txt"), "one\n", "utf-8");
  await runGitCommand(projectPath, ["add", "a.txt"]);
  await runGitCommand(projectPath, ["commit", "-m", "initial"]);
}

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

async function initRepoWithLinkedFeature(projectPath, linkedPath) {
  await initRepoWithCommit(projectPath);
  await runGitCommand(projectPath, [
    "worktree",
    "add",
    "-b",
    "feature",
    linkedPath,
  ]);
}

async function commitFileAt(projectPath, file, contents, message, timestamp) {
  await fs.writeFile(path.join(projectPath, file), contents, "utf-8");
  await runGitCommand(projectPath, ["add", file]);
  await runGitCommand(projectPath, ["commit", "-m", message], {
    env: {
      GIT_AUTHOR_DATE: timestamp,
      GIT_COMMITTER_DATE: timestamp,
    },
  });
  const { stdout } = await runGitCommand(projectPath, ["rev-parse", "HEAD"]);
  return stdout.trim();
}

function findTreeNode(nodes, nodePath) {
  for (const node of nodes) {
    if (node.path === nodePath) return node;
    if (Array.isArray(node.children)) {
      const child = findTreeNode(node.children, nodePath);
      if (child) return child;
    }
  }
  return null;
}

async function expectSummaryAndBodyFingerprintsMatch(
  git,
  projectPath,
  { file = "a.txt", mode = "working" } = {},
) {
  const snapshot = await git.getWorkbenchSnapshot({
    projectPath,
    mode,
    context: 5,
  });
  expect(snapshot.status).toBe("ready");
  const summary = snapshot.reviewSummary.files.find(
    (entry) => entry.path === file,
  );
  expect(summary).toBeDefined();

  const body = (
    await git.getReviewFileBodies({
      projectPath,
      documentId: snapshot.reviewSummary.documentId,
      files: [file],
      mode,
      context: 5,
    })
  ).files[file];

  expect(body).toBeDefined();
  expect(body.bodyFingerprint).toBe(summary.bodyFingerprint);
}

describe("GitDomainError", () => {
  it("extends Error with name and code", () => {
    const err = new GitDomainError("INVALID_INPUT", "bad input");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("GitDomainError");
    expect(err.code).toBe("INVALID_INPUT");
    expect(err.message).toBe("bad input");
  });
});

describe("createGitService", () => {
  const git = createProductionGitService({
    agents: mockAgents,
    classifyGitError: mockClassifyGitError,
  });

  it("returns an object with all expected service methods", () => {
    const expectedMethods = [
      "getStatus",
      "initialCommit",
      "commit",
      "getBranches",
      "getRefs",
      "checkout",
      "createBranch",
      "getHistoryCommits",
      "getCommitSnapshot",
      "getComparisonSnapshot",
      "generateCommitMessageForFiles",
      "getRemoteStatus",
      "getRemotes",
      "fetch",
      "pull",
      "push",
      "discard",
      "deleteUntracked",
      "getWorkbenchSnapshot",
      "getWorkingTreeFingerprint",
      "getQuickSummary",
      "getReviewDocumentFileBodies",
      "stageSelection",
      "stageHunk",
      "getWorktrees",
      "getTargetCandidates",
      "createWorktree",
      "removeWorktree",
      "commitIndex",
      "stagePaths",
      "revertCommit",
      "getConflicts",
      "getConflictDetails",
      "acceptConflictSide",
      "markConflictResolved",
      "getStashes",
      "createStash",
      "applyStash",
      "popStash",
      "dropStash",
      "getFileHistory",
      "getBlame",
      "getGraph",
      "toHttpError",
    ];
    for (const method of expectedMethods) {
      expect(typeof git[method]).toBe("function");
    }
    expect(git.stageFile).toBeUndefined();
  });
});

describe("stage path operations", () => {
  it("stages and unstages multiple pathspecs in one service call", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-stage-paths-"),
    );
    const git = createGitService({
      agents: mockAgents,
      classifyGitError: mockClassifyGitError,
    });

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

describe("selected-file commits", () => {
  it("excludes unrelated staged changes", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-selected-commit-"),
    );
    const git = createGitService({
      agents: mockAgents,
      classifyGitError: mockClassifyGitError,
    });

    try {
      await initRepoWithCommit(projectPath);
      await fs.writeFile(path.join(projectPath, "a.txt"), "selected\n", "utf-8");
      await fs.writeFile(path.join(projectPath, "new.txt"), "new\n", "utf-8");
      await fs.writeFile(path.join(projectPath, "HEAD"), "untracked\n", "utf-8");
      await fs.writeFile(path.join(projectPath, "unrelated.txt"), "staged\n", "utf-8");
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
    const git = createGitService({
      agents: mockAgents,
      classifyGitError: mockClassifyGitError,
    });

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

      const { stdout } = await runGitCommand(projectPath, ["log", "-2", "--format=%H"]);
      const commits = await Promise.all(stdout.trim().split("\n").map(async (commit) => {
        const result = await runGitCommand(projectPath, [
          "show",
          "--format=%s",
          "--name-only",
          commit,
        ]);
        return result.stdout.trim().split("\n").filter(Boolean);
      }));
      expect(commits.sort((left, right) => left[0].localeCompare(right[0]))).toEqual([
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
    const git = createGitService({
      agents: mockAgents,
      classifyGitError: mockClassifyGitError,
    });
    const indexLockPath = path.join(projectPath, ".git", "index.lock");

    try {
      await initRepoWithCommit(projectPath);
      await fs.writeFile(path.join(projectPath, "a.txt"), "selected\n", "utf-8");
      await fs.writeFile(indexLockPath, "locked\n", "utf-8");

      await expect(git.commit({
        projectPath,
        message: "selected change",
        files: ["a.txt"],
      })).resolves.toMatchObject({
        success: true,
        commitScope: "selected-files",
        indexSynchronized: false,
      });

      const committed = await runGitCommand(projectPath, ["show", "HEAD:a.txt"]);
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
    const git = createGitService({
      agents: mockAgents,
      classifyGitError: mockClassifyGitError,
    });

    try {
      await initRepoWithCommit(projectPath);
      await fs.writeFile(path.join(projectPath, "a.txt"), "selected\n", "utf-8");
      const staleIndexPath = path.join(projectPath, ".git", ".garcon-index-stale");
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

      await expect(fs.access(staleIndexPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.access(staleLockPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("preserves the real index when a selected-file commit fails", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-failed-selected-commit-"),
    );
    const git = createGitService({
      agents: mockAgents,
      classifyGitError: mockClassifyGitError,
    });

    try {
      await initRepoWithCommit(projectPath);
      await fs.writeFile(path.join(projectPath, "a.txt"), "selected\n", "utf-8");
      await fs.writeFile(path.join(projectPath, "unrelated.txt"), "staged\n", "utf-8");
      await runGitCommand(projectPath, ["add", "unrelated.txt"]);
      const hookPath = path.join(projectPath, ".git", "hooks", "pre-commit");
      await fs.writeFile(hookPath, "#!/bin/sh\nexit 1\n", "utf-8");
      await fs.chmod(hookPath, 0o755);

      await expect(git.commit({
        projectPath,
        message: "selected change",
        files: ["a.txt"],
      })).rejects.toThrow();

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
    const git = createGitService({
      agents: mockAgents,
      classifyGitError: mockClassifyGitError,
    });

    try {
      await initRepoWithCommit(projectPath);
      await fs.writeFile(path.join(projectPath, "a.txt"), "selected\n", "utf-8");
      await fs.writeFile(path.join(projectPath, "unrelated.txt"), "staged\n", "utf-8");
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

      const committed = await runGitCommand(projectPath, ["show", "HEAD:a.txt"]);
      const staged = await runGitCommand(projectPath, [
        "diff",
        "--cached",
        "--name-only",
      ]);
      expect(committed.stdout).toBe("formatted\n");
      expect(await fs.readFile(path.join(projectPath, "a.txt"), "utf-8"))
        .toBe("formatted\n");
      expect(staged.stdout.trim()).toBe("unrelated.txt");
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("synchronizes unselected paths added by a pre-commit hook", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-hook-added-path-"),
    );
    const git = createGitService({
      agents: mockAgents,
      classifyGitError: mockClassifyGitError,
    });

    try {
      await initRepoWithCommit(projectPath);
      await fs.writeFile(path.join(projectPath, "a.txt"), "selected\n", "utf-8");
      await fs.writeFile(path.join(projectPath, "extra.txt"), "hooked\n", "utf-8");
      const hookPath = path.join(projectPath, ".git", "hooks", "pre-commit");
      await fs.writeFile(hookPath, "#!/bin/sh\ngit add -- extra.txt\n", "utf-8");
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
      const status = await runGitCommand(projectPath, ["status", "--porcelain"]);
      expect(result.indexSynchronized).toBe(true);
      expect(committed.stdout.trim().split("\n")).toEqual(["a.txt", "extra.txt"]);
      expect(status.stdout).toBe("");
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("serializes whole-index commits behind selected-file synchronization", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-serialized-index-commit-"),
    );
    const git = createGitService({
      agents: mockAgents,
      classifyGitError: mockClassifyGitError,
    });
    const selectedHookPath = path.join(projectPath, ".selected-hook-entered");
    const realHookPath = path.join(projectPath, ".real-hook-entered");
    const releaseHookPath = path.join(projectPath, ".release-hook");
    let selectedCommit;
    let indexCommitOutcome;

    try {
      await initRepoWithCommit(projectPath);
      await fs.writeFile(path.join(projectPath, "a.txt"), "selected\n", "utf-8");
      const hookPath = path.join(projectPath, ".git", "hooks", "post-commit");
      await fs.writeFile(
        hookPath,
        [
          "#!/bin/sh",
          "case \"$GIT_INDEX_FILE\" in",
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
      indexCommitOutcome = git.commitIndex({
        projectPath,
        message: "stale index",
      }).then(
        (result) => ({ status: "fulfilled", result }),
        (error) => ({ status: "rejected", error }),
      );

      await Bun.sleep(500);
      await expect(fs.access(realHookPath)).rejects.toMatchObject({ code: "ENOENT" });
      await fs.writeFile(releaseHookPath, "released\n", "utf-8");
      await selectedCommit;
      const outcome = await indexCommitOutcome;
      expect(outcome.status).toBe("rejected");
      expect(outcome.error?.message).toMatch(/nothing (?:added )?to commit/);

      const log = await runGitCommand(projectPath, ["log", "--format=%s"]);
      expect(log.stdout.trim().split("\n")).toEqual(["selected change", "initial"]);
    } finally {
      await fs.writeFile(releaseHookPath, "released\n", "utf-8").catch(() => undefined);
      await Promise.allSettled([selectedCommit, indexCommitOutcome].filter(Boolean));
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  }, 10_000);

  it("rejects paths outside the project root as invalid input", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-outside-commit-"),
    );
    const git = createGitService({
      agents: mockAgents,
      classifyGitError: mockClassifyGitError,
    });

    try {
      await initRepoWithCommit(projectPath);
      let rejection;
      try {
        await git.commit({
          projectPath,
          message: "outside change",
          files: ["../outside.txt"],
        });
      } catch (error) {
        rejection = error;
      }

      expect(rejection).toBeInstanceOf(GitDomainError);
      const response = git.toHttpError(rejection);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "Pathspecs must resolve inside the project root.",
      });
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("completes a conflicted merge with the resolved index", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-merge-commit-"),
    );
    const git = createGitService({
      agents: mockAgents,
      classifyGitError: mockClassifyGitError,
    });

    try {
      await initRepoWithCommit(projectPath);
      await runGitCommand(projectPath, ["checkout", "-b", "feature"]);
      await fs.writeFile(path.join(projectPath, "a.txt"), "feature\n", "utf-8");
      await runGitCommand(projectPath, ["commit", "-am", "feature"]);
      await runGitCommand(projectPath, ["checkout", "master"]);
      await fs.writeFile(path.join(projectPath, "a.txt"), "main\n", "utf-8");
      await runGitCommand(projectPath, ["commit", "-am", "main"]);
      await expect(runGitCommand(projectPath, ["merge", "feature"]))
        .rejects.toThrow("CONFLICT");
      await fs.writeFile(path.join(projectPath, "a.txt"), "resolved\n", "utf-8");

      const result = await git.commit({
        projectPath,
        message: "merge feature",
        files: ["a.txt"],
      });

      const parents = await runGitCommand(projectPath, ["show", "-s", "--format=%P", "HEAD"]);
      expect(result.commitScope).toBe("whole-index");
      expect(parents.stdout.trim().split(" ")).toHaveLength(2);
      const status = await runGitCommand(projectPath, ["status", "--porcelain"]);
      expect(status.stdout).toBe("");
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("completes a conflicted cherry-pick with the resolved index", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-cherry-pick-commit-"),
    );
    const git = createGitService({
      agents: mockAgents,
      classifyGitError: mockClassifyGitError,
    });

    try {
      await initRepoWithCommit(projectPath);
      await runGitCommand(projectPath, ["checkout", "-b", "feature"]);
      await fs.writeFile(path.join(projectPath, "a.txt"), "feature\n", "utf-8");
      await fs.writeFile(path.join(projectPath, "b.txt"), "feature\n", "utf-8");
      await runGitCommand(projectPath, ["add", "a.txt", "b.txt"]);
      await runGitCommand(projectPath, ["commit", "-m", "feature change"]);
      const featureCommit = await runGitCommand(projectPath, ["rev-parse", "HEAD"]);

      await runGitCommand(projectPath, ["checkout", "master"]);
      await fs.writeFile(path.join(projectPath, "a.txt"), "main\n", "utf-8");
      await runGitCommand(projectPath, ["commit", "-am", "main change"]);
      await expect(
        runGitCommand(projectPath, ["cherry-pick", featureCommit.stdout.trim()]),
      ).rejects.toThrow();
      await fs.writeFile(path.join(projectPath, "a.txt"), "resolved\n", "utf-8");

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
      const status = await runGitCommand(projectPath, ["status", "--porcelain"]);
      expect(status.stdout).toBe("");
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("completes a conflicted revert with the resolved index", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-revert-commit-"),
    );
    const git = createGitService({
      agents: mockAgents,
      classifyGitError: mockClassifyGitError,
    });

    try {
      await initRepoWithCommit(projectPath);
      await fs.writeFile(path.join(projectPath, "a.txt"), "target\n", "utf-8");
      await fs.writeFile(path.join(projectPath, "b.txt"), "target\n", "utf-8");
      await runGitCommand(projectPath, ["add", "a.txt", "b.txt"]);
      await runGitCommand(projectPath, ["commit", "-m", "two-file change"]);
      const reverted = await runGitCommand(projectPath, ["rev-parse", "HEAD"]);

      await fs.writeFile(path.join(projectPath, "a.txt"), "later\n", "utf-8");
      await runGitCommand(projectPath, ["commit", "-am", "later change"]);
      await expect(runGitCommand(projectPath, ["revert", reverted.stdout.trim()]))
        .rejects.toThrow("could not revert");
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
      const status = await runGitCommand(projectPath, ["status", "--porcelain"]);
      expect(status.stdout).toBe("");
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("completes a conflicted rebase with the resolved index", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-rebase-commit-"),
    );
    const git = createGitService({
      agents: mockAgents,
      classifyGitError: mockClassifyGitError,
    });

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
      await expect(runGitCommand(projectPath, ["rebase", "master"]))
        .rejects.toThrow("could not apply");
      await fs.writeFile(path.join(projectPath, "a.txt"), "resolved\n", "utf-8");

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
      const commitCount = await runGitCommand(projectPath, ["rev-list", "--count", "HEAD"]);
      expect(commitCount.stdout.trim()).toBe("3");
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("completes an apply-backend rebase conflict with the resolved index", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-rebase-apply-commit-"),
    );
    const git = createGitService({
      agents: mockAgents,
      classifyGitError: mockClassifyGitError,
    });

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
      await fs.writeFile(path.join(projectPath, "a.txt"), "resolved\n", "utf-8");

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
      const status = await runGitCommand(projectPath, ["status", "--porcelain"]);
      expect(status.stdout).toBe("");
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("keeps selected-file isolation at an interactive rebase edit stop", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-rebase-edit-commit-"),
    );
    const git = createGitService({
      agents: mockAgents,
      classifyGitError: mockClassifyGitError,
    });

    try {
      await initRepoWithCommit(projectPath);
      await runGitCommand(projectPath, ["checkout", "-b", "feature"]);
      await fs.writeFile(path.join(projectPath, "feature.txt"), "feature\n", "utf-8");
      await runGitCommand(projectPath, ["add", "feature.txt"]);
      await runGitCommand(projectPath, ["commit", "-m", "feature change"]);

      await runGitCommand(projectPath, ["checkout", "master"]);
      await fs.writeFile(path.join(projectPath, "main.txt"), "main\n", "utf-8");
      await runGitCommand(projectPath, ["add", "main.txt"]);
      await runGitCommand(projectPath, ["commit", "-m", "main change"]);
      await runGitCommand(projectPath, ["checkout", "feature"]);

      const sequenceEditorPath = path.join(projectPath, ".git", "sequence-editor.cjs");
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

      await fs.writeFile(path.join(projectPath, "a.txt"), "selected\n", "utf-8");
      await fs.writeFile(path.join(projectPath, "unrelated.txt"), "unrelated\n", "utf-8");
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
      const status = await runGitCommand(projectPath, ["status", "--porcelain"]);
      expect(status.stdout.trim()).toBe("A  unrelated.txt");
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });
});

describe("network git timeout", () => {
  it("caps at the runner default, tightens with the idle budget, and keeps a floor", () => {
    expect(resolveNetworkGitTimeoutMs(120)).toBe(30_000);
    expect(resolveNetworkGitTimeoutMs(20)).toBe(18_000);
    expect(resolveNetworkGitTimeoutMs(2)).toBe(1_000);
  });

  it("does not tighten when the idle budget is disabled", () => {
    expect(resolveNetworkGitTimeoutMs(0)).toBe(30_000);
  });
});

describe("discard", () => {
  const git = createProductionGitService({
    agents: mockAgents,
    classifyGitError: mockClassifyGitError,
  });
  it("discards only worktree edits for staged-added files, keeping the addition", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-discard-"),
    );
    try {
      await initRepoWithCommit(projectPath);
      await fs.writeFile(path.join(projectPath, "added.txt"), "staged\n", "utf-8");
      await runGitCommand(projectPath, ["add", "added.txt"]);
      await fs.writeFile(path.join(projectPath, "added.txt"), "staged\nmodified\n", "utf-8");
      expect((await runGitCommand(projectPath, ["status", "--porcelain"])).stdout.trim())
        .toBe("AM added.txt");

      await git.discard({ projectPath, file: "added.txt" });

      expect((await runGitCommand(projectPath, ["status", "--porcelain"])).stdout.trim())
        .toBe("A  added.txt");
      expect(await fs.readFile(path.join(projectPath, "added.txt"), "utf-8"))
        .toBe("staged\n");
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
      await fs.writeFile(path.join(projectPath, "added.txt"), "staged\n", "utf-8");
      await runGitCommand(projectPath, ["add", "added.txt"]);
      await fs.rm(path.join(projectPath, "added.txt"));
      expect((await runGitCommand(projectPath, ["status", "--porcelain"])).stdout.trim())
        .toBe("AD added.txt");

      await git.discard({ projectPath, file: "added.txt" });

      expect((await runGitCommand(projectPath, ["status", "--porcelain"])).stdout.trim())
        .toBe("A  added.txt");
      expect(await fs.readFile(path.join(projectPath, "added.txt"), "utf-8"))
        .toBe("staged\n");
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
      await fs.writeFile(path.join(projectPath, "added.txt"), "staged\n", "utf-8");
      await runGitCommand(projectPath, ["add", "added.txt"]);
      await fs.rm(path.join(projectPath, "added.txt"));
      await fs.symlink("elsewhere.txt", path.join(projectPath, "added.txt"));
      expect((await runGitCommand(projectPath, ["status", "--porcelain"])).stdout.trim())
        .toBe("AT added.txt");

      await git.discard({ projectPath, file: "added.txt" });

      expect((await runGitCommand(projectPath, ["status", "--porcelain"])).stdout.trim())
        .toBe("A  added.txt");
      const stats = await fs.lstat(path.join(projectPath, "added.txt"));
      expect(stats.isSymbolicLink()).toBe(false);
      expect(await fs.readFile(path.join(projectPath, "added.txt"), "utf-8"))
        .toBe("staged\n");
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
        (await runGitCommand(projectPath, ["status", "--porcelain"])).stdout
          .replace(/\n$/, "");
      expect(await porcelain()).toBe(" T a.txt");

      await git.discard({ projectPath, file: "a.txt" });

      expect(await porcelain()).toBe("");
      const stats = await fs.lstat(path.join(projectPath, "a.txt"));
      expect(stats.isSymbolicLink()).toBe(false);
      expect(await fs.readFile(path.join(projectPath, "a.txt"), "utf-8"))
        .toBe("one\n");
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
      await fs.writeFile(path.join(projectPath, "added.txt"), "staged\n", "utf-8");
      await runGitCommand(projectPath, ["add", "added.txt"]);
      expect((await runGitCommand(projectPath, ["status", "--porcelain"])).stdout.trim())
        .toBe("A  added.txt");

      await git.discard({ projectPath, file: "added.txt" });

      expect((await runGitCommand(projectPath, ["status", "--porcelain"])).stdout.trim())
        .toBe("?? added.txt");
      expect(await fs.readFile(path.join(projectPath, "added.txt"), "utf-8"))
        .toBe("staged\n");
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
      const { stdout: hash } = await runGitCommand(
        projectPath,
        ["hash-object", "-w", "u.txt"],
      );
      // Plants a stage-3-only index entry, the layout behind UA status.
      await runGitWithStdin(
        projectPath,
        ["update-index", "--index-info"],
        `100644 ${hash.trim()} 3\tu.txt\n`,
      );
      expect((await runGitCommand(projectPath, ["status", "--porcelain"])).stdout.trim())
        .toBe("UA u.txt");

      await git.discard({ projectPath, file: "u.txt" });

      expect((await runGitCommand(projectPath, ["status", "--porcelain"])).stdout.trim())
        .toBe("?? u.txt");
      expect(await fs.readFile(path.join(projectPath, "u.txt"), "utf-8"))
        .toBe("theirs\n");
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
      const { stdout: hash } = await runGitCommand(
        projectPath,
        ["hash-object", "-w", "ours.txt"],
      );
      // Plants a stage-2-only index entry, the layout behind AU status.
      await runGitWithStdin(
        projectPath,
        ["update-index", "--index-info"],
        `100644 ${hash.trim()} 2\tours.txt\n`,
      );
      expect((await runGitCommand(projectPath, ["status", "--porcelain"])).stdout.trim())
        .toBe("AU ours.txt");

      await git.discard({ projectPath, file: "ours.txt" });

      expect((await runGitCommand(projectPath, ["status", "--porcelain"])).stdout.trim())
        .toBe("?? ours.txt");
      expect(await fs.readFile(path.join(projectPath, "ours.txt"), "utf-8"))
        .toBe("ours\n");
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });
});

describe("commit message generation", () => {
  it("builds the staged diff with one batched pathspec command for normal selections", async () => {
    const calls = [];
    const diffContext = await collectCommitMessageDiffContext(
      "/repo",
      ["src/a.ts", "src/b.ts"],
      async (cwd, args, options) => {
        calls.push({ cwd, args, options });
        return { stdout: "patch text" };
      },
    );

    expect(diffContext).toBe("patch text");
    expect(calls).toEqual([
      {
        cwd: "/repo",
        args: [
          "diff",
          "--cached",
          "--no-ext-diff",
          "--no-color",
          "-U10",
          "--",
          "src/a.ts",
          "src/b.ts",
        ],
        options: { disableOptionalLocks: true },
      },
    ]);
  });

  it("keeps up to eighty thousand diff characters in generated commit message prompts", async () => {
    let capturedPrompt = "";
    const marker = "after-limit-marker";
    const diffContext = `${"a".repeat(80_000)}${marker}`;

    await generateCommitMessage(
      ["a.txt"],
      diffContext,
      "claude",
      "/tmp",
      (prompt) => {
        capturedPrompt = prompt;
        return Promise.resolve("chore: stub");
      },
    );

    const diffStart =
      capturedPrompt.indexOf("Diff excerpt:\n") + "Diff excerpt:\n".length;
    const diffEnd = capturedPrompt.indexOf(
      "\n\nReturn only the commit message now.",
      diffStart,
    );
    const diffExcerpt = capturedPrompt.slice(diffStart, diffEnd);

    expect(diffExcerpt).toHaveLength(80_000);
    expect(diffExcerpt).not.toContain(marker);
  });

  it("preserves replacement metacharacters in commit context", async () => {
    let capturedPrompt = "";

    await generateCommitMessage(
      ["src/$&-$1.ts"],
      "diff with $& and $1 and $$",
      "claude",
      "/tmp",
      (prompt) => {
        capturedPrompt = prompt;
        return Promise.resolve("chore: stub");
      },
      { customPrompt: "Files:\n{{files}}\nDiff:\n{{diff}}" },
    );

    expect(capturedPrompt).toBe(
      "Files:\n- src/$&-$1.ts\nDiff:\ndiff with $& and $1 and $$",
    );
  });

  it("returns the server-applied directory prefix with generated messages", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-commit-message-prefix-"),
    );
    const git = createGitService({
      agents: mockAgents,
      classifyGitError: mockClassifyGitError,
    });

    try {
      await initRepoWithCommit(projectPath);
      await fs.mkdir(path.join(projectPath, "feature", "auth"), {
        recursive: true,
      });
      await fs.writeFile(
        path.join(projectPath, "feature", "auth", "a.txt"),
        "a\n",
        "utf-8",
      );
      await fs.writeFile(
        path.join(projectPath, "feature", "auth", "b.txt"),
        "b\n",
        "utf-8",
      );
      await runGitCommand(projectPath, [
        "add",
        "feature/auth/a.txt",
        "feature/auth/b.txt",
      ]);

      const result = await git.generateCommitMessageForFiles({
        projectPath,
        files: ["feature/auth/a.txt", "feature/auth/b.txt"],
        agentId: "claude",
        useCommonDirPrefix: true,
      });

      expect(result).toEqual({
        message: "feature/auth: chore: stub",
        directoryPrefix: "feature/auth",
      });
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("captures selected multi-file staged diffs from a real repository", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-commit-message-batched-"),
    );
    let capturedPrompt = "";
    let capturedOptions;
    const git = createGitService({
      agents: {
        runSingleQuery: (prompt, options) => {
          capturedPrompt = prompt;
          capturedOptions = options;
          return Promise.resolve("chore: stub");
        },
      },
      classifyGitError: mockClassifyGitError,
    });

    try {
      await initRepoWithCommit(projectPath);
      await fs.mkdir(path.join(projectPath, "feature"), { recursive: true });
      await fs.writeFile(
        path.join(projectPath, "feature", "a.txt"),
        "alpha\n",
        "utf-8",
      );
      await fs.writeFile(
        path.join(projectPath, "feature", "name with space.txt"),
        "space\n",
        "utf-8",
      );
      await fs.writeFile(
        path.join(projectPath, "unselected.txt"),
        "skip\n",
        "utf-8",
      );
      await runGitCommand(projectPath, [
        "add",
        "feature/a.txt",
        "feature/name with space.txt",
        "unselected.txt",
      ]);

      await git.generateCommitMessageForFiles({
        projectPath,
        files: ["feature/a.txt", "feature/name with space.txt"],
        agentId: "claude",
        thinkingMode: "max",
      });

      expect(capturedPrompt).toContain(
        "diff --git a/feature/a.txt b/feature/a.txt",
      );
      expect(capturedPrompt).toContain("+alpha");
      expect(capturedPrompt).toContain(
        "diff --git a/feature/name with space.txt b/feature/name with space.txt",
      );
      expect(capturedPrompt).toContain("+space");
      expect(capturedPrompt).not.toContain("unselected.txt");
      expect(capturedPrompt).not.toContain("+skip");
      expect(capturedOptions).toMatchObject({
        agentId: "claude",
        cwd: projectPath,
        thinkingMode: "max",
        timeoutMs: 110_000,
      });
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("uses ten lines of hunk context for generated commit message prompts", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-commit-message-context-"),
    );
    let capturedPrompt = "";
    const git = createGitService({
      agents: {
        runSingleQuery: (prompt) => {
          capturedPrompt = prompt;
          return Promise.resolve("chore: stub");
        },
      },
      classifyGitError: mockClassifyGitError,
    });

    try {
      await initRepoWithCommit(projectPath);
      const lines = Array.from(
        { length: 25 },
        (_, index) => `line ${index + 1}`,
      );
      await fs.writeFile(
        path.join(projectPath, "a.txt"),
        `${lines.join("\n")}\n`,
        "utf-8",
      );
      await runGitCommand(projectPath, ["add", "a.txt"]);
      await runGitCommand(projectPath, ["commit", "-m", "expand fixture"]);

      lines[12] = "line 13 changed";
      await fs.writeFile(
        path.join(projectPath, "a.txt"),
        `${lines.join("\n")}\n`,
        "utf-8",
      );
      await runGitCommand(projectPath, ["add", "a.txt"]);

      await git.generateCommitMessageForFiles({
        projectPath,
        files: ["a.txt"],
        agentId: "claude",
      });

      expect(capturedPrompt).toContain("@@ -3,21 +3,21 @@");
      expect(capturedPrompt).toContain("\n line 3\n");
      expect(capturedPrompt).toContain("-line 13\n");
      expect(capturedPrompt).toContain("+line 13 changed\n");
      expect(capturedPrompt).toContain("\n line 23\n");
      expect(capturedPrompt).not.toContain("\n line 2\n");
      expect(capturedPrompt).not.toContain("\n line 24\n");
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });
});

describe("commit history operations", () => {
  it("returns structured commit history and lazy commit body rows", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-history-"),
    );
    const git = createGitService({
      agents: mockAgents,
      classifyGitError: mockClassifyGitError,
    });

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

      const bodies = await git.getCommitFileBodies({
        projectPath,
        documentId: snapshot.documentId,
        commit: snapshot.commit.hash,
        parent: snapshot.selectedParent,
        context: 5,
        files: [{ path: "a.txt" }],
      });
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
    const git = createGitService({
      agents: mockAgents,
      classifyGitError: mockClassifyGitError,
    });

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
    const git = createGitService({
      agents: mockAgents,
      classifyGitError: mockClassifyGitError,
    });

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
    const git = createGitService({
      agents: mockAgents,
      classifyGitError: mockClassifyGitError,
    });

    try {
      await initRepoWithCommit(projectPath);
      await fs.writeFile(
        path.join(projectPath, "a.txt"),
        "one\ntwo\nthree\nfour\n",
        "utf-8",
      );
      await runGitCommand(projectPath, ["commit", "-am", "expand file"]);
      await runGitCommand(projectPath, ["mv", "a.txt", "renamed file.txt"]);
      await fs.appendFile(path.join(projectPath, "renamed file.txt"), "five\n", "utf-8");
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

      const renamedFile = snapshot.files.find((file) => file.path === "renamed file.txt");
      const bodies = await git.getCommitFileBodies({
        projectPath,
        documentId: snapshot.documentId,
        commit: snapshot.commit.hash,
        parent: snapshot.selectedParent,
        context: 5,
        files: [{ path: renamedFile.path, originalPath: renamedFile.originalPath }],
      });
      const addedRows = bodies.files[renamedFile.path].rows.filter((row) => row.kind === "add");

      expect(addedRows).toEqual([expect.objectContaining({ text: "five" })]);
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("loads historical bodies for paths containing pathspec metacharacters", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-history-literal-path-"),
    );
    const git = createGitService({
      agents: mockAgents,
      classifyGitError: mockClassifyGitError,
    });
    const filePath = "wild[slug].txt";

    try {
      await initRepoWithCommit(projectPath);
      await fs.writeFile(path.join(projectPath, filePath), "one\n", "utf-8");
      await runGitCommand(projectPath, ["add", filePath]);
      await runGitCommand(projectPath, ["commit", "-m", "add literal path"]);
      await fs.appendFile(path.join(projectPath, filePath), "two\n", "utf-8");
      await runGitCommand(projectPath, ["commit", "-am", "change literal path"]);

      const snapshot = await git.getCommitSnapshot({
        projectPath,
        commit: "HEAD",
        context: 5,
      });
      expect(snapshot.status).toBe("ready");

      const bodies = await git.getCommitFileBodies({
        projectPath,
        documentId: snapshot.documentId,
        commit: snapshot.commit.hash,
        parent: snapshot.selectedParent,
        context: 5,
        files: [{ path: filePath }],
      });

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
    const git = createGitService({
      agents: mockAgents,
      classifyGitError: mockClassifyGitError,
    });

    try {
      await initRepoWithCommit(projectPath);
      await fs.appendFile(path.join(projectPath, "a.txt"), "two\n", "utf-8");
      await runGitCommand(projectPath, ["commit", "-am", "change file"]);
      await runGitCommand(projectPath, ["config", "diff.external", "/bin/true"]);
      await runGitCommand(projectPath, ["config", "color.ui", "always"]);

      const snapshot = await git.getCommitSnapshot({ projectPath, commit: "HEAD" });
      expect(snapshot.status).toBe("ready");
      const bodies = await git.getCommitFileBodies({
        projectPath,
        documentId: snapshot.documentId,
        commit: snapshot.commit.hash,
        parent: snapshot.selectedParent,
        files: [{ path: "a.txt" }],
      });
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
      const comparisonBodies = await git.getComparisonFileBodies({
        projectPath,
        documentId: comparisonSnapshot.documentId,
        effectiveFromHash: comparisonSnapshot.effectiveFromHash,
        to: { kind: "revision", hash: comparisonSnapshot.to.hash },
        files: [{ path: "a.txt" }],
      });
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
    const git = createGitService({
      agents: mockAgents,
      classifyGitError: mockClassifyGitError,
    });

    try {
      await initRepoWithCommit(projectPath);
      await fs.mkdir(path.join(projectPath, "bin"));
      await fs.writeFile(path.join(projectPath, "bin", "tool"), "old\n", "utf-8");
      await runGitCommand(projectPath, ["add", "."]);
      await runGitCommand(projectPath, ["commit", "-m", "add tool file"]);
      await fs.rm(path.join(projectPath, "bin", "tool"));
      await fs.mkdir(path.join(projectPath, "bin", "tool"));
      await fs.writeFile(path.join(projectPath, "bin", "tool", "main.sh"), "new\n", "utf-8");
      await runGitCommand(projectPath, ["add", "-A"]);
      await runGitCommand(projectPath, ["commit", "-m", "replace tool with directory"]);

      const snapshot = await git.getCommitSnapshot({
        projectPath,
        commit: "HEAD",
        context: 5,
      });
      expect(snapshot.status).toBe("ready");
      const deletedFile = snapshot.files.find((file) => file.path === "bin/tool");
      expect(deletedFile).toMatchObject({ status: "deleted" });

      const bodies = await git.getCommitFileBodies({
        projectPath,
        documentId: snapshot.documentId,
        commit: snapshot.commit.hash,
        parent: snapshot.selectedParent,
        context: 5,
        files: [{ path: "bin/tool" }],
      });
      const body = bodies.files["bin/tool"];

      expect(body.rows).toContainEqual(expect.objectContaining({ kind: "del", text: "old" }));
      expect(body.rows).not.toContainEqual(expect.objectContaining({ kind: "add", text: "new" }));
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("isolates prefix-path rename bodies from changed siblings", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-history-prefix-rename-"),
    );
    const git = createGitService({
      agents: mockAgents,
      classifyGitError: mockClassifyGitError,
    });
    const content = "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n";
    const renamedContent = "one\ntwo\nthree\nfour\nCHANGED\nsix\nseven\neight\n";

    try {
      await initRepoWithCommit(projectPath);
      await fs.mkdir(path.join(projectPath, "bin"));
      await fs.writeFile(path.join(projectPath, "bin", "tool"), content, "utf-8");
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
      await runGitCommand(projectPath, ["commit", "-m", "move tool below directory"]);

      const snapshot = await git.getCommitSnapshot({
        projectPath,
        commit: "HEAD",
        context: 5,
      });
      expect(snapshot.status).toBe("ready");
      const renamedFile = snapshot.files.find((file) => file.path === "bin/tool/main.sh");
      expect(renamedFile).toMatchObject({
        status: "renamed",
        originalPath: "bin/tool",
        additions: 1,
        deletions: 1,
      });

      const bodies = await git.getCommitFileBodies({
        projectPath,
        documentId: snapshot.documentId,
        commit: snapshot.commit.hash,
        parent: snapshot.selectedParent,
        context: 5,
        files: [{ path: renamedFile.path, originalPath: renamedFile.originalPath }],
      });

      const body = bodies.files[renamedFile.path];
      expect(body.bodyState).toBe("loaded");
      expect(body.rows).toContainEqual(expect.objectContaining({ kind: "add", text: "CHANGED" }));
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
      const comparisonBodies = await git.getComparisonFileBodies({
        projectPath,
        documentId: comparisonSnapshot.documentId,
        effectiveFromHash: comparisonSnapshot.effectiveFromHash,
        to: { kind: "revision", hash: comparisonSnapshot.to.hash },
        files: [{ path: comparisonRename.path, originalPath: comparisonRename.originalPath }],
      });
      const comparisonBody = comparisonBodies.files[comparisonRename.path];
      expect(comparisonBody.bodyState).toBe("loaded");
      expect(comparisonBody.rows).toContainEqual(
        expect.objectContaining({ kind: "add", text: "CHANGED" }),
      );
      expect(comparisonBody.rows.some((row) => row.text === "sibling-alpha")).toBe(false);
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
    const git = createGitService({
      agents: mockAgents,
      classifyGitError: mockClassifyGitError,
    });

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

      await fs.appendFile(path.join(submoduleSource, "a.txt"), "two\n", "utf-8");
      await runGitCommand(submoduleSource, ["commit", "-am", "update submodule"]);
      const { stdout: submoduleHashOutput } = await runGitCommand(submoduleSource, [
        "rev-parse",
        "HEAD",
      ]);
      const submodulePath = path.join(projectPath, "vendor", "sub");
      await runGitCommand(submodulePath, [
        "-c",
        "protocol.file.allow=always",
        "fetch",
        "origin",
      ]);
      await runGitCommand(submodulePath, ["checkout", submoduleHashOutput.trim()]);
      await runGitCommand(projectPath, ["add", "vendor/sub"]);
      await runGitCommand(projectPath, ["commit", "-m", "advance submodule"]);
      await runGitCommand(projectPath, ["config", "diff.submodule", "log"]);

      const snapshot = await git.getCommitSnapshot({
        projectPath,
        commit: "HEAD",
      });
      expect(snapshot.status).toBe("ready");
      const submoduleFile = snapshot.files.find((file) => file.path === "vendor/sub");
      expect(submoduleFile).toMatchObject({ status: "modified", additions: 1, deletions: 1 });
      const bodies = await git.getCommitFileBodies({
        projectPath,
        documentId: snapshot.documentId,
        commit: snapshot.commit.hash,
        parent: snapshot.selectedParent,
        files: [{ path: "vendor/sub" }],
      });
      expect(bodies.files["vendor/sub"].bodyState).toBe("loaded");
      expect(bodies.files["vendor/sub"].rows).toContainEqual(
        expect.objectContaining({ kind: "add", text: expect.stringContaining("Subproject commit") }),
      );

      const comparisonSnapshot = await git.getComparisonSnapshot({
        projectPath,
        from: { kind: "revision", revision: "HEAD~1" },
        to: { kind: "revision", revision: "HEAD" },
        mode: "direct",
      });
      expect(comparisonSnapshot.status).toBe("ready");
      const comparisonBodies = await git.getComparisonFileBodies({
        projectPath,
        documentId: comparisonSnapshot.documentId,
        effectiveFromHash: comparisonSnapshot.effectiveFromHash,
        to: { kind: "revision", hash: comparisonSnapshot.to.hash },
        files: [{ path: "vendor/sub" }],
      });
      expect(comparisonBodies.files["vendor/sub"].bodyState).toBe("loaded");
      expect(comparisonBodies.files["vendor/sub"].rows).toContainEqual(
        expect.objectContaining({ kind: "del", text: expect.stringContaining("Subproject commit") }),
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
    const git = createGitService({
      agents: mockAgents,
      classifyGitError: mockClassifyGitError,
    });

    try {
      await initRepoWithCommit(projectPath);
      await fs.rm(path.join(projectPath, "a.txt"));
      await fs.symlink("target.txt", path.join(projectPath, "a.txt"));
      await runGitCommand(projectPath, ["add", "-A"]);
      await runGitCommand(projectPath, ["commit", "-m", "replace file with link"]);

      const snapshot = await git.getCommitSnapshot({ projectPath, commit: "HEAD" });
      expect(snapshot.status).toBe("ready");
      expect(snapshot.files.find((file) => file.path === "a.txt")).toMatchObject({
        status: "type-changed",
      });
      const bodies = await git.getCommitFileBodies({
        projectPath,
        documentId: snapshot.documentId,
        commit: snapshot.commit.hash,
        parent: snapshot.selectedParent,
        files: [{ path: "a.txt" }],
      });
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
      const comparisonBodies = await git.getComparisonFileBodies({
        projectPath,
        documentId: comparisonSnapshot.documentId,
        effectiveFromHash: comparisonSnapshot.effectiveFromHash,
        to: { kind: "revision", hash: comparisonSnapshot.to.hash },
        files: [{ path: "a.txt" }],
      });
      expect(comparisonBodies.files["a.txt"].rows).toContainEqual(
        expect.objectContaining({ kind: "add", text: "target.txt" }),
      );
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });
});

describe("comparison operations", () => {
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
    const git = createGitService({
      agents: mockAgents,
      classifyGitError: mockClassifyGitError,
    });

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
    const git = createGitService({
      agents: mockAgents,
      classifyGitError: mockClassifyGitError,
    });

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
    const git = createGitService({
      agents: mockAgents,
      classifyGitError: mockClassifyGitError,
    });

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

      const bodies = await git.getComparisonFileBodies({
        projectPath,
        documentId: snapshot.documentId,
        effectiveFromHash: snapshot.effectiveFromHash,
        to: { kind: "revision", hash: snapshot.to.hash },
        context: 5,
        files: [{ path: "a.txt" }],
      });
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
    const git = createGitService({
      agents: mockAgents,
      classifyGitError: mockClassifyGitError,
    });

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

      await fs.writeFile(path.join(projectPath, "a.txt"), "rewritten\n", "utf-8");
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
      path.join(os.tmpdir(), "garcon-git-comparison-working-tree-base-freshness-"),
    );
    const git = createGitService({
      agents: mockAgents,
      classifyGitError: mockClassifyGitError,
    });

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
    const git = createGitService({
      agents: mockAgents,
      classifyGitError: mockClassifyGitError,
    });

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
    const git = createGitService({
      agents: mockAgents,
      classifyGitError: mockClassifyGitError,
    });

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
    const git = createGitService({
      agents: mockAgents,
      classifyGitError: mockClassifyGitError,
    });

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
    const git = createGitService({
      agents: mockAgents,
      classifyGitError: mockClassifyGitError,
    });

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
    const git = createGitService({
      agents: mockAgents,
      classifyGitError: mockClassifyGitError,
    });

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
    const git = createGitService({
      agents: mockAgents,
      classifyGitError: mockClassifyGitError,
    });

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

      const bodies = await git.getComparisonFileBodies({
        projectPath,
        documentId: snapshot.documentId,
        effectiveFromHash: snapshot.effectiveFromHash,
        to: { kind: "working-tree", fingerprint: snapshot.to.fingerprint },
        files: snapshot.files.map((file) => ({
          path: file.path,
          originalPath: file.originalPath,
        })),
      });
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
      const stale = await git.getComparisonFileBodies({
        projectPath,
        documentId: snapshot.documentId,
        effectiveFromHash: snapshot.effectiveFromHash,
        to: { kind: "working-tree", fingerprint: snapshot.to.fingerprint },
        files: [{ path: "a.txt" }],
      });
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
    const git = createGitService({
      agents: mockAgents,
      classifyGitError: mockClassifyGitError,
    });

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

      const bodies = await git.getComparisonFileBodies({
        projectPath,
        documentId: snapshot.documentId,
        effectiveFromHash: snapshot.effectiveFromHash,
        to: { kind: "working-tree", fingerprint: snapshot.to.fingerprint },
        files: [{ path: "a.txt" }],
        trace,
      });

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
    const git = createGitService({
      agents: mockAgents,
      classifyGitError: mockClassifyGitError,
    });

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
      const bodies = await git.getComparisonFileBodies({
        projectPath,
        documentId: snapshot.documentId,
        effectiveFromHash: snapshot.effectiveFromHash,
        to: { kind: "working-tree", fingerprint: snapshot.to.fingerprint },
        files: [{ path: "a.txt" }],
      });

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
    const git = createGitService({
      agents: mockAgents,
      classifyGitError: mockClassifyGitError,
    });

    try {
      await initRepoWithCommit(projectPath);
      const { stdout: fromHash } = await runGitCommand(projectPath, ["rev-parse", "HEAD"]);
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

      const bodies = await git.getComparisonFileBodies({
        projectPath,
        documentId: snapshot.documentId,
        effectiveFromHash: snapshot.effectiveFromHash,
        to: { kind: "working-tree", fingerprint: snapshot.to.fingerprint },
        files: [{ path: "a.txt" }],
      });

      expect(bodies.status).toBe("ready");
      expect(bodies.files["a.txt"].rows).toContainEqual(
        expect.objectContaining({ kind: "del", text: "one" }),
      );
      expect(bodies.files["a.txt"].rows.some((row) => row.kind === "add")).toBe(false);
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("compares the empty tree to an unborn Working Tree", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-comparison-unborn-"),
    );
    const git = createGitService({
      agents: mockAgents,
      classifyGitError: mockClassifyGitError,
    });

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
    const git = createGitService({
      agents: mockAgents,
      classifyGitError: mockClassifyGitError,
    });

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
    const git = createGitService({
      agents: mockAgents,
      classifyGitError: mockClassifyGitError,
    });

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
    const git = createGitService({
      agents: mockAgents,
      classifyGitError: mockClassifyGitError,
    });

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
    const git = createGitService({
      agents: mockAgents,
      classifyGitError: mockClassifyGitError,
    });

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
});

describe("commit revert operations", () => {
  it("reverts a selected non-HEAD commit by hash", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-revert-commit-"),
    );
    const git = createGitService({
      agents: mockAgents,
      classifyGitError: mockClassifyGitError,
    });

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

describe("getTargetCandidates", () => {
  it("reports the current branch on the chat-project candidate", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-targets-"),
    );
    const git = createGitService({
      agents: mockAgents,
      classifyGitError: mockClassifyGitError,
    });

    try {
      await initRepoWithCommit(projectPath);
      await runGitCommand(projectPath, ["branch", "-M", "work"]);

      const { targets } = await git.getTargetCandidates({ projectPath });
      const chatProject = targets.find(
        (target) => target.source === "chat-project",
      );

      expect(chatProject).toBeDefined();
      expect(chatProject.isCurrent).toBe(true);
      expect(chatProject.branch).toBe("work");
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });
});

describe("worktree listing metadata", () => {
  it("reports root mtimes and keeps missing worktrees available to target discovery", async () => {
    const projectPath = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "garcon-worktree-times-")),
    );
    const linkedPath = `${projectPath}-Zed`;
    const missingPath = `${projectPath}-apple`;
    const git = createGitService({
      agents: mockAgents,
      classifyGitError: mockClassifyGitError,
    });

    try {
      await initRepoWithCommit(projectPath);
      await runGitCommand(projectPath, ["config", "core.ignorecase", "true"]);
      await runGitCommand(projectPath, [
        "worktree",
        "add",
        "-b",
        "feature",
        linkedPath,
      ]);
      await runGitCommand(projectPath, [
        "worktree",
        "add",
        "-b",
        "missing",
        missingPath,
      ]);

      const modifiedAt = new Date("2026-07-15T10:00:00.000Z");
      await fs.utimes(linkedPath, modifiedAt, modifiedAt);
      await fs.rm(missingPath, { recursive: true, force: true });

      const trace = [];
      const { worktrees } = await git.getWorktrees({ projectPath, trace });
      const gitTrace = [];
      const gitSourceOperations = createWorktreeOperations({ source: "git" });
      const gitResult = await gitSourceOperations.getWorktrees({
        projectPath,
        trace: gitTrace,
      });
      // Source parity complements the absolute assertions below and the HTTP contract test.
      expect(gitResult).toEqual({ worktrees });
      expect(worktrees.map((worktree) => worktree.path)).toEqual([
        projectPath,
        linkedPath,
        missingPath,
      ]);
      expect(
        worktrees.find((worktree) => worktree.path === projectPath),
      ).toMatchObject({
        isPathMissing: false,
        lastModifiedAt: expect.any(String),
      });
      expect(
        worktrees.find((worktree) => worktree.path === linkedPath)
          ?.lastModifiedAt,
      ).toBe(modifiedAt.toISOString());
      expect(
        worktrees.find((worktree) => worktree.path === missingPath),
      ).toMatchObject({
        isPathMissing: true,
        lastModifiedAt: null,
      });
      const automaticUsedGit = trace.some((entry) =>
        entry.args.includes("worktree"),
      );
      const { stdout: refFormat } = await runGitCommand(projectPath, [
        "rev-parse",
        "--show-ref-format",
      ]);
      expect(automaticUsedGit).toBe(refFormat.trim() !== "files");
      if (!automaticUsedGit) {
        expect(trace).toHaveLength(1);
        expect(trace[0].args).toContain("--show-ref-format");
      }
      expect(gitTrace.some((entry) => entry.args.includes("worktree"))).toBe(
        true,
      );

      await fs.rm(linkedPath, { recursive: true, force: true });
      await fs.writeFile(linkedPath, "not a directory");
      const { worktrees: worktreesWithFile } = await git.getWorktrees({
        projectPath,
      });
      expect(
        worktreesWithFile.find((worktree) => worktree.path === linkedPath),
      ).toMatchObject({
        isPathMissing: true,
        lastModifiedAt: null,
      });

      const targetTrace = [];
      const { targets } = await git.getTargetCandidates({
        projectPath,
        trace: targetTrace,
      });
      const gitSourceTargetTrace = [];
      const gitSourceTargets = await gitSourceOperations.getTargetCandidates({
        projectPath,
        trace: gitSourceTargetTrace,
      });
      expect(gitSourceTargets).toEqual({ targets });
      expect(targetTrace.some((entry) => entry.args.includes("worktree"))).toBe(
        automaticUsedGit,
      );
      expect(
        gitSourceTargetTrace.some((entry) => entry.args.includes("worktree")),
      ).toBe(true);
      expect(
        targets.find((target) => target.worktreePath === missingPath),
      ).toMatchObject({
        source: "worktree",
        isMissing: true,
      });
    } finally {
      await fs.rm(linkedPath, { recursive: true, force: true });
      await fs.rm(missingPath, { recursive: true, force: true });
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("returns null when an mtime cannot be represented as ISO-8601", () => {
    expect(serializeWorktreeMtime(new Date(Number.NaN))).toBeNull();
  });

  it("uses porcelain for a separate Git directory", async () => {
    const fixtureRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-worktree-separate-git-dir-"),
    );
    const projectPath = path.join(fixtureRoot, "project");
    const gitDir = path.join(fixtureRoot, "repository.git");
    const git = createGitService({
      agents: mockAgents,
      classifyGitError: mockClassifyGitError,
    });

    try {
      await fs.mkdir(projectPath);
      await runGitCommand(projectPath, [
        "init",
        "--separate-git-dir",
        gitDir,
      ]);
      const trace = [];
      const { worktrees } = await git.getWorktrees({ projectPath, trace });

      expect(worktrees).toHaveLength(1);
      expect(trace.some((entry) => entry.args.includes("worktree"))).toBe(true);
    } finally {
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("uses porcelain when worktree admin metadata is unreadable", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-worktree-invalid-admin-"),
    );
    const git = createGitService({
      agents: mockAgents,
      classifyGitError: mockClassifyGitError,
    });

    try {
      await initRepoWithCommit(projectPath);
      await fs.writeFile(path.join(projectPath, ".git", "worktrees"), "invalid");
      const trace = [];
      const { worktrees } = await git.getWorktrees({ projectPath, trace });

      expect(worktrees).toHaveLength(1);
      expect(trace.some((entry) => entry.args.includes("worktree"))).toBe(true);
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("uses porcelain for linked symlink-based HEAD refs", async () => {
    const projectPath = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "garcon-worktree-symlink-head-")),
    );
    const linkedPath = `${projectPath}-linked`;
    const git = createGitService({
      agents: mockAgents,
      classifyGitError: mockClassifyGitError,
    });

    try {
      await initRepoWithLinkedFeature(projectPath, linkedPath);
      const { stdout } = await runGitCommand(linkedPath, [
        "rev-parse",
        "--path-format=absolute",
        "--git-path",
        "HEAD",
      ]);
      const linkedHeadPath = stdout.trim();
      await fs.rm(linkedHeadPath);
      await fs.symlink("refs/heads/feature", linkedHeadPath);

      const trace = [];
      const { worktrees } = await git.getWorktrees({
        projectPath: linkedPath,
        trace,
      });

      expect(
        worktrees.find((worktree) => worktree.path === linkedPath),
      ).toMatchObject({ branch: "feature", name: "feature" });
      expect(trace.some((entry) => entry.args.includes("worktree"))).toBe(true);
    } finally {
      await fs.rm(linkedPath, { recursive: true, force: true });
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("uses porcelain when the main repository is configured as bare", async () => {
    const projectPath = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "garcon-worktree-bare-main-")),
    );
    const linkedPath = `${projectPath}-linked`;
    const git = createGitService({
      agents: mockAgents,
      classifyGitError: mockClassifyGitError,
    });

    try {
      await initRepoWithLinkedFeature(projectPath, linkedPath);
      await runGitCommand(projectPath, ["config", "core.bare", "true"]);

      const trace = [];
      const { worktrees } = await git.getWorktrees({
        projectPath: linkedPath,
        trace,
      });

      expect(worktrees[0]).toMatchObject({
        path: projectPath,
        branch: "",
        name: path.basename(projectPath),
      });
      expect(trace.some((entry) => entry.args.includes("worktree"))).toBe(true);
    } finally {
      await fs.rm(linkedPath, { recursive: true, force: true });
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it.skipIf(!supportsReftable)(
    "uses porcelain when Git reports a non-files ref backend",
    async () => {
      const projectPath = await fs.mkdtemp(
        path.join(os.tmpdir(), "garcon-worktree-reftable-"),
      );
      const git = createGitService({
        agents: mockAgents,
        classifyGitError: mockClassifyGitError,
      });

      try {
        await runGitCommand(projectPath, ["init", "--ref-format=reftable"]);
        await runGitCommand(projectPath, [
          "config",
          "user.email",
          "test@example.com",
        ]);
        await runGitCommand(projectPath, [
          "config",
          "user.name",
          "Test User",
        ]);
        await fs.writeFile(path.join(projectPath, "a.txt"), "one\n", "utf-8");
        await runGitCommand(projectPath, ["add", "a.txt"]);
        await runGitCommand(projectPath, ["commit", "-m", "initial"]);

        const trace = [];
        const { worktrees } = await git.getWorktrees({ projectPath, trace });

        expect(worktrees[0].branch).not.toBe(".invalid");
        expect(trace.some((entry) => entry.args.includes("worktree"))).toBe(true);
      } finally {
        await fs.rm(projectPath, { recursive: true, force: true });
      }
    },
  );
});

describe("worktree creation", () => {
  it("does not track a remote base when creating a branch", async () => {
    const projectPath = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "garcon-worktree-no-track-")),
    );
    const linkedPath = `${projectPath}-feature`;
    const git = createGitService({
      agents: mockAgents,
      classifyGitError: mockClassifyGitError,
    });

    try {
      await initRepoWithCommit(projectPath);
      await runGitCommand(projectPath, ["branch", "-M", "main"]);
      await runGitCommand(projectPath, [
        "remote",
        "add",
        "origin",
        "https://example.invalid/repository.git",
      ]);
      await runGitCommand(projectPath, [
        "update-ref",
        "refs/remotes/origin/main",
        "HEAD",
      ]);
      await runGitCommand(projectPath, [
        "config",
        "branch.autoSetupMerge",
        "always",
      ]);

      await git.createWorktree({
        projectPath,
        worktreePath: linkedPath,
        branch: "feature",
        baseRef: "origin/main",
      });

      const { stdout: upstream } = await runGitCommand(projectPath, [
        "for-each-ref",
        "--format=%(upstream)",
        "refs/heads/feature",
      ]);
      expect(upstream.trim()).toBe("");
    } finally {
      await fs.rm(linkedPath, { recursive: true, force: true });
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });
});

describe("getQuickSummary", () => {
  it("returns counts for staged, unstaged, and untracked files", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-quick-summary-"),
    );
    const git = createGitService({
      agents: mockAgents,
      classifyGitError: mockClassifyGitError,
    });

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
    const git = createGitService({
      agents: mockAgents,
      classifyGitError: mockClassifyGitError,
    });

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
    const git = createGitService({
      agents: mockAgents,
      classifyGitError: mockClassifyGitError,
    });

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
    const git = createGitService({
      agents: mockAgents,
      classifyGitError: mockClassifyGitError,
    });

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
    const git = createGitService({
      agents: mockAgents,
      classifyGitError: mockClassifyGitError,
    });

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

describe("getWorkbenchSnapshot", () => {
  it("records git command duration and byte counts when trace is provided", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-trace-"),
    );
    try {
      await runGitCommand(projectPath, ["init"]);
      const trace = [];
      await runGitTraced(
        projectPath,
        ["rev-parse", "--is-inside-work-tree"],
        trace,
      );

      expect(trace).toHaveLength(1);
      expect(trace[0]).toMatchObject({
        args: ["rev-parse", "--is-inside-work-tree"],
      });
      expect(trace[0].durationMs).toBeGreaterThanOrEqual(0);
      expect(trace[0].stdoutBytes).toBeGreaterThan(0);
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("returns tree and review summary from one loaded snapshot", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-snapshot-"),
    );
    const git = createGitService({
      agents: mockAgents,
      classifyGitError: mockClassifyGitError,
    });

    try {
      await initRepoWithCommit(projectPath);
      await fs.writeFile(
        path.join(projectPath, "a.txt"),
        "one\ntwo\n",
        "utf-8",
      );
      const trace = [];
      const snapshot = await git.getWorkbenchSnapshot({
        projectPath,
        mode: "working",
        context: 5,
        trace,
      });

      expect(snapshot.status).toBe("ready");
      expect(snapshot.tree.statsState).toBe("loaded");
      expect(trace.some((entry) => entry.args.includes("--numstat"))).toBe(
        true,
      );
      expect(snapshot.tree.root[0]).toMatchObject({
        path: "a.txt",
        additions: 1,
        deletions: 0,
      });
      expect(snapshot.reviewSummary.files[0]).toMatchObject({
        path: "a.txt",
        additions: 1,
        deletions: 0,
        bodyState: "unloaded",
      });
      expect(snapshot.selectedFile).toBe("a.txt");
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("aggregates directory stats from each changed file entry", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-tree-dir-stats-"),
    );
    const git = createGitService({
      agents: mockAgents,
      classifyGitError: mockClassifyGitError,
    });

    try {
      await initRepoWithCommit(projectPath);
      await fs.mkdir(path.join(projectPath, "src", "nested"), {
        recursive: true,
      });
      await fs.writeFile(
        path.join(projectPath, "src", "nested", "large.txt"),
        "base\n",
        "utf-8",
      );
      await fs.writeFile(
        path.join(projectPath, "src", "nested", "small.txt"),
        "base\n",
        "utf-8",
      );
      await runGitCommand(projectPath, [
        "add",
        "src/nested/large.txt",
        "src/nested/small.txt",
      ]);
      await runGitCommand(projectPath, ["commit", "-m", "add nested files"]);

      const largeLines = Array.from(
        { length: 75 },
        (_, index) => `large ${index + 1}`,
      );
      await fs.writeFile(
        path.join(projectPath, "src", "nested", "large.txt"),
        `base\n${largeLines.join("\n")}\n`,
        "utf-8",
      );
      await fs.writeFile(
        path.join(projectPath, "src", "nested", "small.txt"),
        "base\nsmall 1\n",
        "utf-8",
      );

      const snapshot = await git.getWorkbenchSnapshot({
        projectPath,
        mode: "working",
        context: 5,
      });

      expect(snapshot.status).toBe("ready");
      expect(findTreeNode(snapshot.tree.root, "src")).toMatchObject({
        additions: 76,
        deletions: 0,
      });
      expect(findTreeNode(snapshot.tree.root, "src/nested")).toMatchObject({
        additions: 76,
        deletions: 0,
      });
      expect(
        findTreeNode(snapshot.tree.root, "src/nested/large.txt"),
      ).toMatchObject({
        additions: 75,
        deletions: 0,
      });
      expect(
        findTreeNode(snapshot.tree.root, "src/nested/small.txt"),
      ).toMatchObject({
        additions: 1,
        deletions: 0,
      });
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("returns typed non-repository snapshots", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-not-repo-"),
    );
    const git = createGitService({
      agents: mockAgents,
      classifyGitError: mockClassifyGitError,
    });

    try {
      const snapshot = await git.getWorkbenchSnapshot({
        projectPath,
        mode: "working",
        context: 5,
      });

      expect(snapshot).toMatchObject({
        status: "not-git-repository",
        project: projectPath,
        target: null,
        tree: null,
        reviewSummary: null,
        selectedFile: null,
        firstBodyCandidates: [],
      });
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("loads numstat for paths containing tabs", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-tree-tab-path-"),
    );
    const git = createGitService({
      agents: mockAgents,
      classifyGitError: mockClassifyGitError,
    });
    const fileName = "a\tb.txt";

    try {
      await runGitCommand(projectPath, ["init"]);
      await runGitCommand(projectPath, [
        "config",
        "user.email",
        "test@example.com",
      ]);
      await runGitCommand(projectPath, ["config", "user.name", "Test User"]);
      await fs.writeFile(path.join(projectPath, fileName), "one\n", "utf-8");
      await runGitCommand(projectPath, ["add", fileName]);
      await runGitCommand(projectPath, ["commit", "-m", "initial"]);
      await fs.writeFile(
        path.join(projectPath, fileName),
        "one\ntwo\n",
        "utf-8",
      );

      const snapshot = await git.getWorkbenchSnapshot({
        projectPath,
        mode: "working",
        context: 5,
      });

      expect(snapshot.status).toBe("ready");
      expect(snapshot.tree.root).toHaveLength(1);
      expect(snapshot.tree.root[0]).toMatchObject({
        path: fileName,
        additions: 1,
        deletions: 0,
      });
      expect(snapshot.reviewSummary.files[0].path).toBe(fileName);
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("expands untracked directories to untracked files", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-tree-"),
    );
    const git = createGitService({
      agents: mockAgents,
      classifyGitError: mockClassifyGitError,
    });

    try {
      await runGitCommand(projectPath, ["init"]);
      await fs.mkdir(path.join(projectPath, "newdir/subdir"), {
        recursive: true,
      });
      await fs.writeFile(
        path.join(projectPath, "newdir/subdir/file.txt"),
        "hello\n",
        "utf-8",
      );

      const snapshot = await git.getWorkbenchSnapshot({
        projectPath,
        mode: "working",
        context: 5,
      });
      expect(snapshot.status).toBe("ready");
      expect(snapshot.tree.root).toMatchObject([
        {
          path: "newdir",
          name: "newdir",
          kind: "directory",
          changeKind: "untracked",
          staged: false,
          hasUnstaged: true,
          children: [
            {
              path: "newdir/subdir",
              name: "subdir",
              kind: "directory",
              changeKind: "untracked",
              staged: false,
              hasUnstaged: true,
              children: [
                {
                  path: "newdir/subdir/file.txt",
                  name: "file.txt",
                  kind: "file",
                  changeKind: "untracked",
                  staged: false,
                  hasUnstaged: true,
                  indexStatus: "?",
                  workTreeStatus: "?",
                  unstagedFacet: {
                    status: "?",
                    changeKind: "untracked",
                    stats: { additions: 0, deletions: 0 },
                  },
                  additions: 0,
                  deletions: 0,
                },
              ],
            },
          ],
        },
      ]);
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("reports separate staged and unstaged facets for the same file", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-mixed-"),
    );
    const git = createGitService({
      agents: mockAgents,
      classifyGitError: mockClassifyGitError,
    });

    try {
      await initRepoWithCommit(projectPath);
      await fs.writeFile(
        path.join(projectPath, "a.txt"),
        "one\nstaged\n",
        "utf-8",
      );
      await runGitCommand(projectPath, ["add", "a.txt"]);
      await fs.writeFile(
        path.join(projectPath, "a.txt"),
        "one\nstaged\nunstaged\n",
        "utf-8",
      );

      const snapshot = await git.getWorkbenchSnapshot({
        projectPath,
        mode: "working",
        context: 5,
      });
      expect(snapshot.status).toBe("ready");
      const file = snapshot.tree.root.find((node) => node.path === "a.txt");

      expect(file.indexStatus).toBe("M");
      expect(file.workTreeStatus).toBe("M");
      expect(file.staged).toBe(true);
      expect(file.hasUnstaged).toBe(true);
      expect(file.stagedFacet).toMatchObject({
        status: "M",
        changeKind: "modified",
      });
      expect(file.unstagedFacet).toMatchObject({
        status: "M",
        changeKind: "modified",
      });
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("keeps staged text summaries independent from later binary worktree edits", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-staged-text-worktree-binary-"),
    );
    const git = createGitService({
      agents: mockAgents,
      classifyGitError: mockClassifyGitError,
    });

    try {
      await initRepoWithCommit(projectPath);
      await fs.writeFile(
        path.join(projectPath, "a.txt"),
        "one\nstaged text\n",
        "utf-8",
      );
      await runGitCommand(projectPath, ["add", "a.txt"]);
      await fs.writeFile(
        path.join(projectPath, "a.txt"),
        Buffer.from([0, 1, 2, 3, 4, 5]),
      );

      const snapshot = await git.getWorkbenchSnapshot({
        projectPath,
        mode: "staged",
        context: 5,
      });
      expect(snapshot.status).toBe("ready");
      const summary = snapshot.reviewSummary.files.find(
        (file) => file.path === "a.txt",
      );
      expect(summary.isBinary).toBe(false);
      expect(summary.bodyState).toBe("unloaded");

      const body = (
        await git.getReviewFileBodies({
          projectPath,
          documentId: snapshot.reviewSummary.documentId,
          files: ["a.txt"],
          mode: "staged",
          context: 5,
        })
      ).files["a.txt"];
      expect(body.bodyState).toBe("loaded");
      expect(body.isBinary).toBe(false);
      expect(
        body.rows.some(
          (row) => row.kind === "add" && row.text === "staged text",
        ),
      ).toBe(true);
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("uses body-compatible fingerprints for common review states", async () => {
    const git = createGitService({
      agents: mockAgents,
      classifyGitError: mockClassifyGitError,
    });
    const cases = [
      {
        name: "modified tracked path with spaces",
        mode: "working",
        file: "a b.txt",
        mutate: async (projectPath) => {
          await fs.writeFile(
            path.join(projectPath, "a b.txt"),
            "base\n",
            "utf-8",
          );
          await runGitCommand(projectPath, ["add", "a b.txt"]);
          await runGitCommand(projectPath, ["commit", "-m", "add spaced path"]);
          await fs.writeFile(
            path.join(projectPath, "a b.txt"),
            "base\nchanged\n",
            "utf-8",
          );
        },
      },
      {
        name: "untracked file",
        mode: "working",
        file: "new file.txt",
        mutate: async (projectPath) => {
          await fs.writeFile(
            path.join(projectPath, "new file.txt"),
            "new\n",
            "utf-8",
          );
        },
      },
      {
        name: "working deletion",
        mode: "working",
        file: "a.txt",
        mutate: async (projectPath) => {
          await fs.rm(path.join(projectPath, "a.txt"));
        },
      },
      {
        name: "staged modification",
        mode: "staged",
        file: "a.txt",
        mutate: async (projectPath) => {
          await fs.writeFile(
            path.join(projectPath, "a.txt"),
            "one\nstaged\n",
            "utf-8",
          );
          await runGitCommand(projectPath, ["add", "a.txt"]);
        },
      },
      {
        name: "staged deletion",
        mode: "staged",
        file: "a.txt",
        mutate: async (projectPath) => {
          await runGitCommand(projectPath, ["rm", "a.txt"]);
        },
      },
    ];

    for (const testCase of cases) {
      const projectPath = await fs.mkdtemp(
        path.join(
          os.tmpdir(),
          `garcon-git-fingerprint-${testCase.name.replaceAll(" ", "-")}-`,
        ),
      );
      try {
        await initRepoWithCommit(projectPath);
        await testCase.mutate(projectPath);
        await expectSummaryAndBodyFingerprintsMatch(git, projectPath, {
          file: testCase.file,
          mode: testCase.mode,
        });
      } finally {
        await fs.rm(projectPath, { recursive: true, force: true });
      }
    }
  });
});

describe("getWorkingTreeFingerprint", () => {
  it("matches the ready snapshot baseline for the same workbench state", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-freshness-baseline-"),
    );
    const git = createGitService({
      agents: mockAgents,
      classifyGitError: mockClassifyGitError,
    });

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
    const git = createGitService({
      agents: mockAgents,
      classifyGitError: mockClassifyGitError,
    });

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
    const git = createGitService({
      agents: mockAgents,
      classifyGitError: mockClassifyGitError,
    });

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

describe("review document file bodies", () => {
  it("does not create a trailing context row from the terminal patch newline", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-rendered-row-"),
    );
    const git = createGitService({
      agents: mockAgents,
      classifyGitError: mockClassifyGitError,
    });

    try {
      await initRepoWithCommit(projectPath);
      await fs.writeFile(
        path.join(projectPath, "a.txt"),
        "one\ntwo\n",
        "utf-8",
      );

      const result = await git.getReviewFileBodies({
        projectPath,
        documentId: "doc",
        files: ["a.txt"],
        mode: "working",
        context: 3,
      });
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
    const git = createGitService({
      agents: mockAgents,
      classifyGitError: mockClassifyGitError,
    });

    try {
      await initRepoWithCommit(projectPath);
      await fs.writeFile(
        path.join(projectPath, "blob.bin"),
        Buffer.from([0, 1, 2, 3, 255, 0, 10]),
      );
      await runGitCommand(projectPath, ["add", "blob.bin"]);
      await runGitCommand(projectPath, ["commit", "-m", "add binary"]);
      await fs.rm(path.join(projectPath, "blob.bin"));

      const result = await git.getReviewFileBodies({
        projectPath,
        documentId: "doc",
        files: ["blob.bin"],
        mode: "working",
        context: 3,
      });
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
    const git = createGitService({
      agents: mockAgents,
      classifyGitError: mockClassifyGitError,
    });

    try {
      await initRepoWithCommit(projectPath);
      await fs.writeFile(path.join(projectPath, "a b.txt"), "old\n", "utf-8");
      await runGitCommand(projectPath, ["add", "a b.txt"]);
      await runGitCommand(projectPath, ["commit", "-m", "add spaced path"]);
      await fs.writeFile(path.join(projectPath, "a b.txt"), "new\n", "utf-8");

      const batch = await git.getReviewFileBodies({
        projectPath,
        documentId: "doc",
        files: ["a b.txt"],
        mode: "working",
        context: 3,
      });
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
    const git = createGitService({
      agents: mockAgents,
      classifyGitError: mockClassifyGitError,
    });

    try {
      await initRepoWithCommit(projectPath);
      await fs.writeFile(
        path.join(projectPath, "long.md"),
        Array.from({ length: 2_500 }, (_, index) => `line ${index + 1}`).join(
          "\n",
        ) + "\n",
        "utf-8",
      );

      const batch = await git.getReviewFileBodies({
        projectPath,
        documentId: "doc",
        files: ["long.md"],
        mode: "working",
        context: 3,
      });
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
    const git = createGitService({
      agents: mockAgents,
      classifyGitError: mockClassifyGitError,
    });

    try {
      await initRepoWithCommit(projectPath);
      await fs.writeFile(
        path.join(projectPath, "a.txt"),
        "one\nstaged\n",
        "utf-8",
      );
      await runGitCommand(projectPath, ["add", "a.txt"]);
      await fs.rm(path.join(projectPath, "a.txt"));

      const staged = (
        await git.getReviewFileBodies({
          projectPath,
          documentId: "doc",
          files: ["a.txt"],
          mode: "staged",
          context: 3,
        })
      ).files["a.txt"];
      const working = (
        await git.getReviewFileBodies({
          projectPath,
          documentId: "doc",
          files: ["a.txt"],
          mode: "working",
          context: 3,
        })
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
    const git = createGitService({
      agents: mockAgents,
      classifyGitError: mockClassifyGitError,
    });

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

      const batch = await git.getReviewFileBodies({
        projectPath,
        documentId: "doc",
        files: ["huge.md"],
        mode: "working",
        context: 3,
      });
      const review = batch.files["huge.md"];

      expect(review.bodyState).toBe("too-large");
      expect(review.limitReason).toBe("file-too-many-rows");
      expect(review.rows).toEqual([]);
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });
});

describe("git ref checkout and branch creation", () => {
  it("lists local branches by default and finds remote branches and tags by search", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-refs-"),
    );
    const git = createGitService({
      agents: mockAgents,
      classifyGitError: mockClassifyGitError,
    });

    try {
      await initRepoWithCommit(projectPath);
      await runGitCommand(projectPath, ["branch", "-M", "main"]);
      await runGitCommand(projectPath, ["tag", "v1.0.0"]);
      const { stdout: head } = await runGitCommand(projectPath, [
        "rev-parse",
        "HEAD",
      ]);
      await runGitCommand(projectPath, [
        "update-ref",
        "refs/remotes/origin/main",
        head.trim(),
      ]);
      await runGitCommand(projectPath, [
        "symbolic-ref",
        "refs/remotes/origin/HEAD",
        "refs/remotes/origin/main",
      ]);

      const { refs } = await git.getRefs({ projectPath });

      expect(refs).toContainEqual({
        name: "main",
        ref: "refs/heads/main",
        kind: "local-branch",
        updatedAt: expect.any(String),
        isCurrent: true,
      });
      expect(refs.some((ref) => ref.kind === "remote-branch")).toBe(false);
      expect(refs.some((ref) => ref.kind === "tag")).toBe(false);

      const { refs: remoteRefs } = await git.getRefs({
        projectPath,
        query: "origin/main",
      });
      expect(remoteRefs).toContainEqual({
        name: "origin/main",
        ref: "refs/remotes/origin/main",
        kind: "remote-branch",
        updatedAt: expect.any(String),
      });
      expect(remoteRefs.some((ref) => ref.name === "origin/HEAD")).toBe(false);

      const { refs: tagRefs } = await git.getRefs({
        projectPath,
        query: "v1.0.0",
      });
      expect(tagRefs).toContainEqual({
        name: "v1.0.0",
        ref: "refs/tags/v1.0.0",
        kind: "tag",
        updatedAt: expect.any(String),
      });
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("returns bounded ref search results", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-ref-search-"),
    );
    const git = createGitService({
      agents: mockAgents,
      classifyGitError: mockClassifyGitError,
    });

    try {
      await initRepoWithCommit(projectPath);
      await runGitCommand(projectPath, ["branch", "-M", "main"]);
      const { stdout: head } = await runGitCommand(projectPath, [
        "rev-parse",
        "HEAD",
      ]);
      await runGitCommand(projectPath, [
        "update-ref",
        "refs/remotes/origin/main",
        head.trim(),
      ]);
      await runGitCommand(projectPath, [
        "update-ref",
        "refs/remotes/upstream/main",
        head.trim(),
      ]);

      const { refs } = await git.getRefs({
        projectPath,
        query: "main",
        limit: 1,
      });

      expect(refs).toHaveLength(1);
      expect(refs[0].name).toContain("main");
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("sorts before limiting and reports branch and tag creator timestamps", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-ref-sorting-"),
    );
    const git = createGitService({
      agents: mockAgents,
      classifyGitError: mockClassifyGitError,
    });
    const oldTimestamp = "2024-01-01T00:00:00Z";
    const newTimestamp = "2024-03-01T00:00:00Z";
    const tagTimestamp = "2024-04-01T00:00:00Z";

    try {
      await runGitCommand(projectPath, ["init"]);
      await runGitCommand(projectPath, [
        "config",
        "user.email",
        "test@example.com",
      ]);
      await runGitCommand(projectPath, ["config", "user.name", "Test User"]);
      const oldHash = await commitFileAt(
        projectPath,
        "dated.txt",
        "old\n",
        "old",
        oldTimestamp,
      );
      await runGitCommand(projectPath, ["branch", "-M", "main"]);
      await runGitCommand(projectPath, ["branch", "candidate-old", oldHash]);
      const newHash = await commitFileAt(
        projectPath,
        "dated.txt",
        "new\n",
        "new",
        newTimestamp,
      );
      await runGitCommand(projectPath, ["branch", "candidate-new", newHash]);
      await runGitCommand(projectPath, ["branch", "tie-b", newHash]);
      await runGitCommand(projectPath, ["branch", "tie-a", newHash]);
      await runGitCommand(projectPath, [
        "update-ref",
        "refs/remotes/origin/candidate-new",
        newHash,
      ]);
      await runGitCommand(projectPath, ["tag", "release-light", oldHash]);
      await runGitCommand(
        projectPath,
        ["tag", "-a", "release-annotated", oldHash, "-m", "release"],
        {
          env: {
            GIT_AUTHOR_DATE: tagTimestamp,
            GIT_COMMITTER_DATE: tagTimestamp,
          },
        },
      );
      await fs.writeFile(path.join(projectPath, "artifact.bin"), "artifact\n");
      const { stdout: blobHash } = await runGitCommand(projectPath, [
        "hash-object",
        "-w",
        "artifact.bin",
      ]);
      await runGitCommand(projectPath, [
        "update-ref",
        "refs/tags/artifact-blob",
        blobHash.trim(),
      ]);
      await runGitCommand(projectPath, [
        "update-ref",
        "refs/tags/artifact-commit",
        oldHash,
      ]);

      const defaultName = await git.getRefs({
        projectPath,
        query: "candidate",
      });
      expect(
        defaultName.refs
          .filter((ref) => ref.kind === "local-branch")
          .map((ref) => ref.name),
      ).toEqual(["candidate-new", "candidate-old"]);

      const descendingName = await git.getRefs({
        projectPath,
        query: "candidate",
        sort: { key: "name", direction: "desc" },
      });
      expect(
        descendingName.refs
          .filter((ref) => ref.kind === "local-branch")
          .map((ref) => ref.name),
      ).toEqual(["candidate-old", "candidate-new"]);

      const newest = await git.getRefs({
        projectPath,
        query: "candidate",
        limit: 1,
        sort: { key: "updated", direction: "desc" },
      });
      expect(newest.refs).toMatchObject([
        {
          name: "candidate-new",
          updatedAt: "2024-03-01T00:00:00.000Z",
        },
      ]);

      const oldestFirst = await git.getRefs({
        projectPath,
        query: "candidate",
        sort: { key: "updated", direction: "asc" },
      });
      const oldestLocalBranches = oldestFirst.refs.filter(
        (ref) => ref.kind === "local-branch",
      );
      expect(oldestLocalBranches.map((ref) => ref.name)).toEqual([
        "candidate-old",
        "candidate-new",
      ]);
      expect(oldestLocalBranches.map((ref) => ref.updatedAt)).toEqual([
        "2024-01-01T00:00:00.000Z",
        "2024-03-01T00:00:00.000Z",
      ]);

      const tied = await git.getRefs({
        projectPath,
        query: "tie",
        sort: { key: "updated", direction: "desc" },
      });
      expect(tied.refs.map((ref) => ref.name)).toEqual(["tie-a", "tie-b"]);

      const remote = await git.getRefs({
        projectPath,
        query: "origin/candidate-new",
        sort: { key: "updated", direction: "desc" },
      });
      expect(remote.refs).toMatchObject([
        {
          kind: "remote-branch",
          updatedAt: "2024-03-01T00:00:00.000Z",
        },
      ]);

      const tags = await git.getRefs({
        projectPath,
        query: "release",
        sort: { key: "updated", direction: "desc" },
      });
      expect(
        tags.refs.map(({ name, updatedAt }) => ({ name, updatedAt })),
      ).toEqual([
        {
          name: "release-annotated",
          updatedAt: "2024-04-01T00:00:00.000Z",
        },
        {
          name: "release-light",
          updatedAt: "2024-01-01T00:00:00.000Z",
        },
      ]);

      const artifactsAscending = await git.getRefs({
        projectPath,
        query: "artifact",
        sort: { key: "updated", direction: "asc" },
      });
      expect(
        artifactsAscending.refs.map(({ name, updatedAt }) => ({
          name,
          updatedAt,
        })),
      ).toEqual([
        { name: "artifact-blob", updatedAt: null },
        {
          name: "artifact-commit",
          updatedAt: "2024-01-01T00:00:00.000Z",
        },
      ]);
      const artifactsDescending = await git.getRefs({
        projectPath,
        query: "artifact",
        sort: { key: "updated", direction: "desc" },
      });
      expect(artifactsDescending.refs.map((ref) => ref.name)).toEqual([
        "artifact-commit",
        "artifact-blob",
      ]);
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("returns refs without a HEAD identity in an unborn repository", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-ref-unborn-"),
    );
    const git = createGitService({
      agents: mockAgents,
      classifyGitError: mockClassifyGitError,
    });

    try {
      await runGitCommand(projectPath, ["init"]);
      await fs.writeFile(path.join(projectPath, "artifact.bin"), "artifact\n");
      const { stdout: blobHash } = await runGitCommand(projectPath, [
        "hash-object",
        "-w",
        "artifact.bin",
      ]);
      await runGitCommand(projectPath, [
        "update-ref",
        "refs/tags/artifact",
        blobHash.trim(),
      ]);

      const { refs } = await git.getRefs({ projectPath, query: "artifact" });

      expect(refs).toEqual([
        {
          name: "artifact",
          ref: "refs/tags/artifact",
          kind: "tag",
          updatedAt: null,
        },
      ]);
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("marks matching refs as current while HEAD is detached", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-ref-detached-"),
    );
    const git = createGitService({
      agents: mockAgents,
      classifyGitError: mockClassifyGitError,
    });

    try {
      await initRepoWithCommit(projectPath);
      await runGitCommand(projectPath, ["branch", "-M", "main"]);
      const { stdout: head } = await runGitCommand(projectPath, [
        "rev-parse",
        "HEAD",
      ]);
      await runGitCommand(projectPath, ["branch", "shared", head.trim()]);
      await runGitCommand(projectPath, ["tag", "shared", head.trim()]);
      await runGitCommand(projectPath, [
        "update-ref",
        "refs/remotes/origin/shared",
        head.trim(),
      ]);
      await runGitCommand(projectPath, ["checkout", "--detach", head.trim()]);

      const { refs } = await git.getRefs({ projectPath, query: "shared" });

      expect(refs).toHaveLength(3);
      expect(refs.map((ref) => ref.kind).sort()).toEqual([
        "local-branch",
        "remote-branch",
        "tag",
      ]);
      expect(
        refs.find((ref) => ref.kind === "local-branch")?.isCurrent,
      ).toBeUndefined();
      expect(refs.find((ref) => ref.kind === "remote-branch")?.isCurrent).toBe(
        true,
      );
      expect(refs.find((ref) => ref.kind === "tag")?.isCurrent).toBe(true);
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("preserves repository validation errors while ref operations run concurrently", async () => {
    const fixtureRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-ref-validation-"),
    );
    const nonRepositoryPath = path.join(fixtureRoot, "non-repository");
    const repositoryPath = path.join(fixtureRoot, "repository");
    const missingPath = path.join(fixtureRoot, "missing");
    const notRepositoryMessage =
      'Git is not initialized in this directory. Initialize a repository with "git init" before using source control actions.';
    const git = createGitService({
      agents: mockAgents,
      classifyGitError: mockClassifyGitError,
    });

    try {
      await fs.mkdir(nonRepositoryPath);
      await fs.mkdir(repositoryPath);
      await initRepoWithCommit(repositoryPath);

      await expect(
        git.getRefs({ projectPath: nonRepositoryPath }),
      ).rejects.toThrow(notRepositoryMessage);
      await expect(
        git.getRefs({ projectPath: nonRepositoryPath, query: "invalid query" }),
      ).rejects.toThrow(notRepositoryMessage);
      await expect(git.getRefs({ projectPath: missingPath })).rejects.toThrow(
        `Unable to access project directory: ${missingPath}`,
      );
      await expect(
        git.getRefs({ projectPath: path.join(repositoryPath, ".git") }),
      ).rejects.toThrow(
        "The target path exists but is not inside a Git working tree.",
      );
    } finally {
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("rejects cleanly when concurrent ref operations are aborted", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-ref-abort-"),
    );
    const git = createGitService({
      agents: mockAgents,
      classifyGitError: mockClassifyGitError,
    });

    try {
      await initRepoWithCommit(projectPath);
      const controller = new AbortController();
      const request = git.getRefs({ projectPath, signal: controller.signal });
      controller.abort();

      await expect(request).rejects.toThrow();
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("streams default branch order and retains explicit sort paths", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-ref-commands-"),
    );
    const git = createGitService({
      agents: mockAgents,
      classifyGitError: mockClassifyGitError,
    });

    try {
      await initRepoWithCommit(projectPath);
      await runGitCommand(projectPath, ["branch", "-M", "main"]);
      for (const branch of [
        "zeta",
        "alpha/x-y",
        "alpha/x",
        "alpha.x",
        "alpha-x",
      ]) {
        await runGitCommand(projectPath, ["branch", branch]);
      }
      await runGitCommand(projectPath, ["pack-refs", "--all"]);
      await runGitCommand(projectPath, ["branch", "alpha-w"]);
      await runGitCommand(projectPath, ["branch", "alpha/x-w"]);

      async function runCapturedRefQuery(options) {
        const commands = [];
        const originalSpawn = Bun.spawn;
        Bun.spawn = (command, spawnOptions) => {
          if (command[0] === "git") commands.push(command.slice(1));
          return originalSpawn(command, spawnOptions);
        };
        try {
          const { refs } = await git.getRefs({ projectPath, ...options });
          const refCommand = commands.find(
            ([name]) => name === "for-each-ref",
          );
          return { commands, refCommand, refs };
        } finally {
          Bun.spawn = originalSpawn;
        }
      }

      const defaultQuery = await runCapturedRefQuery({ limit: 4 });
      expect(defaultQuery.commands).toHaveLength(3);
      expect(defaultQuery.commands).toContainEqual([
        "rev-parse",
        "--is-inside-work-tree",
      ]);
      expect(defaultQuery.commands).toContainEqual([
        "rev-parse",
        "HEAD",
        "--symbolic-full-name",
        "HEAD",
      ]);
      expect(
        defaultQuery.refCommand?.some((argument) =>
          argument.startsWith("--sort="),
        ),
      ).toBe(false);
      expect(defaultQuery.refs.map((ref) => ref.name)).toEqual([
        "alpha-w",
        "alpha-x",
        "alpha.x",
        "alpha/x",
      ]);

      const searchedQuery = await runCapturedRefQuery({ query: "alpha/" });
      expect(searchedQuery.commands).toHaveLength(3);
      expect(searchedQuery.refCommand).toContain("--sort=refname");
      expect(searchedQuery.refCommand).toContain("--sort=refname:lstrip=2");
      expect(searchedQuery.refs.map((ref) => ref.name)).toEqual([
        "alpha/x",
        "alpha/x-w",
        "alpha/x-y",
      ]);

      const descendingQuery = await runCapturedRefQuery({
        limit: 4,
        sort: { key: "name", direction: "desc" },
      });
      expect(descendingQuery.commands).toHaveLength(3);
      expect(descendingQuery.refCommand).toContain("--sort=refname");
      expect(descendingQuery.refCommand).toContain(
        "--sort=-refname:lstrip=2",
      );
      expect(descendingQuery.refs.map((ref) => ref.name)).toEqual([
        "zeta",
        "main",
        "alpha/x-y",
        "alpha/x-w",
      ]);

      const updatedQuery = await runCapturedRefQuery({
        sort: { key: "updated", direction: "desc" },
      });
      expect(updatedQuery.commands).toHaveLength(3);
      expect(updatedQuery.refCommand).toContain("--sort=refname");
      expect(updatedQuery.refCommand).toContain("--sort=-creatordate");
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("keeps local branch checkout attached", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-local-checkout-"),
    );
    const git = createGitService({
      agents: mockAgents,
      classifyGitError: mockClassifyGitError,
    });

    try {
      await initRepoWithCommit(projectPath);
      await runGitCommand(projectPath, ["branch", "-M", "main"]);
      await runGitCommand(projectPath, ["checkout", "-b", "feature"]);
      await runGitCommand(projectPath, ["checkout", "main"]);

      await git.checkout({ projectPath, ref: "refs/heads/feature" });
      const { stdout } = await runGitCommand(projectPath, [
        "branch",
        "--show-current",
      ]);

      expect(stdout.trim()).toBe("feature");
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("checks out remote refs without creating a local branch", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-remote-checkout-"),
    );
    const git = createGitService({
      agents: mockAgents,
      classifyGitError: mockClassifyGitError,
    });

    try {
      await initRepoWithCommit(projectPath);
      await runGitCommand(projectPath, ["branch", "-M", "main"]);
      const { stdout: head } = await runGitCommand(projectPath, [
        "rev-parse",
        "HEAD",
      ]);
      await runGitCommand(projectPath, [
        "update-ref",
        "refs/remotes/origin/main",
        head.trim(),
      ]);

      await git.checkout({ projectPath, ref: "refs/remotes/origin/main" });
      const { stdout: branch } = await runGitCommand(projectPath, [
        "branch",
        "--show-current",
      ]);
      const { stdout: localMain } = await runGitCommand(projectPath, [
        "rev-parse",
        "--verify",
        "refs/heads/main",
      ]);

      expect(branch.trim()).toBe("");
      expect(localMain.trim()).toBe(head.trim());
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("uses the selected ref kind when a tag collides with a local branch name", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-tag-collision-"),
    );
    const git = createGitService({
      agents: mockAgents,
      classifyGitError: mockClassifyGitError,
    });

    try {
      await initRepoWithCommit(projectPath);
      await runGitCommand(projectPath, ["branch", "-M", "main"]);
      await runGitCommand(projectPath, ["branch", "release"]);
      const { stdout: branchCommit } = await runGitCommand(projectPath, [
        "rev-parse",
        "refs/heads/release",
      ]);
      await fs.writeFile(
        path.join(projectPath, "a.txt"),
        "one\ntwo\n",
        "utf-8",
      );
      await runGitCommand(projectPath, ["commit", "-am", "tag target"]);
      await runGitCommand(projectPath, ["tag", "release"]);
      const { stdout: tagCommit } = await runGitCommand(projectPath, [
        "rev-parse",
        "refs/tags/release",
      ]);

      await git.checkout({
        projectPath,
        ref: "refs/tags/release",
        refKind: "tag",
      });
      const { stdout: branch } = await runGitCommand(projectPath, [
        "branch",
        "--show-current",
      ]);
      const { stdout: head } = await runGitCommand(projectPath, [
        "rev-parse",
        "HEAD",
      ]);

      expect(branch.trim()).toBe("");
      expect(head.trim()).toBe(tagCommit.trim());
      expect(head.trim()).not.toBe(branchCommit.trim());
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("creates a branch from a selected base ref", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-branch-base-"),
    );
    const git = createGitService({
      agents: mockAgents,
      classifyGitError: mockClassifyGitError,
    });

    try {
      await initRepoWithCommit(projectPath);
      await runGitCommand(projectPath, ["branch", "-M", "main"]);
      await runGitCommand(projectPath, ["checkout", "-b", "remote-source"]);
      await fs.writeFile(
        path.join(projectPath, "a.txt"),
        "one\ntwo\n",
        "utf-8",
      );
      await runGitCommand(projectPath, ["commit", "-am", "remote edit"]);
      const { stdout: remoteCommit } = await runGitCommand(projectPath, [
        "rev-parse",
        "HEAD",
      ]);
      await runGitCommand(projectPath, [
        "update-ref",
        "refs/remotes/origin/main",
        remoteCommit.trim(),
      ]);
      await runGitCommand(projectPath, ["checkout", "main"]);

      await git.createBranch({
        projectPath,
        branch: "feature/from-origin",
        baseRef: "refs/remotes/origin/main",
      });
      const { stdout: branch } = await runGitCommand(projectPath, [
        "branch",
        "--show-current",
      ]);
      const { stdout: head } = await runGitCommand(projectPath, [
        "rev-parse",
        "HEAD",
      ]);

      expect(branch.trim()).toBe("feature/from-origin");
      expect(head.trim()).toBe(remoteCommit.trim());
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });
});

describe("porcelain ref validation", () => {
  it("rejects option-like checkout refs", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-ref-checkout-"),
    );
    const git = createGitService({
      agents: mockAgents,
      classifyGitError: mockClassifyGitError,
    });

    try {
      await initRepoWithCommit(projectPath);

      await expect(
        git.checkout({ projectPath, ref: "-HEAD" }),
      ).rejects.toMatchObject({
        code: "INVALID_INPUT",
        message: "Invalid checkout ref.",
      });
      await expect(
        git.checkout({ projectPath, ref: "." }),
      ).rejects.toMatchObject({
        code: "INVALID_INPUT",
        message: "Invalid checkout ref.",
      });
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("rejects invalid branch creation names and base refs", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-ref-create-"),
    );
    const git = createGitService({
      agents: mockAgents,
      classifyGitError: mockClassifyGitError,
    });

    try {
      await initRepoWithCommit(projectPath);

      await expect(
        git.createBranch({ projectPath, branch: "-bad" }),
      ).rejects.toMatchObject({
        code: "INVALID_INPUT",
        message: "Invalid branch name.",
      });
      await expect(
        git.createBranch({ projectPath, branch: "." }),
      ).rejects.toMatchObject({
        code: "INVALID_INPUT",
        message: "Invalid branch name.",
      });
      await expect(
        git.createBranch({
          projectPath,
          branch: "feature/good",
          baseRef: "missing-ref",
        }),
      ).rejects.toMatchObject({
        code: "INVALID_INPUT",
        message: "Invalid base ref.",
      });
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("rejects invalid worktree branch names and base refs", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-ref-worktree-"),
    );
    const git = createGitService({
      agents: mockAgents,
      classifyGitError: mockClassifyGitError,
    });

    try {
      await initRepoWithCommit(projectPath);

      await expect(
        git.createWorktree({
          projectPath,
          worktreePath: path.join(os.tmpdir(), "garcon-worktree-bad-branch"),
          branch: "--bad",
        }),
      ).rejects.toMatchObject({
        code: "INVALID_INPUT",
        message: "Invalid branch name.",
      });
      await expect(
        git.createWorktree({
          projectPath,
          worktreePath: path.join(os.tmpdir(), "garcon-worktree-bad-base"),
          branch: "feature/good",
          baseRef: "-x",
        }),
      ).rejects.toMatchObject({
        code: "INVALID_INPUT",
        message: "Invalid base ref.",
      });
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("rejects invalid push remotes and remote branches", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-ref-push-"),
    );
    const git = createGitService({
      agents: mockAgents,
      classifyGitError: mockClassifyGitError,
    });

    try {
      await initRepoWithCommit(projectPath);

      await expect(
        git.push({ projectPath, remote: "--force" }),
      ).rejects.toMatchObject({
        code: "INVALID_INPUT",
        message: "Invalid remote.",
      });
      await expect(
        git.push({ projectPath, remoteBranch: "-x" }),
      ).rejects.toMatchObject({
        code: "INVALID_INPUT",
        message: "Invalid remote branch name.",
      });
      await runGitCommand(projectPath, ["branch", "-M", "feature"]);
      await expect(
        git.push({ projectPath, remoteBranch: "main" }),
      ).rejects.toMatchObject({
        code: "INVALID_INPUT",
        message: "Remote branch must match the current local branch.",
      });
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("rejects option-like blame refs", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-ref-blame-"),
    );
    const git = createGitService({
      agents: mockAgents,
      classifyGitError: mockClassifyGitError,
    });

    try {
      await initRepoWithCommit(projectPath);

      await expect(
        git.getBlame({ projectPath, file: "a.txt", ref: "-HEAD" }),
      ).rejects.toMatchObject({
        code: "INVALID_INPUT",
        message: "Invalid blame ref.",
      });
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("reports a missing comparison endpoint without running a diff", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-ref-compare-"),
    );
    const git = createGitService({
      agents: mockAgents,
      classifyGitError: mockClassifyGitError,
    });

    try {
      await initRepoWithCommit(projectPath);

      const comparison = await git.getComparisonSnapshot({
        projectPath,
        from: { kind: "revision", revision: "missing-ref" },
        to: { kind: "revision", revision: "HEAD" },
        mode: "direct",
      });
      expect(comparison).toMatchObject({
        status: "not-found",
        endpoint: "from",
        revision: "missing-ref",
      });
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });
});

describe("porcelain conflict and comparison robustness", () => {
  it("returns bounded conflict details for large conflicted files", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-conflict-limit-"),
    );
    const git = createGitService({
      agents: mockAgents,
      classifyGitError: mockClassifyGitError,
    });

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

  it("parses compare output for paths containing tabs", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "garcon-git-compare-z-"),
    );
    const git = createGitService({
      agents: mockAgents,
      classifyGitError: mockClassifyGitError,
    });
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

      const bodies = await git.getComparisonFileBodies({
        projectPath,
        documentId: compare.documentId,
        effectiveFromHash: compare.effectiveFromHash,
        to: { kind: "revision", hash: compare.to.hash },
        files: [{ path: renamedPath, originalPath: tabbedPath }],
      });
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

describe("toHttpError", () => {
  const git = createGitService({
    agents: mockAgents,
    classifyGitError: mockClassifyGitError,
  });

  it("maps INVALID_INPUT GitDomainError to 400", async () => {
    const err = new GitDomainError("INVALID_INPUT", "Missing field");
    const response = git.toHttpError(err);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("Missing field");
  });

  it("maps NOT_REPO GitDomainError to 400", async () => {
    const err = new GitDomainError("NOT_REPO", "Not a repo");
    const response = git.toHttpError(err);
    expect(response.status).toBe(400);
  });

  it("maps AUTH_FAILED GitDomainError to 401", async () => {
    const err = new GitDomainError("AUTH_FAILED", "Auth failed");
    const response = git.toHttpError(err);
    expect(response.status).toBe(401);
  });

  it("maps SERVICE_BUSY GitDomainError to a retryable 503", async () => {
    const err = new GitDomainError("SERVICE_BUSY", "Try again shortly");
    const response = git.toHttpError(err);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "Try again shortly",
      errorCode: "SERVICE_BUSY",
      retryable: true,
    });
  });

  it("maps unknown GitDomainError codes to 500", async () => {
    const err = new GitDomainError("SOME_OTHER", "Other error");
    const response = git.toHttpError(err);
    expect(response.status).toBe(500);
  });

  it("maps commit message timeout domain code to 504 + typed errorCode", async () => {
    const err = new GitDomainError("COMMIT_MESSAGE_TIMEOUT", "Timed out");
    const response = git.toHttpError(err);
    expect(response.status).toBe(504);
    const body = await response.json();
    expect(body.error).toBe("Timed out");
    expect(body.errorCode).toBe("commit_message_timeout");
  });

  it("delegates non-GitDomainError to classifier", async () => {
    const err = new Error("random failure");
    const response = git.toHttpError(err);
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toBe("random failure");
  });

  it("includes details from classifier when available", async () => {
    const err = new Error("Could not resolve hostname github.com");
    const response = git.toHttpError(err);
    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body.error).toBe("Could not reach the remote host.");
    expect(body.details).toBe("Verify network access.");
  });
});
