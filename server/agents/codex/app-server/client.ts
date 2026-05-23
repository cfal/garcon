import { EventEmitter } from 'events';
import { resolveCodexCli, type ResolvedCodexCli } from './cli.js';
import type {
  InitializeResponse,
  JsonRpcFailure,
  JsonRpcNotification,
  JsonRpcServerRequest,
  JsonRpcSuccess,
  ThreadListResponse,
  ThreadForkResponse,
  ThreadLoadedListResponse,
  ThreadReadResponse,
  ThreadResumeResponse,
  ThreadStartResponse,
  ThreadUnsubscribeResponse,
  TurnStartResponse,
} from './protocol.js';

interface WritableProcessStdin {
  write(data: string | Uint8Array): unknown;
  end?(): unknown;
}

export interface CodexAppServerProcess {
  stdin?: WritableProcessStdin | null;
  stdout?: ReadableStream<Uint8Array> | null;
  stderr?: ReadableStream<Uint8Array> | null;
  exited: Promise<number>;
  kill(signal?: string): void;
}

export type SpawnCodexAppServer = (
  command: string,
  args: string[],
  options: { env: Record<string, string> },
) => CodexAppServerProcess;

interface PendingRequest<T> {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

export class CodexAppServerRpcError extends Error {
  constructor(
    message: string,
    public readonly code: number,
    public readonly data?: unknown,
  ) {
    super(message);
  }
}

export interface CodexAppServerClientOptions {
  env?: Record<string, string>;
  spawn?: SpawnCodexAppServer;
  resolveCli?: () => Promise<ResolvedCodexCli>;
  resolveCommand?: () => Promise<string>;
}

export interface CodexAppServerMetric {
  name: 'codex.app_server.startup' | 'codex.app_server.request' | 'codex.app_server.loaded_threads';
  durationMs?: number;
  method?: string;
  success?: boolean;
  loadedThreadCount?: number;
  commandSource?: ResolvedCodexCli['source'];
}

function defaultSpawnCodexAppServer(
  command: string,
  args: string[],
  options: { env: Record<string, string> },
): CodexAppServerProcess {
  return Bun.spawn([command, ...args], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env: options.env,
  }) as unknown as CodexAppServerProcess;
}

function mergedEnv(overrides?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...(overrides ?? {}) };
}

export class CodexAppServerClient extends EventEmitter {
  #proc: CodexAppServerProcess | null = null;
  #nextId = 1;
  #pending = new Map<number, PendingRequest<unknown>>();
  #ready: Promise<InitializeResponse> | null = null;
  #spawn: SpawnCodexAppServer;
  #resolveCli: () => Promise<ResolvedCodexCli>;
  #env: Record<string, string>;

  constructor(options: CodexAppServerClientOptions = {}) {
    super();
    const resolveCommand = options.resolveCommand;
    this.#spawn = options.spawn ?? defaultSpawnCodexAppServer;
    this.#resolveCli = options.resolveCli
      ?? (resolveCommand
        ? async () => ({ command: await resolveCommand(), source: 'path' })
        : resolveCodexCli);
    this.#env = mergedEnv(options.env);
  }

