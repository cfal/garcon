import path from "node:path";
import type { GitCommandTrace } from "./types.js";
import { readOnlyGitOptions, runGitTraced } from "./run.js";

export interface WorktreeLayout {
  worktreeRoot: string;
  commonDir: string;
  refFormat: string;
}

export function parseWorktreeLayoutProbe(
  stdout: string,
): WorktreeLayout | null {
  const output = stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout;
  const lines = output.split("\n");
  if (lines.length !== 4 || lines[0] !== "true") return null;

  const [, worktreeRoot, commonDir, refFormat] = lines;
  if (
    !worktreeRoot ||
    !commonDir ||
    !refFormat ||
    !path.isAbsolute(worktreeRoot) ||
    !path.isAbsolute(commonDir)
  ) {
    return null;
  }

  return { worktreeRoot, commonDir, refFormat };
}

export async function probeWorktreeLayout(
  projectPath: string,
  trace?: GitCommandTrace[],
): Promise<WorktreeLayout | null> {
  try {
    const { stdout } = await runGitTraced(
      projectPath,
      [
        "rev-parse",
        "--is-inside-work-tree",
        "--path-format=absolute",
        "--show-toplevel",
        "--git-common-dir",
        "--show-ref-format",
      ],
      trace,
      readOnlyGitOptions(),
    );
    return parseWorktreeLayoutProbe(stdout);
  } catch {
    return null;
  }
}
