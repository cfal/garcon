import { createHash } from 'node:crypto';
import { errorMessage } from '@garcon/server-agent-common/lib/errors';
import type { AgentLogger } from '@garcon/server-agent-interface';

const MAX_SINGLE_QUERY_STDOUT_BYTES = 4 * 1024 * 1024;
const MAX_SINGLE_QUERY_STDERR_BYTES = 16 * 1024;
const SINGLE_QUERY_EXIT_GRACE_MS = 1_000;

interface ClaudeSingleQueryProcessOptions {
  readonly binary: string;
  readonly args: string[];
  readonly cwd: string;
  readonly envOverrides?: Record<string, string>;
  readonly signal: AbortSignal;
  readonly logger: AgentLogger;
}

export async function runClaudeSingleQueryProcess({
  binary,
  args,
  cwd,
  envOverrides,
  signal,
  logger,
}: ClaudeSingleQueryProcessOptions): Promise<string> {
  const { CLAUDECODE, ...env } = process.env;
  const proc = Bun.spawn([binary, ...args], {
    cwd,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    signal,
    env: { ...env, ...envOverrides },
  });

  let stdout: string;
  let stderr: string;
  let exitCode: number;
  try {
    [stdout, stderr, exitCode] = await Promise.all([
      readBoundedOutput(proc.stdout, MAX_SINGLE_QUERY_STDOUT_BYTES, 'stdout'),
      readBoundedOutput(proc.stderr, MAX_SINGLE_QUERY_STDERR_BYTES, 'stderr'),
      proc.exited,
    ]);
  } catch (error) {
    try {
      await terminateFailedProcess(proc);
    } catch (teardownError) {
      throw new Error(
        `${errorMessage(error)} Claude one-shot teardown failed: ${errorMessage(teardownError)}`,
        { cause: error },
      );
    }
    throw error;
  }
  signal.throwIfAborted();
  if (exitCode !== 0) {
    const stderrBytes = Buffer.byteLength(stderr);
    const stderrDigest = stderrBytes > 0
      ? createHash('sha256').update(stderr).digest('hex').slice(0, 16)
      : null;
    logger.warn('Claude one-shot process failed', {
      exitCode,
      stderrBytes,
      stderrDigest,
    });
    throw new Error(
      stderrDigest
        ? `Claude CLI exited with code ${exitCode} (stderr digest ${stderrDigest})`
        : `Claude CLI exited with code ${exitCode}`,
    );
  }
  return stdout;
}

async function terminateFailedProcess(
  process: ReturnType<typeof Bun.spawn>,
): Promise<void> {
  if (await waitForExit(process, 0)) return;
  if (!process.killed) process.kill();
  if (await waitForExit(process, SINGLE_QUERY_EXIT_GRACE_MS)) return;
  process.kill('SIGKILL');
  if (await waitForExit(process, SINGLE_QUERY_EXIT_GRACE_MS)) return;
  throw new Error('Claude one-shot process did not exit after SIGKILL');
}

async function waitForExit(
  process: ReturnType<typeof Bun.spawn>,
  timeoutMs: number,
): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      process.exited.then(
        () => true,
        () => true,
      ),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function readBoundedOutput(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  name: string,
): Promise<string> {
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const reader = stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      throw new Error(`Claude one-shot ${name} exceeded ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const decoder = new TextDecoder();
  return chunks.map((chunk) => decoder.decode(chunk, { stream: true })).join('') + decoder.decode();
}

export { MAX_SINGLE_QUERY_STDERR_BYTES, MAX_SINGLE_QUERY_STDOUT_BYTES };
