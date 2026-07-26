import { createHash } from 'node:crypto';
import { errorMessage } from '@garcon/server-agent-common/lib/errors';
import type { AgentLogger } from '@garcon/server-agent-interface';

// Covers Garcon's attachment budget after base64 expansion plus its command envelope.
const MAX_STDOUT_FRAME_BYTES = 64 * 1024 * 1024;
const MAX_STDERR_TAIL_BYTES = 16 * 1024;
const PROCESS_EXIT_GRACE_MS = 5_000;
const PROCESS_EXIT_TERM_MS = 5_000;
const PROCESS_EXIT_KILL_MS = 5_000;

type ClaudeSubprocess = ReturnType<typeof Bun.spawn>;

export type ClaudeTransportFailureKind =
  | 'stdout'
  | 'stderr'
  | 'write';

export interface ClaudeTransportFailure {
  readonly kind: ClaudeTransportFailureKind;
  readonly message: string;
}

export interface ClaudeProcessExit {
  readonly exitCode: number;
  readonly stderrBytes: number;
  readonly stderrLines: number;
  readonly stderrRetainedBytes: number;
  readonly stderrTailDigest: string | null;
  readonly stderrTruncated: boolean;
}

interface ClaudeProcessTransportOptions<Message> {
  readonly process: ClaudeSubprocess;
  readonly logger: AgentLogger;
  readonly sessionId: string;
  readonly onMessage: (message: Message) => void;
  readonly onFailure: (failure: ClaudeTransportFailure) => void;
  readonly onEof: () => void;
  readonly onExit: (exit: ClaudeProcessExit) => void;
  readonly maxStdoutFrameBytes?: number;
}

interface StderrSummary {
  bytes: number;
  lines: number;
  retainedBytes: number;
  tailDigest: string | null;
  truncated: boolean;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

async function waitForExit(process: ClaudeSubprocess, timeoutMs: number): Promise<boolean> {
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

function parseStdoutLine<Message>(line: string): Message | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as Message;
  } catch {
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      throw new Error('Claude CLI emitted malformed JSON');
    }
    return null;
  }
}

async function readBoundedStdout<Message>(
  stream: ReadableStream<Uint8Array>,
  onMessage: (message: Message) => void,
  onNoise: () => void,
  maxFrameBytes: number,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (byteLength(line) > maxFrameBytes) {
        throw new Error('Claude CLI emitted an oversized JSON frame');
      }
      const message = parseStdoutLine<Message>(line);
      if (message) onMessage(message);
      else if (line.trim()) onNoise();
      newline = buffer.indexOf('\n');
    }

    if (byteLength(buffer) > maxFrameBytes) {
      throw new Error('Claude CLI emitted an oversized JSON frame');
    }
  }

  buffer += decoder.decode();
  if (!buffer.trim()) return;
  if (byteLength(buffer) > maxFrameBytes) {
    throw new Error('Claude CLI emitted an oversized JSON frame');
  }
  const message = parseStdoutLine<Message>(buffer);
  if (message) onMessage(message);
  else onNoise();
}

async function drainStderr(
  stream: ReadableStream<Uint8Array>,
  onChunk: (text: string) => void,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    onChunk(decoder.decode(value, { stream: true }));
  }
  const remainder = decoder.decode();
  if (remainder) onChunk(remainder);
}

export class ClaudeProcessTransport<Message> {
  readonly process: ClaudeSubprocess;
  readonly #options: ClaudeProcessTransportOptions<Message>;
  #writeTail: Promise<void> = Promise.resolve();
  #stderrReader: Promise<void> = Promise.resolve();
  #retirement: Promise<void> | null = null;
  #retiring = false;
  #failureReported = false;
  #stdoutNoiseCount = 0;
  #stderrTail = '';
  #stderrBytes = 0;
  #stderrLines = 0;

  constructor(options: ClaudeProcessTransportOptions<Message>) {
    this.process = options.process;
    this.#options = options;
    this.#startReaders();
  }

