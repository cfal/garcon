import { stripVTControlCharacters } from 'node:util';

export interface BoundedCommandOptions {
  readonly env: Record<string, string>;
  readonly timeoutMs: number;
  // Bytes kept from the end of each stream, where failures are reported;
  // earlier output is dropped, not an error.
  readonly maxOutputBytes: number;
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

// Runs a command with no stdin, a deadline, and bounded output. A deadline
// stops the command's whole process tree, such as the scripts an installer
// starts, so they release the output pipes; a group that ignores SIGTERM is
// killed one second later so the deadline holds.
export async function runBoundedCommand(
  command: readonly [string, ...string[]],
  options: BoundedCommandOptions,
): Promise<BoundedCommandResult> {
  const windows = process.platform === 'win32';
  const child = Bun.spawn([...command], {
    env: options.env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    detached: !windows,
  });
  let timedOut = false;
  let killTimer: ReturnType<typeof setTimeout> | null = null;
  const deadline = setTimeout(() => {
    timedOut = true;
    if (windows) {
      Bun.spawn(['taskkill', '/PID', String(child.pid), '/T', '/F'], {
        env: options.env, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore',
      });
      return;
    }
    signalGroup(child.pid, 'SIGTERM');
    killTimer = setTimeout(() => signalGroup(child.pid, 'SIGKILL'), KILL_GRACE_MS);
  }, options.timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      collect(child.stdout, options.maxOutputBytes, options.onLine),
      collect(child.stderr, options.maxOutputBytes, options.onLine),
      child.exited,
    ]);
    return {
      exitCode: timedOut ? null : exitCode,
      stdout: stdout.text,
      stderr: stderr.text,
      timedOut,
      truncated: stdout.truncated || stderr.truncated,
    };
  } finally {
    clearTimeout(deadline);
    if (killTimer) clearTimeout(killTimer);
  }
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // The group already exited.
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
    chunks.push(chunk);
    bytes += chunk.byteLength;
    while (bytes > maxBytes) {
      const excess = bytes - maxBytes;
      const first = chunks[0]!;
      if (first.byteLength <= excess) chunks.shift();
      else chunks[0] = first.subarray(excess);
      bytes -= Math.min(first.byteLength, excess);
      truncated = true;
    }
    if (!onLine) continue;
    // A line ends at the last newline or carriage return; the remainder waits for more output.
    const text = (partial + decoder.decode(chunk, { stream: true })).replace(REDRAW_PATTERN, '\r');
    const end = Math.max(text.lastIndexOf('\n'), text.lastIndexOf('\r'));
    partial = text.slice(end + 1).slice(-MAX_PARTIAL_LINE_CHARS);
    for (const line of outputLines(text.slice(0, end + 1))) onLine(line);
  }
  if (onLine) for (const line of outputLines(partial + decoder.decode())) onLine(line);
  return { text: Buffer.concat(chunks).toString('utf8'), truncated };
}

// Splits captured output into display lines, as `onLine` receives them.
export function outputLines(text: string): string[] {
  return text.replace(REDRAW_PATTERN, '\r').split(/\r\n|\r|\n/)
    .map((line) => stripVTControlCharacters(line).replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}
