import path from "path";
import { promises as fs } from "fs";
import type {
  CreateWorktreeOptions,
  ProjectOptions,
  RemoveWorktreeOptions,
  RepoInfo,
  TargetCandidate,
  WorktreeInfo,
} from "./types.js";
import {
  assertGitRepository,
  readOnlyGitOptions,
  runGit,
  runGitTraced,
} from "./run.js";
import {
  assertExistingCommitRef,
  assertSafeBranchName,
} from "./ref-validation.js";
import { mapWithConcurrency } from "../lib/concurrency.js";
import { createLogger } from "../lib/log.js";
import { probeWorktreeLayout } from "./worktree-layout.js";
import { readAdminWorktreeRecords } from "./worktree-admin.js";
import { readPorcelainWorktreeRecords } from "./worktree-porcelain.js";
import {
  compareWorktreePaths,
  type WorktreeRecord,
} from "./worktree-record.js";

const WORKTREE_STAT_CONCURRENCY = 32;
const logger = createLogger("git:worktrees");

interface WorktreeOperationOptions {
  // Forces the Git-backed source for differential parity tests.
  source?: "auto" | "git";
}

export function serializeWorktreeMtime(mtime: Date): string | null {
  return Number.isFinite(mtime.getTime()) ? mtime.toISOString() : null;
}

async function enrichWorktreeMetadata(worktree: WorktreeInfo): Promise<void> {
  try {
    const stats = await fs.stat(worktree.path);
    if (!stats.isDirectory()) {
      worktree.isPathMissing = true;
      worktree.lastModifiedAt = null;
      return;
    }
    worktree.lastModifiedAt = serializeWorktreeMtime(stats.mtime);
  } catch {
    worktree.isPathMissing = true;
    worktree.lastModifiedAt = null;
  }
}

function normalizeWorktreeRecords(
  records: readonly WorktreeRecord[],
  projectPath: string,
): WorktreeInfo[] {
  const resolvedProject = path.resolve(projectPath);
  // Garcon owns byte ordering so both sources agree regardless of core.ignorecase.
  const orderedRecords = records.length < 2
    ? records
    : [records[0], ...records.slice(1).sort(compareWorktreePaths)];
  return orderedRecords.map((record, index) => ({
    path: record.path,
    branch: record.branch,
    name: record.name || path.basename(record.path),
    isCurrent: path.resolve(record.path) === resolvedProject,
    isMain: index === 0 || record.isMain,
    isPathMissing: false,
    lastModifiedAt: null,
  }));
}

async function collectWorktrees(
  { projectPath, trace }: ProjectOptions,
  source: "auto" | "git",
): Promise<{
  currentWorktreePath: string;
  worktrees: WorktreeInfo[];
}> {
  const layout = source === "auto"
    ? await probeWorktreeLayout(projectPath, trace)
    : null;
  let currentWorktreePath: string;
  let records: WorktreeRecord[] | null = null;

  if (layout) {
    currentWorktreePath = layout.worktreeRoot;
    if (layout.refFormat === "files") {
      try {
        records = await readAdminWorktreeRecords(layout);
      } catch (error) {
        logger.debug("Direct worktree metadata read failed; using Git.", error);
      }
    }
  } else {
    await assertGitRepository(projectPath);
    const { stdout } = await runGitTraced(
      projectPath,
      ["rev-parse", "--show-toplevel"],
      trace,
      readOnlyGitOptions(),
    );
    currentWorktreePath = stdout.trim();
  }

  records ??= await readPorcelainWorktreeRecords(projectPath, trace);
  const worktrees = normalizeWorktreeRecords(records, projectPath);
  await mapWithConcurrency(
    worktrees,
    WORKTREE_STAT_CONCURRENCY,
    enrichWorktreeMetadata,
  );

  return { currentWorktreePath, worktrees };
}

