import { EventEmitter } from 'events';
import { AcpRpcError } from './errors.js';
import { isJsonRpcId, type AcpJsonRpcId, type AcpJsonRpcMessage } from './protocol.js';

interface WritableProcessStdin {
  write(data: string | Uint8Array): number | void | Promise<number>;
  flush?(): number | Promise<number>;
  end?(): unknown;
}

function writeFrame(stdin: WritableProcessStdin, frame: string, confirm: boolean) {
  const written = stdin.write(frame);
  if (!confirm) return written;
  const flush = (bytes: number | void) => {
    if (bytes !== undefined && bytes !== Buffer.byteLength(frame)) throw new Error('Incomplete ACP frame write');
    return stdin.flush?.();
  };
  return written instanceof Promise ? written.then(flush) : flush(written);
}

export interface AcpProcess {
  stdin?: WritableProcessStdin | null;
  stdout?: ReadableStream<Uint8Array> | null;
  stderr?: ReadableStream<Uint8Array> | null;
  exited: Promise<number>;
  kill(signal?: 'SIGTERM' | 'SIGKILL'): void;
}

type PendingRequest = {
  settle: (reply: AcpReply<unknown>) => void;
  timer: ReturnType<typeof setTimeout> | null;
};

export type AcpReply<T> = { result: T } | { error: Error };

export interface AcpRequestOptions<T> {
  onSent?: () => void;
  // Runs at the wire boundary, before later frames in the same read can change session state.
  onReply?: (reply: AcpReply<T>) => void;
  outputDuringWrite?: 'hold' | 'stream';
  timeoutMs?: number;
}

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
const MAX_OUTPUT_DURING_SEND = 4 * 1024 * 1024;

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
    kill: signal => { process.kill(signal); },
  };
}

export class AcpTransport extends EventEmitter {
  #process: AcpProcess | null = null;
  #stdoutRead: Promise<unknown> | null = null;
  #nextId = 1;
  #pending = new Map<AcpJsonRpcId, PendingRequest>();
  #sendTimers = new Set<ReturnType<typeof setTimeout>>();
  #outputHolds = 0;
  #heldOutput: Array<() => void> = [];
  #heldBytes = 0;
  #releaseExit: (() => void) | null = null;
  #generation = 0;
  #spawn: NonNullable<AcpTransportOptions['spawn']>;
  #requestTimeoutMs: number;
  #exitCode: number | null = null;

  constructor(options: AcpTransportOptions = {}) {
    super();
    this.#spawn = options.spawn ?? defaultSpawn;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  get isConnected(): boolean {
    return this.#process !== null;
  }

