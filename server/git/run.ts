import path from 'path';
import { promises as fs } from 'fs';
import type { GitCommandResult, GitCommandTrace, GitProcessError } from './types.js';

const GIT_LOCK_RETRY_DELAY_MS = 100;
const GIT_LOCK_MAX_RETRIES = 50;

// Returns true when stderr indicates a git index.lock contention error.
function isLockError(stderr: string): boolean {
  const lower = stderr.toLowerCase();
  return lower.includes('index.lock') || lower.includes('unable to create') && lower.includes('.lock');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function streamText(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  return stream ? new Response(stream).text() : Promise.resolve('');
}

// Spawns a git subprocess and returns stdout/stderr on success.
// Retries transparently when the index.lock is held by another process.
export async function runGit(cwd: string, args: string[]): Promise<GitCommandResult> {
  for (let attempt = 0; ; attempt++) {
    const proc = Bun.spawn(['git', ...args], {
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      streamText(proc.stdout),
      streamText(proc.stderr),
      proc.exited,
    ]);
    if (exitCode === 0) return { stdout, stderr };

    if (isLockError(stderr) && attempt < GIT_LOCK_MAX_RETRIES) {
      await sleep(GIT_LOCK_RETRY_DELAY_MS);
      continue;
    }

    const error: GitProcessError = new Error(`git ${args[0]} failed (exit ${exitCode}): ${stderr.trim()}`);
    error.code = exitCode;
    error.stdout = stdout;
    error.stderr = stderr;
    throw error;
  }
}

// Runs git and appends safe command timing metadata when a trace is provided.
export async function runGitTraced(
  cwd: string,
  args: string[],
  trace?: GitCommandTrace[],
): Promise<GitCommandResult> {
  const startedAt = performance.now();
  try {
    const result = await runGit(cwd, args);
    trace?.push({
      args,
      durationMs: Math.round(performance.now() - startedAt),
      stdoutBytes: Buffer.byteLength(result.stdout),
      stderrBytes: Buffer.byteLength(result.stderr),
    });
    return result;
  } catch (error) {
    const processError = error as GitProcessError;
    trace?.push({
      args,
      durationMs: Math.round(performance.now() - startedAt),
      stdoutBytes: Buffer.byteLength(processError.stdout ?? ''),
      stderrBytes: Buffer.byteLength(processError.stderr ?? ''),
      failed: true,
      ...(typeof processError.code === 'number' ? { exitCode: processError.code } : {}),
    });
    throw error;
  }
}

// Spawns a git subprocess that reads from stdin (e.g. git apply).
// Retries transparently on index.lock contention.
export async function runGitWithStdin(cwd: string, args: string[], input: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    const proc = Bun.spawn(['git', ...args], {
      cwd,
      stdin: new Blob([input]),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stderr, exitCode] = await Promise.all([
      streamText(proc.stderr),
      proc.exited,
    ]);
    if (exitCode === 0) return;

    if (isLockError(stderr) && attempt < GIT_LOCK_MAX_RETRIES) {
      await sleep(GIT_LOCK_RETRY_DELAY_MS);
      continue;
    }

    throw new Error(`git apply failed: ${stderr.trim()}`);
  }
}

// Detects binary files by checking for null bytes in the first 8KB.
// This is the same heuristic Git uses in its buffer_is_binary() function.
export async function isBinaryFile(filePath: string): Promise<boolean> {
  try {
    const fileHandle = await fs.open(filePath, 'r');
    try {
      const buf = Buffer.alloc(8192);
      const { bytesRead } = await fileHandle.read(buf, 0, 8192, 0);
      return bytesRead > 0 && buf.subarray(0, bytesRead).includes(0x00);
    } finally {
      await fileHandle.close();
    }
  } catch {
    return false;
  }
}

// Strips git diff metadata headers, keeping only hunk content starting from @@ markers.
export function stripDiffHeaders(diff: string): string {
  if (!diff) return '';
  if (diff.startsWith('@@')) return diff;
  const hunkStart = diff.indexOf('\n@@');
  return hunkStart === -1 ? diff : diff.substring(hunkStart + 1);
}

// Asserts that the given path is an accessible git working tree.
// Throws on failure with a descriptive error message.
export async function assertGitRepository(projectPath: string): Promise<void> {
  try {
    await fs.access(projectPath);
  } catch {
    throw new Error(`Unable to access project directory: ${projectPath}`);
  }

  let stdout;
  try {
    ({ stdout } = await runGit(projectPath, ['rev-parse', '--is-inside-work-tree']));
  } catch {
    throw new Error('Git is not initialized in this directory. Initialize a repository with "git init" before using source control actions.');
  }

  if (stdout.trim() !== 'true') {
    throw new Error('The target path exists but is not inside a Git working tree.');
  }
}

// Checks whether a file is untracked (status `??`) via git status --porcelain.
export async function isFileUntracked(projectPath: string, file: string): Promise<boolean> {
  try {
    const { stdout } = await runGit(projectPath, ['status', '--porcelain', '--', file]);
    return stdout.trimStart().startsWith('??');
  } catch {
    return false;
  }
}

// Resolves a file path within a project root, guarding against path traversal.
export function resolvePathWithinProject(projectPath: string, file: string): string {
  const resolvedRoot = path.resolve(projectPath);
  const resolvedFile = path.resolve(resolvedRoot, file);
  const normalizedRoot = `${resolvedRoot}${path.sep}`;
  if (!resolvedFile.startsWith(normalizedRoot) && resolvedFile !== resolvedRoot) {
    throw new Error('The requested file path resolves outside the project root.');
  }
  return resolvedFile;
}
