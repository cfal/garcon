import { runBoundedCommand } from './bounded-command.js';
import { parseCliVersion } from './cli-version.js';

const VERSION_PROBE_MAX_BYTES = 16 * 1024;

// Resolves a command on the PATH of the environment the CLI runs with,
// including Windows' `Path` spelling.
export function findExecutable(command: string, env: Record<string, string>): string | null {
  return Bun.which(command, { PATH: env.PATH ?? env.Path ?? '' });
}

// Runs `<executable> --version`. A failed run's output can belong to a wrapper
// rather than the CLI, so only a successful run reports a version.
export async function probeCliVersion(
  executable: string,
  env: Record<string, string>,
  timeoutMs: number,
): Promise<string | null> {
  try {
    const result = await runBoundedCommand([executable, '--version'], {
      env, timeoutMs, maxOutputBytes: VERSION_PROBE_MAX_BYTES,
    });
    return result.exitCode === 0 ? parseCliVersion(`${result.stdout}\n${result.stderr}`) : null;
  } catch {
    return null;
  }
}
