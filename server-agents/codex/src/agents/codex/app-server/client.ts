import { EventEmitter } from 'events';
import { resolveCodexCli, type ResolvedCodexCli } from './cli.js';
import { parseThreadItemsListResponse, parseThreadTurnsListResponse } from './protocol.js';
import type {
  InitializeResponse,
  JsonRpcFailure,
  JsonRpcId,
  JsonRpcNotification,
  JsonRpcServerRequest,
  JsonRpcSuccess,
  ThreadListResponse,
  ThreadForkResponse,
  ThreadGoalClearResponse,
  ThreadGoalGetResponse,
  ThreadGoalSetResponse,
  ThreadInjectItemsParams,
  ThreadInjectItemsResponse,
  ThreadLoadedListResponse,
  ThreadItemsListParams,
  ThreadItemsListResponse,
  ThreadTurnsListParams,
  ThreadTurnsListResponse,
  ThreadResumeResponse,
  ThreadStartResponse,
  CodexThreadGoalStatus,
  ThreadUnsubscribeResponse,
  TurnStartResponse,
  TurnSteerResponse,
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
  kill(): void;
}

export type SpawnCodexAppServer = (
  command: string,
  args: string[],
  options: { env: Record<string, string> },
) => CodexAppServerProcess;

interface PendingRequest<T> {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  timeout?: ReturnType<typeof setTimeout>;
  deliveryOutcome?: 'unknown';
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

export class CodexAppServerDeliveryError extends Error {
  readonly safeMessage: string;

  constructor(
    public readonly outcome: 'not-sent' | 'unknown',
    cause: unknown,
  ) {
    super(
      outcome === 'unknown'
        ? 'Codex steering outcome could not be confirmed'
        : 'Codex steering input was not sent',
      { cause },
    );
    this.name = 'CodexAppServerDeliveryError';
    this.safeMessage = this.message;
  }
}

export interface CodexSteerRequestOptions {
  readonly prepareDelivery: () => Promise<void>;
  readonly acknowledgementTimeoutMs?: number;
}

export const CODEX_STEER_ACKNOWLEDGEMENT_TIMEOUT_MS = 15_000;

export interface CodexAppServerClientOptions {
  env?: Record<string, string>;
  spawn?: SpawnCodexAppServer;
  resolveCli?: () => Promise<ResolvedCodexCli>;
  resolveCommand?: () => Promise<string>;
  clientVersion?: () => string;
  shutdownGraceMs?: number;
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
  const process = Bun.spawn([command, ...args], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env: options.env,
  });
  return {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    exited: process.exited,
    kill: () => { process.kill(); },
  };
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
  #clientVersion: () => string;
  #shutdownGraceMs: number;
  #shutdownPromise: Promise<void> | null = null;

  constructor(options: CodexAppServerClientOptions = {}) {
    super();
    const resolveCommand = options.resolveCommand;
    this.#spawn = options.spawn ?? defaultSpawnCodexAppServer;
    this.#resolveCli = options.resolveCli
      ?? (resolveCommand
        ? async () => ({ command: await resolveCommand(), source: 'path' })
        : resolveCodexCli);
    this.#env = mergedEnv(options.env);
    this.#clientVersion = options.clientVersion ?? (() => '0.1.0');
    this.#shutdownGraceMs = options.shutdownGraceMs ?? 2_000;
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
    return this.#withRequestMetric(method, () => this.#sendRequest<T>(method, params));
  }

