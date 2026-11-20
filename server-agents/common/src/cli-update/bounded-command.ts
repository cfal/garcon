import { stripVTControlCharacters } from 'node:util';

export interface BoundedCommandOptions {
  readonly env: Record<string, string>;
  readonly timeoutMs: number;
  // Bytes kept per stream; output beyond it is dropped, not an error.
  readonly maxOutputBytes: number;
  readonly cwd?: string;
  readonly signal?: AbortSignal;
  // Receives each complete output line, stripped of terminal control sequences.
  readonly onLine?: (line: string) => void;
}

export interface BoundedCommandResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly truncated: boolean;
}

const KILL_GRACE_MS = 1_000;
const MAX_PARTIAL_LINE_CHARS = 4_096;
// Progress bars redraw with a carriage return or a cursor-to-column-one sequence.
const REDRAW_PATTERN = /\x1b\[(?:0*1?G|999D)/g;

// Runs a command with no stdin, a deadline, and bounded output. A command that
// ignores SIGTERM is killed one second later so the deadline holds.
export async function runBoundedCommand(
  command: readonly [string, ...string[]],
  options: BoundedCommandOptions,
): Promise<BoundedCommandResult> {
  const child = Bun.spawn([...command], {
    cwd: options.cwd,
    env: options.env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let timedOut = false;
  let killTimer: ReturnType<typeof setTimeout> | null = null;
  const terminate = () => {
    if (child.exitCode !== null || child.killed) return;
    child.kill('SIGTERM');
    killTimer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
  };
  const deadline = setTimeout(() => {
    timedOut = true;
    terminate();
  }, options.timeoutMs);
  options.signal?.addEventListener('abort', terminate, { once: true });
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      collect(child.stdout, options.maxOutputBytes, options.onLine),
      collect(child.stderr, options.maxOutputBytes, options.onLine),
      child.exited,
    ]);
    return {
      exitCode: timedOut || options.signal?.aborted ? null : exitCode,
      stdout: stdout.text,
      stderr: stderr.text,
      timedOut,
      truncated: stdout.truncated || stderr.truncated,
    };
  } finally {
    clearTimeout(deadline);
    if (killTimer) clearTimeout(killTimer);
    options.signal?.removeEventListener('abort', terminate);
  }
}

async function collect(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  onLine: ((line: string) => void) | undefined,
): Promise<{ text: string; truncated: boolean }> {
  const decoder = new TextDecoder();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let truncated = false;
  let partial = '';
  for await (const chunk of stream) {
    if (bytes < maxBytes) {
      const kept = chunk.subarray(0, maxBytes - bytes);
      chunks.push(kept);
      bytes += kept.byteLength;
      truncated ||= kept.byteLength < chunk.byteLength;
    } else {
      truncated = true;
    }
    if (!onLine) continue;
    const lines = (partial + decoder.decode(chunk, { stream: true }))
      .replace(REDRAW_PATTERN, '\r')
      .split(/\r\n|\r|\n/);
    partial = lines.pop()!.slice(-MAX_PARTIAL_LINE_CHARS);
    for (const line of lines) emitLine(line, onLine);
  }
  if (onLine) emitLine(partial + decoder.decode(), onLine);
  return { text: Buffer.concat(chunks).toString('utf8'), truncated };
}

function emitLine(line: string, onLine: (line: string) => void): void {
  const cleaned = stripVTControlCharacters(line).replace(/\s+/g, ' ').trim();
  if (cleaned) onLine(cleaned);
}
