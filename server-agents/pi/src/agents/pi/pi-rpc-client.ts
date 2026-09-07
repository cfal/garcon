// Handles one long-lived `pi --mode rpc` process. Records split on LF rather than Unicode
// line separators, and command responses correlate by id because Pi dispatches concurrently.

export interface PiRpcResponse {
  readonly id: string;
  readonly command: string;
  readonly success: boolean;
  readonly error?: string;
  readonly data?: Record<string, unknown>;
}

export class PiRpcCommandError extends Error {
  readonly command: string;

  constructor(response: PiRpcResponse) {
    super(response.error ?? `Pi rejected the ${response.command} command`);
    this.name = 'PiRpcCommandError';
    this.command = response.command;
  }
}

export class PiRpcTransportError extends Error {
  readonly writeAttempted: boolean;

  constructor(message: string, writeAttempted: boolean) {
    super(message);
    this.name = 'PiRpcTransportError';
    this.writeAttempted = writeAttempted;
  }
}

interface PendingRequest {
  readonly command: string;
  resolve(response: PiRpcResponse): void;
  reject(error: unknown): void;
  timer: ReturnType<typeof setTimeout> | null;
  writeAttempted: boolean;
}

export interface PiRpcClientOptions {
  onEvent(event: Record<string, unknown>): void;
  onMalformed(line: string): void;
}

const DEFAULT_RESPONSE_TIMEOUT_MS = 15_000;

export class PiRpcClient {
  readonly #proc: ReturnType<typeof Bun.spawn>;
  readonly #options: PiRpcClientOptions;
  readonly #pending = new Map<string, PendingRequest>();
  #writer: Promise<void> = Promise.resolve();
  #nextId = 0;
  #disposed = false;
  #buffer = '';
  readonly exited: Promise<number>;

  constructor(proc: ReturnType<typeof Bun.spawn>, options: PiRpcClientOptions) {
    this.#proc = proc;
    this.#options = options;
    this.exited = proc.exited.then((code) => {
      this.#disposed = true;
      this.#failPending((pending) => new PiRpcTransportError(
        `Pi process exited with code ${code}`,
        pending.writeAttempted,
      ));
      return code;
    });
    void this.#readStdout();
  }

  // Sends a correlated command with a bounded response timeout.
  async send(
    command: Record<string, unknown>,
    timeoutMs: number = DEFAULT_RESPONSE_TIMEOUT_MS,
  ): Promise<PiRpcResponse> {
    return this.#send(command, timeoutMs);
  }

  // Leaves prompt preflight unbounded because it can run a full compaction call.
  async sendUnbounded(command: Record<string, unknown>): Promise<PiRpcResponse> {
    return this.#send(command, null);
  }

  // Rejects pending requests and prevents later sends.
  dispose(reason: string): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#failPending((pending) => new PiRpcTransportError(reason, pending.writeAttempted));
  }

  #send(
    command: Record<string, unknown>,
    timeoutMs: number | null,
  ): Promise<PiRpcResponse> {
    if (this.#disposed) {
      return Promise.reject(new PiRpcTransportError('Pi RPC client is disposed', false));
    }
    const id = `garcon-${++this.#nextId}`;
    const pending: PendingRequest = {
      command: String(command.type ?? 'unknown'),
      resolve: () => undefined,
      reject: () => undefined,
      timer: null,
      writeAttempted: false,
    };
    const response = new Promise<PiRpcResponse>((resolve, reject) => {
      pending.resolve = resolve;
      pending.reject = reject;
    });
    void response.catch(() => undefined);
    this.#pending.set(id, pending);
    void this.#writeLine(id, `${JSON.stringify({ ...command, id })}\n`, pending).then(() => {
      if (timeoutMs === null || !this.#pending.has(id)) return;
      pending.timer = setTimeout(() => {
        if (!this.#pending.has(id)) return;
        this.#pending.delete(id);
        pending.reject(new PiRpcTransportError(
          `Pi ${pending.command} response timed out after ${timeoutMs}ms`,
          pending.writeAttempted,
        ));
      }, timeoutMs);
    }, (error) => {
      if (!this.#pending.has(id)) return;
      this.#dropPending(id);
      pending.reject(new PiRpcTransportError(
        error instanceof Error ? error.message : String(error),
        pending.writeAttempted,
      ));
    });
    return response;
  }

  #dropPending(id: string): void {
    const pending = this.#pending.get(id);
    if (!pending) return;
    if (pending.timer) clearTimeout(pending.timer);
    this.#pending.delete(id);
  }

  #failPending(errorFor: (pending: PendingRequest) => unknown): void {
    for (const [id, pending] of this.#pending) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(errorFor(pending));
      this.#pending.delete(id);
    }
  }

  // Serializes stdin writes so concurrent commands cannot interleave partial lines.
  #writeLine(id: string, line: string, pending: PendingRequest): Promise<void> {
    const previous = this.#writer;
    let release!: () => void;
    this.#writer = new Promise<void>((resolve) => {
      release = resolve;
    });
    return previous.then(async () => {
      try {
        if (!this.#pending.has(id)) return;
        const stdin = this.#proc.stdin;
        if (!stdin || typeof stdin === 'number') {
          throw new Error('Pi process stdin is unavailable');
        }
        if (this.#proc.killed || this.#disposed) {
          throw new Error('Pi process is not writable');
        }
        pending.writeAttempted = true;
        stdin.write(line);
        await stdin.flush();
      } finally {
        release();
      }
    });
  }

  async #readStdout(): Promise<void> {
    const stdout = this.#proc.stdout;
    if (!stdout) return;
    const decoder = new TextDecoder();
    try {
      const reader = (stdout as ReadableStream<Uint8Array>).getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        this.#buffer += decoder.decode(value, { stream: true });
        let newline = this.#buffer.indexOf('\n');
        while (newline >= 0) {
          const line = this.#buffer.slice(0, newline).replace(/\r$/, '');
          this.#buffer = this.#buffer.slice(newline + 1);
          this.#handleLine(line);
          newline = this.#buffer.indexOf('\n');
        }
      }
      const tail = `${this.#buffer}${decoder.decode()}`;
      this.#buffer = '';
      if (tail.trim()) this.#handleLine(tail.replace(/\r$/, ''));
    } catch {
      // Stream closed; the exit handler settles pending requests.
    }
  }

  #handleLine(line: string): void {
    if (!line.trim()) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.#options.onMalformed(line);
      return;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      this.#options.onMalformed(line);
      return;
    }
    const record = parsed as Record<string, unknown>;
    if (record.type === 'response' && typeof record.id === 'string') {
      const pending = this.#pending.get(record.id);
      // Unknown ids (late responses after timeout/dispose) and duplicates are dropped.
      if (!pending) return;
      this.#dropPending(record.id);
      const response: PiRpcResponse = {
        id: record.id,
        command: typeof record.command === 'string' ? record.command : pending.command,
        success: record.success === true,
        ...(typeof record.error === 'string' ? { error: record.error } : {}),
        ...(record.data && typeof record.data === 'object' && !Array.isArray(record.data)
          ? { data: record.data as Record<string, unknown> }
          : {}),
      };
      if (response.success) {
        pending.resolve(response);
      } else {
        pending.reject(new PiRpcCommandError(response));
      }
      return;
    }
    this.#options.onEvent(record);
  }
}
