import path from "node:path";
import type { GitCommandTrace, GitProcessError } from "./types.js";
import { readOnlyGitOptions, runGitTraced } from "./run.js";
import type { WorktreeRecord } from "./worktree-record.js";

function supportsLegacyPorcelainRetry(error: unknown): boolean {
  const processError = error as GitProcessError;
  if (processError.code === 129) return true;
  return /(?:unknown|unrecognized|unsupported).*(?:-z|switch [`'"]?z)/i.test(
    processError.stderr ?? "",
  );
}

function parseWorktreeFields(fields: readonly string[]): WorktreeRecord[] {
  const worktrees: WorktreeRecord[] = [];
  let current: WorktreeRecord | null = null;

  for (const field of fields) {
    if (field.startsWith("worktree ")) {
      if (current) worktrees.push(current);
      current = {
        path: field.substring(9),
        branch: "",
        name: "",
        isMain: false,
      };
    } else if (field.startsWith("branch ") && current) {
      const ref = field.substring(7);
      current.branch = ref.startsWith("refs/heads/")
        ? ref.substring("refs/heads/".length)
        : ref;
      current.name = current.branch;
    } else if (field === "bare" && current) {
      current.isMain = true;
      current.name ||= path.basename(current.path);
    } else if (field === "detached" && current) {
      current.branch = "(detached)";
      current.name ||= path.basename(current.path);
    }
  }

  if (current) worktrees.push(current);
  for (const worktree of worktrees) {
    worktree.name ||= path.basename(worktree.path);
  }
  if (worktrees[0]) worktrees[0].isMain = true;
  return worktrees;
}

export function parseWorktreePorcelainZ(stdout: string): WorktreeRecord[] {
  return parseWorktreeFields(stdout.split("\0"));
}

export function parseWorktreePorcelainLines(stdout: string): WorktreeRecord[] {
  return parseWorktreeFields(stdout.split("\n"));
}

export async function readPorcelainWorktreeRecords(
  projectPath: string,
  trace?: GitCommandTrace[],
  run: typeof runGitTraced = runGitTraced,
): Promise<WorktreeRecord[]> {
  try {
    const { stdout } = await run(
      projectPath,
      ["worktree", "list", "--porcelain", "-z"],
      trace,
      readOnlyGitOptions(),
    );
    return parseWorktreePorcelainZ(stdout);
  } catch (error) {
    // Git added NUL-framed worktree porcelain in 2.36.
    if (!supportsLegacyPorcelainRetry(error)) throw error;
    const { stdout } = await run(
      projectPath,
      ["worktree", "list", "--porcelain"],
      trace,
      readOnlyGitOptions(),
    );
    return parseWorktreePorcelainLines(stdout);
  }
}
