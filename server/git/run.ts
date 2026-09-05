import path from 'path';
import { promises as fs } from 'fs';
import { readTextStreamPrefix, readTextStreamWithLimit } from '../lib/bounded-text-stream.js';
import type {
  GitCommandOptions,
  GitCommandResult,
  GitCommandTrace,
  GitProcessError,
} from './types.js';

const GIT_LOCK_RETRY_DELAY_MS = 100;
const GIT_LOCK_MAX_RETRIES = 50;
const GIT_DEFAULT_MAX_STDOUT_BYTES = 64 * 1024 * 1024;
const GIT_DEFAULT_MAX_STDERR_BYTES = 2 * 1024 * 1024;

export function gitCommandEnv(options: GitCommandOptions): NodeJS.ProcessEnv | undefined {
  if (!options.disableOptionalLocks && !options.env) return undefined;
  return {
    ...process.env,
    ...options.env,
    ...(options.disableOptionalLocks ? { GIT_OPTIONAL_LOCKS: '0' } : {}),
  };
}

// Builds command options that avoid optional Git index writes for read-only probes.
export function readOnlyGitOptions(options: GitCommandOptions = {}): GitCommandOptions {
  return { ...options, disableOptionalLocks: true };
}

// Returns true when stderr indicates a git index.lock contention error.
function isLockError(stderr: string): boolean {
  const lower = stderr.toLowerCase();
  return lower.includes('index.lock') || lower.includes('unable to create') && lower.includes('.lock');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class GitOutputLimitError extends Error {
  constructor(
    readonly stream: 'stdout' | 'stderr',
    readonly maxBytes: number,
  ) {
    super(`Git ${stream} exceeded the ${maxBytes} byte limit.`);
    this.name = 'GitOutputLimitError';
  }
}

function readGitOutput(
  stream: ReadableStream<Uint8Array> | null,
  streamName: 'stdout' | 'stderr',
  maxBytes: number,
): Promise<string> {
  return readTextStreamWithLimit(
    stream,
    maxBytes,
    () => new GitOutputLimitError(streamName, maxBytes),
  );
}

function createGitAbortState(options: GitCommandOptions): {
  signal?: AbortSignal;
  cleanup: () => void;
  timedOut: () => boolean;
  aborted: () => boolean;
} {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const timeoutController = new AbortController();
  let timeoutReached = false;
  let callerAborted = false;
  const timeoutHandle = setTimeout(() => {
    timeoutReached = true;
    timeoutController.abort();
  }, timeoutMs);
  timeoutHandle.unref?.();

  const callerSignal = options.signal;
  const onCallerAbort = (): void => {
    callerAborted = true;
  };
  callerSignal?.addEventListener('abort', onCallerAbort, { once: true });

  const signal = callerSignal
    ? AbortSignal.any([callerSignal, timeoutController.signal])
    : timeoutController.signal;

  return {
    signal,
    cleanup: () => {
      clearTimeout(timeoutHandle);
      callerSignal?.removeEventListener('abort', onCallerAbort);
    },
    timedOut: () => timeoutReached,
    aborted: () => callerAborted || timeoutReached,
  };
}

function makeGitProcessError(
  args: string[],
  exitCode: number | null,
  stdout: string,
  stderr: string,
  options: { timedOut?: boolean; aborted?: boolean } = {},
): GitProcessError {
  const reason = options.timedOut
    ? 'timed out'
    : options.aborted
      ? 'aborted'
      : `exit ${exitCode}`;
  const message = stderr.trim() || stdout.trim() || reason;
  const error: GitProcessError = new Error(`git ${args[0]} failed (${reason}): ${message}`);
  if (typeof exitCode === 'number') error.code = exitCode;
  error.stdout = stdout;
  error.stderr = stderr;
  error.timedOut = options.timedOut;
  error.aborted = options.aborted;
  return error;
}

type GitStdin = 'ignore' | Blob;

// Shared subprocess loop for every git invocation: abort wiring, output-limit
// capture, and transparent index.lock retry. Retries stop honoring the caller
// once its abort fired during the retry delay.
async function runGitProcess(
  cwd: string,
  args: string[],
  options: GitCommandOptions,
  stdin: GitStdin,
): Promise<GitCommandResult> {
  for (let attempt = 0; ; attempt++) {
    const abortState = createGitAbortState(options);
    let proc: Bun.Subprocess<GitStdin, 'pipe', 'pipe'>;
    try {
      proc = Bun.spawn(['git', ...args], {
        cwd,
        stdin,
        stdout: 'pipe',
        stderr: 'pipe',
        signal: abortState.signal,
        env: gitCommandEnv(options),
      });
    } catch (error) {
      abortState.cleanup();
      throw error;
    }
    const abortListener = (): void => {
      proc.kill();
    };
    abortState.signal?.addEventListener('abort', abortListener, { once: true });
    let outputLimitError: GitOutputLimitError | null = null;
    const captureOutput = (output: Promise<string>): Promise<string> =>
      output.catch((error) => {
        if (error instanceof GitOutputLimitError) {
          outputLimitError ??= error;
          proc.kill();
        }
        return '';
      });
    const [stdout, stderr, exitCode] = await Promise.all([
      captureOutput(readGitOutput(
        proc.stdout,
        'stdout',
        options.maxStdoutBytes ?? GIT_DEFAULT_MAX_STDOUT_BYTES,
      )),
      captureOutput(readTextStreamPrefix(
        proc.stderr,
        options.maxStderrBytes ?? GIT_DEFAULT_MAX_STDERR_BYTES,
      )),
      proc.exited,
    ]).finally(() => {
      abortState.signal?.removeEventListener('abort', abortListener);
      abortState.cleanup();
    });
    if (outputLimitError) throw outputLimitError;
    if (exitCode === 0) return { stdout, stderr };

    if (isLockError(stderr) && attempt < GIT_LOCK_MAX_RETRIES) {
      await sleep(GIT_LOCK_RETRY_DELAY_MS);
      // The attempt's abort state was torn down by cleanup(), so read the
      // caller signal directly; otherwise an abort during the retry delay
      // is misreported as a plain exit failure on the next attempt.
      if (options.signal?.aborted) {
        throw makeGitProcessError(args, exitCode, stdout, stderr, { aborted: true });
      }
      if (abortState.timedOut() || abortState.aborted()) {
        throw makeGitProcessError(args, exitCode, stdout, stderr, {
          timedOut: abortState.timedOut(),
          aborted: abortState.aborted(),
        });
      }
      continue;
    }

    throw makeGitProcessError(args, exitCode, stdout, stderr, {
      timedOut: abortState.timedOut(),
      aborted: abortState.aborted(),
    });
  }
}

// Spawns a git subprocess and returns stdout/stderr on success.
export async function runGit(
  cwd: string,
  args: string[],
  options: GitCommandOptions = {},
): Promise<GitCommandResult> {
  return runGitProcess(cwd, args, options, 'ignore');
}

// Runs git and appends safe command timing metadata when a trace is provided.
export async function runGitTraced(
  cwd: string,
  args: string[],
  trace?: GitCommandTrace[],
  options: GitCommandOptions = {},
): Promise<GitCommandResult> {
  const startedAt = performance.now();
  try {
    const result = await runGit(cwd, args, options);
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
      ...(processError.timedOut ? { timedOut: true } : {}),
      ...(processError.aborted ? { aborted: true } : {}),
    });
    throw error;
  }
}

// Spawns a git subprocess that reads from stdin (e.g. git apply).
export async function runGitWithStdin(
  cwd: string,
  args: string[],
  input: string,
  options: GitCommandOptions = {},
): Promise<GitCommandResult> {
  return runGitProcess(cwd, args, options, new Blob([input]));
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
export async function assertGitRepository(
  projectPath: string,
  signal?: AbortSignal,
): Promise<void> {
  try {
    await fs.access(projectPath);
  } catch {
    throw new Error(`Unable to access project directory: ${projectPath}`);
  }

  let stdout;
  try {
    ({ stdout } = await runGit(
      projectPath,
      ['rev-parse', '--is-inside-work-tree'],
      readOnlyGitOptions({ signal }),
    ));
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error('Git is not initialized in this directory. Initialize a repository with "git init" before using source control actions.');
  }

  if (stdout.trim() !== 'true') {
    throw new Error('The target path exists but is not inside a Git working tree.');
  }
}

// Checks whether a file is untracked (status `??`) via git status --porcelain.
export async function isFileUntracked(projectPath: string, file: string): Promise<boolean> {
  try {
    const { stdout } = await runGit(
      projectPath,
      ['status', '--porcelain', '--', file],
      readOnlyGitOptions(),
    );
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
