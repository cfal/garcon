import { runGitWithStdin } from "../run.js";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

export async function runGitCommand(cwd, args, options = {}) {
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

export async function initRepoWithCommit(projectPath) {
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

// Replaces the path's index entry with explicit unmerged stages, the layout
// behind UU/UD/DU/DD porcelain statuses.
export async function plantUnmergedStages(projectPath, file, stages) {
  await runGitCommand(projectPath, ["update-index", "--force-remove", file]);
  let entries = "";
  for (const [stage, content] of stages) {
    const { stdout: hash } = await runGitWithStdin(
      projectPath,
      ["hash-object", "-w", "--stdin"],
      content,
    );
    entries += `100644 ${hash.trim()} ${stage}\t${file}\n`;
  }
  await runGitWithStdin(projectPath, ["update-index", "--index-info"], entries);
}
