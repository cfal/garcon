import type { AgentLogger } from '@garcon/server-agent-interface';

const MAX_SINGLE_QUERY_STDOUT_BYTES = 4 * 1024 * 1024;
const MAX_SINGLE_QUERY_STDERR_BYTES = 16 * 1024;

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

  const [stdout, stderr, exitCode] = await Promise.all([
    readBoundedOutput(proc.stdout, MAX_SINGLE_QUERY_STDOUT_BYTES, 'stdout'),
    readBoundedOutput(proc.stderr, MAX_SINGLE_QUERY_STDERR_BYTES, 'stderr'),
    proc.exited,
  ]);
  signal.throwIfAborted();
  if (exitCode !== 0) {
    logger.warn('Claude one-shot process failed', {
      exitCode,
      stderrBytes: Buffer.byteLength(stderr),
    });
    const detail = stderr.trim();
    throw new Error(
      detail
        ? `Claude CLI exited with code ${exitCode}: ${detail}`
        : `Claude CLI exited with code ${exitCode}`,
    );
  }
  return stdout;
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
