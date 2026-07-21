import { errorMessage } from '@garcon/server-agent-common/lib/errors';
import type { AgentLogger } from '@garcon/server-agent-interface';

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

  const chunks: Uint8Array[] = [];
  const reader = proc.stdout.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
  } catch (err: unknown) {
    logger.error('Claude one-shot stdout read failed', {
      error: errorMessage(err),
    });
  }

  await proc.exited;
  signal.throwIfAborted();

  const decoder = new TextDecoder();
  return chunks.map((chunk) => decoder.decode(chunk, { stream: true })).join('') + decoder.decode();
}