  writeLine(jsonl: string): Promise<void> {
    const write = this.#writeTail.then(async () => {
      if (this.#retiring || this.process.killed) {
        throw new Error('Claude CLI process is not writable');
      }
      const stdin = this.process.stdin as import('bun').FileSink;
      if (!stdin?.write) throw new Error('Claude CLI process has no writable stdin');
      await stdin.write(jsonl + '\n');
      await stdin.flush();
    }).catch((error: unknown) => {
      this.#reportFailure({ kind: 'write', message: errorMessage(error) });
      throw error;
    });
    this.#writeTail = write.catch(() => undefined);
    return write;
  }

  retire(): Promise<void> {
    if (this.#retirement) return this.#retirement;
    this.#retiring = true;
    this.#retirement = this.#retire();
    return this.#retirement;
  }

  stderrSummary(): StderrSummary {
    const retainedBytes = byteLength(this.#stderrTail);
    return {
      bytes: this.#stderrBytes,
      lines: this.#stderrLines,
      retainedBytes,
      tailDigest: retainedBytes > 0
        ? createHash('sha256').update(this.#stderrTail).digest('hex').slice(0, 16)
        : null,
      truncated: this.#stderrBytes > retainedBytes,
    };
  }

  async #retire(): Promise<void> {
    await this.#writeTail;
    const stdin = this.process.stdin as import('bun').FileSink & { end?: () => void };
    try {
      stdin?.end?.();
    } catch {
      // Signal escalation below remains authoritative when stdin cannot close.
    }
    if (await waitForExit(this.process, PROCESS_EXIT_GRACE_MS)) return;

    if (!this.process.killed) this.process.kill();
    if (await waitForExit(this.process, PROCESS_EXIT_TERM_MS)) return;

    this.process.kill('SIGKILL');
    if (await waitForExit(this.process, PROCESS_EXIT_KILL_MS)) return;
    throw new Error('Claude process did not exit after SIGKILL');
  }

  #startReaders(): void {
    const stdout = this.process.stdout;
    if (stdout && typeof stdout !== 'number') {
      void readBoundedStdout<Message>(
        stdout,
        this.#options.onMessage,
        () => this.#recordStdoutNoise(),
        this.#options.maxStdoutFrameBytes ?? MAX_STDOUT_FRAME_BYTES,
      ).then(
        async () => {
          if (
            !this.#retiring
            && !(await waitForExit(this.process, 0))
          ) {
            this.#options.onEof();
          }
        },
        (error: unknown) => {
          if (!this.#retiring) {
            this.#reportFailure({ kind: 'stdout', message: errorMessage(error) });
          }
        },
      );
    }

    const stderr = this.process.stderr;
    if (stderr && typeof stderr !== 'number') {
      this.#stderrReader = drainStderr(stderr, (chunk) => this.#recordStderr(chunk)).catch((error: unknown) => {
        if (!this.#retiring) {
          this.#reportFailure({ kind: 'stderr', message: errorMessage(error) });
        }
      });
    }

    void this.process.exited.then(
      async (exitCode: number) => {
        await this.#stderrReader;
        const stderr = this.stderrSummary();
        this.#options.onExit({
          exitCode,
          stderrBytes: stderr.bytes,
          stderrLines: stderr.lines,
          stderrRetainedBytes: stderr.retainedBytes,
          stderrTailDigest: stderr.tailDigest,
          stderrTruncated: stderr.truncated,
        });
      },
      (error: unknown) => this.#reportFailure({
        kind: 'stdout',
        message: `Claude CLI exit status failed: ${errorMessage(error)}`,
      }),
    );
  }

  #recordStderr(chunk: string): void {
    this.#stderrBytes += byteLength(chunk);
    this.#stderrLines += chunk.split('\n').length - 1;
    this.#stderrTail += chunk;
    if (byteLength(this.#stderrTail) > MAX_STDERR_TAIL_BYTES) {
      this.#stderrTail = Buffer.from(this.#stderrTail, 'utf8')
        .subarray(-MAX_STDERR_TAIL_BYTES)
        .toString('utf8');
    }
  }

  #recordStdoutNoise(): void {
    this.#stdoutNoiseCount += 1;
    if (this.#stdoutNoiseCount > 3) return;
    this.#options.logger.warn('Claude CLI emitted non-JSON stdout', {
      sessionId: this.#options.sessionId.slice(0, 8),
      processId: this.process.pid ?? null,
      occurrence: this.#stdoutNoiseCount,
    });
  }

  #reportFailure(failure: ClaudeTransportFailure): void {
    if (this.#failureReported) return;
    this.#failureReported = true;
    this.#options.onFailure(failure);
  }
}

export {
  MAX_STDERR_TAIL_BYTES,
  MAX_STDOUT_FRAME_BYTES,
  PROCESS_EXIT_GRACE_MS,
  PROCESS_EXIT_KILL_MS,
  PROCESS_EXIT_TERM_MS,
};
