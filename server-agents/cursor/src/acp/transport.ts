import { EventEmitter } from 'events';
import { AcpRpcError } from './errors.js';
import type { AcpJsonRpcId, AcpJsonRpcMessage } from './protocol.js';

interface WritableProcessStdin {
  write(data: string | Uint8Array): unknown;
  end?(): unknown;
}

interface AcpProcess {
  stdin?: WritableProcessStdin | null;
  stdout?: ReadableStream<Uint8Array> | null;
  stderr?: ReadableStream<Uint8Array> | null;
  exited: Promise<number>;
  kill(): void;
}

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
};

export interface AcpSpawnSpec {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
}

export interface AcpTransportOptions {
  spawn?: (command: string, args: string[], options: { cwd: string; env: Record<string, string | undefined> }) => AcpProcess;
  requestTimeoutMs?: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

function isJsonRpcId(value: unknown): value is AcpJsonRpcId {
  return typeof value === 'number' || typeof value === 'string';
}

function defaultSpawn(command: string, args: string[], options: { cwd: string; env: Record<string, string | undefined> }): AcpProcess {
  const process = Bun.spawn([command, ...args], {
    cwd: options.cwd,
    env: options.env,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    exited: process.exited,
    kill: () => { process.kill(); },
  };
}

export class AcpTransport extends EventEmitter {
  #process: AcpProcess | null = null;
  #nextId = 1;
  #pending = new Map<AcpJsonRpcId, PendingRequest>();
  #spawn: NonNullable<AcpTransportOptions['spawn']>;
  #requestTimeoutMs: number;

  constructor(options: AcpTransportOptions = {}) {
    super();
    this.#spawn = options.spawn ?? defaultSpawn;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  async connect(spec: AcpSpawnSpec): Promise<void> {
    if (this.#process) return;
    this.#process = this.#spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
    });
    void this.#readStdout(this.#process.stdout ?? null);
    void this.#readStderr(this.#process.stderr ?? null);
    void this.#watchExit(this.#process.exited);
  }

  async request<T>(method: string, params?: unknown): Promise<T> {
    const id = this.#nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = this.#requestTimeoutMs > 0
        ? setTimeout(() => {
          this.#rejectPending(id, new Error(`ACP request timed out after ${this.#requestTimeoutMs}ms: ${method}`));
        }, this.#requestTimeoutMs)
        : null;
      timer?.unref?.();
      this.#pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      try {
        this.#write({
          jsonrpc: '2.0',
          id,
          method,
          ...(params === undefined ? {} : { params }),
        });
      } catch (error) {
        this.#rejectPending(id, error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  notify(method: string, params?: unknown): void {
    this.#write({
      jsonrpc: '2.0',
      method,
      ...(params === undefined ? {} : { params }),
    });
  }

  respond(id: AcpJsonRpcId, result: unknown): void {
    this.#write({
      jsonrpc: '2.0',
      id,
      result,
    });
  }

  respondError(id: AcpJsonRpcId, code: number, message: string, data?: unknown): void {
    this.#write({
      jsonrpc: '2.0',
      id,
      error: {
        code,
        message,
        ...(data === undefined ? {} : { data }),
      },
    });
  }

  close(): void {
    this.#rejectAllPending(new Error('ACP transport closed'));
    this.#process?.kill();
    this.#process = null;
  }

  onRpcMessage(cb: (message: AcpJsonRpcMessage) => void): void {
    this.on('rpc-message', cb);
  }

  onStderr(cb: (line: string) => void): void {
    this.on('stderr', cb);
  }

  onExit(cb: (exitCode: number) => void): void {
    this.on('exit', cb);
  }

  #write(payload: AcpJsonRpcMessage): void {
    const stdin = this.#process?.stdin;
    if (!stdin) throw new Error('ACP transport stdin is unavailable');
    stdin.write(`${JSON.stringify(payload)}\n`);
  }

  async #readStdout(stream: ReadableStream<Uint8Array> | null): Promise<void> {
    if (!stream) return;
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        this.#handleStdoutLine(line.trim());
      }
    }

    buffer += decoder.decode();
    if (buffer.trim()) this.#handleStdoutLine(buffer.trim());
  }

  #handleStdoutLine(line: string): void {
    let message: AcpJsonRpcMessage;
    try {
      message = JSON.parse(line) as AcpJsonRpcMessage;
    } catch (error) {
      this.emit('stderr', `ACP transport received invalid JSON: ${(error as Error).message}`);
      return;
    }

    if (isJsonRpcId(message.id) && 'error' in message && message.error) {
      this.#rejectPending(message.id, new AcpRpcError(
        message.error.message,
        message.error.code,
        message.error.data,
      ));
      return;
    }

    if (isJsonRpcId(message.id) && 'result' in message) {
      this.#resolvePending(message.id, message.result);
      return;
    }

    this.emit('rpc-message', message);
  }

  async #readStderr(stream: ReadableStream<Uint8Array> | null): Promise<void> {
    if (!stream) return;
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        this.emit('stderr', line.trim());
      }
    }

    buffer += decoder.decode();
    if (buffer.trim()) this.emit('stderr', buffer.trim());
  }

  async #watchExit(exited: Promise<number>): Promise<void> {
    const exitCode = await exited;
    this.#process = null;
    const error = new Error(`ACP transport process exited with code ${exitCode}`);
    this.#rejectAllPending(error);
    this.emit('exit', exitCode);
  }

  #takePending(id: AcpJsonRpcId): PendingRequest | null {
    const pending = this.#pending.get(id);
    if (!pending) return null;
    this.#pending.delete(id);
    if (pending.timer) clearTimeout(pending.timer);
    pending.timer = null;
    return pending;
  }

  #resolvePending(id: AcpJsonRpcId, value: unknown): void {
    this.#takePending(id)?.resolve(value);
  }

  #rejectPending(id: AcpJsonRpcId, error: Error): void {
    this.#takePending(id)?.reject(error);
  }

  #rejectAllPending(error: Error): void {
    for (const id of [...this.#pending.keys()]) {
      this.#rejectPending(id, error);
    }
  }
}