export function createWorktreeOperations(
  { source = "auto" }: WorktreeOperationOptions = {},
) {
  // Lightweight git capability probe. Reports whether a path is inside a
  // git repository and, if so, the repository root and current worktree path.
  async function getRepoInfo({
    projectPath,
  }: ProjectOptions): Promise<RepoInfo> {
    try {
      await fs.access(projectPath);
    } catch {
      return { isGitRepository: false };
    }

    try {
      const { stdout: topLevelOut } = await runGit(
        projectPath,
        ["rev-parse", "--show-toplevel"],
        readOnlyGitOptions(),
      );
      const repoRoot = topLevelOut.trim();

      // --show-toplevel gives the worktree root, which equals projectPath
      // when the user points at a worktree directory directly.
      return {
        isGitRepository: true,
        repoRoot,
        currentWorktreePath: repoRoot,
      };
    } catch {
      return { isGitRepository: false };
    }
  }

  async function getWorktrees({
    projectPath,
    trace,
  }: ProjectOptions): Promise<{ worktrees: WorktreeInfo[] }> {
    const { worktrees } = await collectWorktrees({ projectPath, trace }, source);
    return { worktrees };
  }

  async function getTargetCandidates({
    projectPath,
    trace,
  }: ProjectOptions): Promise<{ targets: TargetCandidate[] }> {
    const { currentWorktreePath, worktrees } = await collectWorktrees(
      { projectPath, trace },
      source,
    );
    const targets: TargetCandidate[] = [];
    const seen = new Set<string>();
    const repoRoot = currentWorktreePath || projectPath;

    function addTarget(target: TargetCandidate): void {
      if (!target.worktreePath || seen.has(target.worktreePath)) return;
      seen.add(target.worktreePath);
      targets.push(target);
    }

    // The chat-project target shares the current worktree's path, so the
    // dedup below drops the matching worktree entry. Carry its branch onto
    // the chat-project candidate so the toolbar shows the branch on first
    // paint without a separate status request.
    const chatProjectWorktreePath = repoRoot;
    const resolvedChatProjectWorktreePath = path.resolve(
      chatProjectWorktreePath,
    );
    const currentWorktree =
      worktrees.find((worktree) => worktree.isCurrent) ??
      worktrees.find((worktree) =>
        path.resolve(worktree.path) === resolvedChatProjectWorktreePath
      );

    addTarget({
      projectPath,
      repoRoot,
      worktreePath: chatProjectWorktreePath,
      label: path.basename(projectPath) || projectPath,
      branch: currentWorktree?.branch ?? "",
      source: "chat-project",
      isCurrent: true,
      isMissing: false,
    });

    for (const worktree of worktrees) {
      const name = worktree.name || path.basename(worktree.path);
      const branchLabel = worktree.branch ? ` (${worktree.branch})` : "";
      addTarget({
        projectPath: worktree.path,
        repoRoot,
        worktreePath: worktree.path,
        label: `${name}${branchLabel}`,
        branch: worktree.branch,
        source: "worktree",
        isCurrent: worktree.isCurrent,
        isMissing: worktree.isPathMissing,
      });
    }

    return { targets };
  }

  async function createWorktree({
    projectPath,
    baseRef,
    worktreePath,
    branch,
    detach,
  }: CreateWorktreeOptions): Promise<unknown> {
    await assertGitRepository(projectPath);
    if (baseRef) await assertExistingCommitRef(projectPath, baseRef, "base");
    if (branch) await assertSafeBranchName(projectPath, branch, "branch name");

    const args: string[] = ["worktree", "add"];
    if (detach) {
      args.push("--detach", worktreePath);
      if (baseRef) args.push(baseRef);
    } else if (branch) {
      // Check if the branch already exists to avoid `-b` failure.
      const branchExists = await runGit(
        projectPath,
        ["rev-parse", "--verify", `refs/heads/${branch}`],
        readOnlyGitOptions(),
      )
        .then(() => true)
        .catch(() => false);
      if (branchExists) {
        // Checkout existing branch into the new worktree path.
        args.push(worktreePath, branch);
      } else {
        args.push("--no-track", "-b", branch, worktreePath);
        if (baseRef) args.push(baseRef);
      }
    } else {
      args.push(worktreePath);
      if (baseRef) args.push(baseRef);
    }

    const { stdout } = await runGit(projectPath, args);
    const resolvedPath = path.resolve(projectPath, worktreePath);
    return {
      success: true,
      output: stdout || "Worktree created",
      worktreePath: resolvedPath,
    };
  }

  async function removeWorktree({
    projectPath,
    worktreePath,
    force,
  }: RemoveWorktreeOptions): Promise<unknown> {
    await assertGitRepository(projectPath);

    const args: string[] = ["worktree", "remove"];
    if (force) args.push("--force");
    args.push(worktreePath);

    const { stdout } = await runGit(projectPath, args);
    return { success: true, output: stdout || "Worktree removed" };
  }

  return {
    getRepoInfo,
    getWorktrees,
    getTargetCandidates,
    createWorktree,
    removeWorktree,
  };
}