  async connect(): Promise<InitializeResponse> {
    if (this.#ready) return this.#ready;
    this.#ready = this.#start().catch((error) => {
      this.#ready = null;
      throw error;
    });
    return this.#ready;
  }

  async request<T>(method: string, params?: unknown): Promise<T> {
    await this.connect();
    const startedAt = performance.now();
    try {
      const result = await this.#sendRequest<T>(method, params);
      this.#emitMetric({
        name: 'codex.app_server.request',
        method,
        durationMs: Math.round(performance.now() - startedAt),
        success: true,
      });
      return result;
    } catch (error) {
      this.#emitMetric({
        name: 'codex.app_server.request',
        method,
        durationMs: Math.round(performance.now() - startedAt),
        success: false,
      });
      throw error;
    }
  }

  notify(method: string, params?: unknown): void {
    this.#write(params === undefined ? { method } : { method, params });
  }

  respond(id: number, result: unknown): void {
    this.#write({ id, result });
  }

  reject(id: number, code: number, message: string): void {
    this.#write({ id, error: { code, message } });
  }

  startThread(params: Record<string, unknown>): Promise<ThreadStartResponse> {
    return this.request<ThreadStartResponse>('thread/start', params);
  }

  resumeThread(params: Record<string, unknown>): Promise<ThreadResumeResponse> {
    return this.request<ThreadResumeResponse>('thread/resume', params);
  }

  forkThread(params: Record<string, unknown>): Promise<ThreadForkResponse> {
    return this.request<ThreadForkResponse>('thread/fork', params);
  }

  readThread(threadId: string, includeTurns: boolean): Promise<ThreadReadResponse> {
    return this.request<ThreadReadResponse>('thread/read', { threadId, includeTurns });
  }

  listThreads(params: Record<string, unknown>): Promise<ThreadListResponse> {
    return this.request<ThreadListResponse>('thread/list', params);
  }

  loadedThreads(): Promise<ThreadLoadedListResponse> {
    return this.request<ThreadLoadedListResponse>('thread/loaded/list', {});
  }

  unsubscribeThread(threadId: string): Promise<ThreadUnsubscribeResponse> {
    return this.request<ThreadUnsubscribeResponse>('thread/unsubscribe', { threadId });
  }

  startTurn(params: Record<string, unknown>): Promise<TurnStartResponse> {
    return this.request<TurnStartResponse>('turn/start', params);
  }

  interruptTurn(threadId: string, turnId: string): Promise<Record<string, never>> {
    return this.request<Record<string, never>>('turn/interrupt', { threadId, turnId });
  }

  async #start(): Promise<InitializeResponse> {
    const startedAt = performance.now();
    const resolved = await this.#resolveCli();
    this.#proc = this.#spawn(resolved.command, ['app-server', '--listen', 'stdio://'], { env: this.#env });

    void this.#readStdout(this.#proc.stdout ?? null);
    void this.#readStderr(this.#proc.stderr ?? null);
    void this.#watchExit(this.#proc.exited);

    const initialized = await this.#sendRequest<InitializeResponse>('initialize', {
      clientInfo: {
        name: 'garcon',
        title: 'Garcon',
        version: process.env.npm_package_version ?? '0.1.0',
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
      },
    });
    this.#emitMetric({
      name: 'codex.app_server.startup',
      durationMs: Math.round(performance.now() - startedAt),
      commandSource: resolved.source,
    });
    this.notify('initialized');
    return initialized;
  }

  #emitMetric(metric: CodexAppServerMetric): void {
    this.emit('metric', metric);
  }

  #sendRequest<T>(method: string, params?: unknown): Promise<T> {
    const id = this.#nextId++;
    const payload = params === undefined ? { id, method } : { id, method, params };
    const promise = new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
    });
    try {
      this.#write(payload);
    } catch (error) {
      this.#pending.delete(id);
      throw error;
    }
    return promise;
  }

  #write(payload: unknown): void {
    const stdin = this.#proc?.stdin;
    if (!stdin) throw new Error('Codex app-server stdin is unavailable');
    stdin.write(`${JSON.stringify(payload)}\n`);
  }

  async #readStdout(stream: ReadableStream<Uint8Array> | null): Promise<void> {
    if (!stream) return;
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (line.trim()) this.#handleLine(line.trim());
        }
      }
    } catch (error) {
      this.emit('warning', `Codex app-server stdout read failed: ${(error as Error).message}`);
    }
  }

  #handleLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.emit('warning', `Invalid Codex app-server JSON: ${(error as Error).message}`);
      return;
    }

    if (!message || typeof message !== 'object') return;
    const obj = message as Record<string, unknown>;

    if (typeof obj.id === 'number' && 'result' in obj) {
      const success = message as JsonRpcSuccess;
      const pending = this.#pending.get(success.id);
      this.#pending.delete(success.id);
      pending?.resolve(success.result);
      return;
    }

    if (typeof obj.id === 'number' && 'error' in obj) {
      const failure = message as JsonRpcFailure;
      const pending = this.#pending.get(failure.id);
      this.#pending.delete(failure.id);
      pending?.reject(new CodexAppServerRpcError(
        failure.error.message,
        failure.error.code,
        failure.error.data,
      ));
      return;
    }

    if (typeof obj.id === 'number' && typeof obj.method === 'string') {
      this.emit('serverRequest', message as JsonRpcServerRequest);
      return;
    }

    if (typeof obj.method === 'string') {
      this.emit('notification', message as JsonRpcNotification);
    }
  }

  async #readStderr(stream: ReadableStream<Uint8Array> | null): Promise<void> {
    if (!stream) return;
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        for (const line of text.split('\n')) {
          if (line.trim()) this.emit('stderr', line);
        }
      }
    } catch {
      // The process may close stderr during shutdown.
    }
  }

  async #watchExit(exited: Promise<number>): Promise<void> {
    const code = await exited;
    const error = new Error(`Codex app-server exited with code ${code}`);
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    this.#proc = null;
    this.#ready = null;
    this.emit('exit', code);
  }

  shutdown(): void {
    this.#proc?.kill();
    this.#proc = null;
    this.#ready = null;
  }
}