  async #withRequestMetric<T>(method: string, operation: () => Promise<T>): Promise<T> {
    const startedAt = performance.now();
    try {
      const result = await operation();
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

  respond(id: JsonRpcId, result: unknown): void {
    this.#write({ id, result });
  }

  reject(id: JsonRpcId, code: number, message: string): void {
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

  setThreadGoal(
    threadId: string,
    params: { objective?: string; status?: CodexThreadGoalStatus; tokenBudget?: number | null },
  ): Promise<ThreadGoalSetResponse> {
    return this.request<ThreadGoalSetResponse>('thread/goal/set', {
      threadId,
      ...params,
    });
  }

  setThreadGoalStatus(threadId: string, status: CodexThreadGoalStatus): Promise<ThreadGoalSetResponse> {
    return this.setThreadGoal(threadId, { status });
  }

  getThreadGoal(threadId: string): Promise<ThreadGoalGetResponse> {
    return this.request<ThreadGoalGetResponse>('thread/goal/get', { threadId });
  }

  clearThreadGoal(threadId: string): Promise<ThreadGoalClearResponse> {
    return this.request<ThreadGoalClearResponse>('thread/goal/clear', { threadId });
  }

  injectThreadItems(params: ThreadInjectItemsParams): Promise<ThreadInjectItemsResponse> {
    return this.request<ThreadInjectItemsResponse>('thread/inject_items', params);
  }

  listThreads(params: Record<string, unknown>): Promise<ThreadListResponse> {
    return this.request<ThreadListResponse>('thread/list', params);
  }

  async listThreadTurns(params: ThreadTurnsListParams): Promise<ThreadTurnsListResponse> {
    const response = await this.request<unknown>('thread/turns/list', params);
    return parseThreadTurnsListResponse(response);
  }

  async listThreadItems(params: ThreadItemsListParams): Promise<ThreadItemsListResponse> {
    const response = await this.request<unknown>('thread/items/list', params);
    return parseThreadItemsListResponse(response);
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

  steerTurn(params: {
    threadId: string;
    expectedTurnId: string;
    input: Array<Record<string, unknown>>;
    clientUserMessageId?: string;
  }, options?: CodexSteerRequestOptions): Promise<TurnSteerResponse> {
    if (!options) return this.request<TurnSteerResponse>('turn/steer', params);
    return this.#strictSteerRequest(params, options);
  }

  async #strictSteerRequest(
    params: {
      threadId: string;
      expectedTurnId: string;
      input: Array<Record<string, unknown>>;
      clientUserMessageId?: string;
    },
    options: CodexSteerRequestOptions,
  ): Promise<TurnSteerResponse> {
    await this.connect();
    return this.#withRequestMetric(
      'turn/steer',
      () => this.#sendStrictRequest<TurnSteerResponse>('turn/steer', params, options),
    );
  }

  interruptTurn(threadId: string, turnId: string): Promise<Record<string, never>> {
    return this.request<Record<string, never>>('turn/interrupt', { threadId, turnId });
  }

  // Triggers native context compaction. The app-server runs a compaction turn
  // whose lifecycle and contextCompaction item arrive via notifications.
  compactThread(threadId: string): Promise<Record<string, never>> {
    return this.request<Record<string, never>>('thread/compact/start', { threadId });
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
        version: this.#clientVersion(),
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

  async #sendStrictRequest<T>(
    method: string,
    params: unknown,
    options: CodexSteerRequestOptions,
  ): Promise<T> {
    const id = this.#nextId++;
    let frame: string;
    try {
      frame = `${JSON.stringify({ id, method, params })}\n`;
    } catch (error) {
      throw new CodexAppServerDeliveryError('not-sent', error);
    }
    const stdin = this.#proc?.stdin;
    if (!stdin) {
      throw new CodexAppServerDeliveryError(
        'not-sent',
        new Error('Codex app-server stdin is unavailable'),
      );
    }

    await options.prepareDelivery();
    const promise = new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = this.#pending.get(id);
        if (!pending) return;
        this.#pending.delete(id);
        pending.reject(new CodexAppServerDeliveryError(
          'unknown',
          new Error('Codex steering acknowledgement timed out'),
        ));
      }, options.acknowledgementTimeoutMs ?? CODEX_STEER_ACKNOWLEDGEMENT_TIMEOUT_MS);
      this.#pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timeout,
        deliveryOutcome: 'unknown',
      });
    });

    try {
      stdin.write(frame);
    } catch (error) {
      this.#clearPendingRequest(id);
      throw new CodexAppServerDeliveryError('unknown', error);
    }
    return promise;
  }

  #clearPendingRequest(id: number): PendingRequest<unknown> | undefined {
    const pending = this.#pending.get(id);
    this.#pending.delete(id);
    if (pending?.timeout) clearTimeout(pending.timeout);
    return pending;
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
      const pending = this.#clearPendingRequest(obj.id);
      if (!pending) {
        this.emit('warning', `Ignoring late Codex app-server response: ${success.id}`);
        return;
      }
      pending.resolve(success.result);
      return;
    }

    if (typeof obj.id === 'number' && 'error' in obj) {
      const failure = message as JsonRpcFailure;
      const pending = this.#clearPendingRequest(obj.id);
      if (!pending) {
        this.emit('warning', `Ignoring late Codex app-server response: ${failure.id}`);
        return;
      }
      pending.reject(new CodexAppServerRpcError(
        failure.error.message,
        failure.error.code,
        failure.error.data,
      ));
      return;
    }

    if ((typeof obj.id === 'number' || typeof obj.id === 'string') && typeof obj.method === 'string') {
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
    for (const pending of this.#pending.values()) {
      if (pending.timeout) clearTimeout(pending.timeout);
      pending.reject(pending.deliveryOutcome
        ? new CodexAppServerDeliveryError(pending.deliveryOutcome, error)
        : error);
    }
    this.#pending.clear();
    this.#proc = null;
    this.#ready = null;
    this.emit('exit', code);
  }

  async shutdown(): Promise<void> {
    if (this.#shutdownPromise) return this.#shutdownPromise;
    const proc = this.#proc;
    this.#proc = null;
    this.#ready = null;
    if (!proc) return;

    const shutdown = (async () => {
      try {
        // Codex closes its sole stdio connection on EOF, then shuts down loaded
        // threads and their persistence writers before exiting.
        // https://github.com/openai/codex/blob/5d1fbf26c43abc65a203928b2e31561cb039e06d/codex-rs/app-server-transport/src/transport/stdio.rs#L43-L79
        // https://github.com/openai/codex/blob/5d1fbf26c43abc65a203928b2e31561cb039e06d/codex-rs/app-server/src/lib.rs#L1156-L1165
        // https://github.com/openai/codex/blob/5d1fbf26c43abc65a203928b2e31561cb039e06d/codex-rs/core/src/session/handlers.rs#L648-L667
        proc.stdin?.end?.();
        await Promise.race([
          proc.exited.then(() => undefined),
          Bun.sleep(this.#shutdownGraceMs),
        ]);
      } finally {
        proc.kill();
      }
    })();
    this.#shutdownPromise = shutdown;
    try {
      await shutdown;
    } finally {
      if (this.#shutdownPromise === shutdown) this.#shutdownPromise = null;
    }
  }
}
