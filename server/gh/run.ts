import { promises as fs } from 'fs';
import type { GhCommandOptions, GhCommandResult, GhProcessError } from './gh-types.js';

const GH_DEFAULT_TIMEOUT_MS = 30_000;

function streamText(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  return stream ? new Response(stream).text().catch(() => '') : Promise.resolve('');
}

function makeGhProcessError(
  args: string[],
  exitCode: number | null,
  stdout: string,
  stderr: string,
  options: { timedOut?: boolean; aborted?: boolean } = {},
): GhProcessError {
  const reason = options.timedOut
    ? 'timed out'
    : options.aborted
      ? 'aborted'
      : `exit ${exitCode}`;
  const message = stderr.trim() || stdout.trim() || reason;
  const error: GhProcessError = new Error(`gh ${args[0] ?? ''} failed (${reason}): ${message}`);
  if (typeof exitCode === 'number') error.code = exitCode;
  error.stdout = stdout;
  error.stderr = stderr;
  error.timedOut = options.timedOut;
  error.aborted = options.aborted;
  return error;
}

// Spawns a `gh` subprocess and returns stdout/stderr on success. Unlike git,
// gh commands never contend on an index lock, so no retry loop is needed.
export async function runGh(
  cwd: string,
  args: string[],
  options: GhCommandOptions = {},
): Promise<GhCommandResult> {
  const timeoutMs = options.timeoutMs ?? GH_DEFAULT_TIMEOUT_MS;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeoutSignal])
    : timeoutSignal;

  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(['gh', ...args], {
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
      signal,
    });
  } catch (error) {
    // Bun throws synchronously when the executable is missing.
    const spawnError: GhProcessError = new Error(
      'GitHub CLI (gh) is not installed or not on PATH.',
    );
    spawnError.stderr = error instanceof Error ? error.message : String(error);
    throw spawnError;
  }

  const abortListener = (): void => {
    proc.kill();
  };
  signal.addEventListener('abort', abortListener, { once: true });

  const [stdout, stderr, exitCode] = await Promise.all([
    streamText(proc.stdout),
    streamText(proc.stderr),
    proc.exited,
  ]).finally(() => {
    signal.removeEventListener('abort', abortListener);
  });

  if (exitCode === 0) return { stdout, stderr };

  throw makeGhProcessError(args, exitCode, stdout, stderr, {
    timedOut: timeoutSignal.aborted,
    aborted: options.signal?.aborted ?? false,
  });
}

// Runs `gh` and parses its stdout as JSON, throwing a descriptive error when
// the output is not valid JSON.
export async function runGhJson<T>(
  cwd: string,
  args: string[],
  options: GhCommandOptions = {},
): Promise<T> {
  const { stdout } = await runGh(cwd, args, options);
  try {
    return JSON.parse(stdout) as T;
  } catch {
    throw new Error(`gh ${args[0] ?? ''} returned malformed JSON output.`);
  }
}

// Asserts the given path is an accessible directory before shelling out.
export async function assertAccessibleDirectory(projectPath: string): Promise<void> {
  try {
    await fs.access(projectPath);
  } catch {
    throw new Error(`Unable to access project directory: ${projectPath}`);
  }
}