  async connect(spec: AcpSpawnSpec): Promise<void> {
    if (this.#process) return;
    this.#exitCode = null;
    this.#process = this.#spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
    });
    void this.#readLines(this.#process, this.#process.stdout, line => this.#handleStdoutLine(line));
    void this.#readLines(this.#process, this.#process.stderr, line => this.emit('stderr', line));
    void this.#watchExit(this.#process.exited, ++this.#generation);
  }

  // `timeoutMs` overrides the transport default for one request; 0 disables it.
  async request<T>(
    method: string,
    params?: unknown,
    { onSent, onReply, outputDuringWrite, timeoutMs = this.#requestTimeoutMs }: AcpRequestOptions<T> = {},
  ): Promise<T> {
    const id = this.#nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = timeoutMs > 0
        ? setTimeout(() => {
          this.#settlePending(id, { error: new Error(`ACP request timed out after ${timeoutMs}ms: ${method}`) });
        }, timeoutMs)
        : null;
      timer?.unref?.();
      this.#pending.set(id, {
        settle(raw) {
          const reply = raw as AcpReply<T>;
          try {
            onReply?.({ ...reply });
          } catch (error) {
            reject(error);
            return;
          }
          if ('error' in reply) reject(reply.error);
          else resolve(reply.result);
        },
        timer,
      });
      try {
        this.#write({
          jsonrpc: '2.0',
          id,
          method,
          ...(params === undefined ? {} : { params }),
        }, onSent && (() => { if (this.#pending.has(id)) onSent(); }), outputDuringWrite);
      } catch (error) {
        this.#settlePending(id, { error: error instanceof Error ? error : new Error(String(error)) });
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
    this.#closeWithError(new Error('ACP transport closed'), 'SIGTERM');
  }

  #closeWithError(error: Error, signal: 'SIGTERM' | 'SIGKILL' = 'SIGKILL'): void {
    const process = this.#process;
    this.#disconnect(error);
    process?.kill(signal);
  }

  #disconnect(error: Error): void {
    for (const timer of this.#sendTimers) clearTimeout(timer);
    this.#sendTimers.clear();
    this.#outputHolds = 0;
    this.#takeHeldOutput();
    this.#rejectAllPending(error);
    this.#process = null;
    this.#stdoutRead = null;
  }

  onRpcMessage(cb: (message: AcpJsonRpcMessage) => void): () => void {
    this.on('rpc-message', cb);
    return () => this.off('rpc-message', cb);
  }

  onStderr(cb: (line: string) => void): () => void {
    this.on('stderr', cb);
    return () => this.off('stderr', cb);
  }

  // A listener attached after the process exited still hears of it, so a
  // watcher added after the last awaited reply cannot miss a death.
  onExit(cb: (exitCode: number) => void): () => void {
    const exitCode = this.#exitCode;
    if (exitCode !== null) {
      let detached = false;
      queueMicrotask(() => {
        if (!detached) cb(exitCode);
      });
      return () => { detached = true; };
    }
    this.on('exit', cb);
    return () => this.off('exit', cb);
  }

  #write(payload: AcpJsonRpcMessage, onSent?: () => void, outputDuringWrite: 'hold' | 'stream' = 'hold'): void {
    const process = this.#process;
    if (!process?.stdin) throw new Error('ACP transport stdin is unavailable');
    const onFailure = (error: Error) => {
      if (this.#process !== process) return;
      this.#closeWithError(error);
    };
    let flushed;
    try {
      flushed = writeFrame(process.stdin, `${JSON.stringify(payload)}\n`, onSent !== undefined);
    } catch (error) {
      onFailure(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
    if (!(flushed instanceof Promise)) {
      onSent?.();
      return;
    }
    if (!onSent) {
      void flushed.catch(onFailure);
      return;
    }
    const timer = setTimeout(() => onFailure(new Error('ACP frame write timed out')), this.#requestTimeoutMs || DEFAULT_REQUEST_TIMEOUT_MS);
    timer.unref?.();
    this.#sendTimers.add(timer);
    if (outputDuringWrite === 'hold') this.#outputHolds++;
    void flushed.then(() => {
      if (this.#process !== process) return;
      clearTimeout(timer);
      this.#sendTimers.delete(timer);
      if (outputDuringWrite === 'hold') this.#outputHolds--;
      onSent();
      if (this.#outputHolds) return;
      for (const deliver of this.#takeHeldOutput()) {
        if (this.#process !== process) break;
        deliver();
      }
    }).catch(onFailure);
  }

  #takeHeldOutput(): Array<() => void> {
    const output = this.#heldOutput;
    this.#heldOutput = [];
    this.#heldBytes = 0;
    this.#releaseExit?.();
    this.#releaseExit = null;
    return output;
  }

  async #readLines(process: AcpProcess, stream: AcpProcess['stdout'], receive: (line: string) => void): Promise<void> {
    if (!stream) return;
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    const stdout = stream === process.stdout;
    let buffer = '';

    const consume = (value?: Uint8Array) => {
      buffer += value ? decoder.decode(value, { stream: true }) : decoder.decode();
      const lines = buffer.split('\n');
      buffer = value ? lines.pop() ?? '' : '';
      for (const line of lines) {
        if (line.trim()) receive(line.trim());
      }
      if (!value && stdout && this.#process === process) {
        this.#closeWithError(new Error('ACP transport stdout closed'));
      }
    };

    try {
      while (this.#process === process) {
        const read = reader.read();
        if (stdout) this.#stdoutRead = read;
        const { done, value } = await read;
        if (this.#process !== process) break;
        // Drain both pipes; delay publication, not reads, until the prompt is acknowledged.
        if (this.#outputHolds) {
          this.#heldBytes += Math.max(value?.byteLength ?? 0, 64);
          if (this.#heldBytes > MAX_OUTPUT_DURING_SEND) throw new Error('ACP output exceeded the pending send buffer');
          this.#heldOutput.push(() => consume(value));
        } else consume(value);
        if (done) break;
      }
    } catch (error) {
      if (this.#process === process) this.#closeWithError(error instanceof Error ? error : new Error(String(error)));
    } finally {
      if (stdout && this.#process === process) this.#stdoutRead = null;
      reader.releaseLock();
    }
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
      const { message: detail, code, data } = message.error;
      this.#settlePending(message.id, { error: new AcpRpcError(detail, code, data) });
      return;
    }

    if (isJsonRpcId(message.id) && 'result' in message) {
      this.#settlePending(message.id, { result: message.result });
      return;
    }

    this.emit('rpc-message', message);
  }

  async #watchExit(exited: Promise<number>, generation: number): Promise<void> {
    const exitCode = await exited;
    // Drains already-readable protocol bytes, but never waits for a pipe a descendant kept open.
    while (generation === this.#generation && this.#stdoutRead && Bun.peek.status(this.#stdoutRead) === 'fulfilled') {
      await this.#stdoutRead;
    }
    if (generation !== this.#generation) return;
    // A bounded send still owns these bytes. Its flush publishes them in order or discards them on failure.
    if (this.#heldOutput.length) {
      await new Promise<void>(resolve => { this.#releaseExit = resolve; });
      if (generation !== this.#generation) return;
    }
    this.#exitCode = exitCode;
    this.#disconnect(new Error(`ACP transport process exited with code ${exitCode}`));
    this.emit('exit', exitCode);
  }

  #settlePending(id: AcpJsonRpcId, reply: AcpReply<unknown>): void {
    const pending = this.#pending.get(id);
    if (!pending) return;
    this.#pending.delete(id);
    if (pending.timer) clearTimeout(pending.timer);
    pending.settle(reply);
  }

  #rejectAllPending(error: Error): void {
    for (const id of [...this.#pending.keys()]) {
      this.#settlePending(id, { error });
    }
  }
}
