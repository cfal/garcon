import { AgentEventEmitterRuntime } from '../shared/event-emitter-runtime.js';
import type {
  ResumeTurnRequest,
  StartSessionRequest,
  StartedAgentSession,
} from '../session-types.js';
import type { AgentRuntime } from '../types.js';

type PiRuntime = AgentRuntime & {
  startPurgeTimer(): void;
  shutdown(): void;
};

export type PiRuntimeLoader = () => Promise<PiRuntime>;

interface PendingRuntimeOperation {
  agentSessionId: string | null;
  cancelled: boolean;
}

function loadPiRuntime(): Promise<PiRuntime> {
  return import('./pi-cli.js').then(({ PiCliRuntime }) => new PiCliRuntime());
}

export class LazyPiRuntime extends AgentEventEmitterRuntime implements AgentRuntime {
  readonly #loadRuntime: PiRuntimeLoader;
  #runtime: PiRuntime | null = null;
  #runtimePromise: Promise<PiRuntime> | null = null;
  readonly #pendingOperations = new Set<PendingRuntimeOperation>();
  #purgeTimerRequested = false;
  #shutdownRequested = false;

  constructor(loadRuntime: PiRuntimeLoader = loadPiRuntime) {
    super();
    this.#loadRuntime = loadRuntime;
  }

  async startSession(request: StartSessionRequest): Promise<StartedAgentSession> {
    return this.#runAfterLoad(null, (runtime) => runtime.startSession(request));
  }

  async runTurn(request: ResumeTurnRequest): Promise<void> {
    return this.#runAfterLoad(request.agentSessionId, (runtime) => runtime.runTurn(request));
  }

  abort(agentSessionId: string): boolean | Promise<boolean> {
    const pendingCancelled = this.#cancelPendingOperations(agentSessionId);
    const runtimeAbort = this.#runtime?.abort(agentSessionId);
    if (runtimeAbort === undefined) return pendingCancelled;
    if (typeof runtimeAbort === 'boolean') return pendingCancelled || runtimeAbort;
    return runtimeAbort.then((aborted) => pendingCancelled || aborted);
  }

  isRunning(agentSessionId: string): boolean {
    return this.#runtime?.isRunning(agentSessionId) ?? false;
  }

  getRunningSessions(): Array<{ id: string; status?: string; startedAt?: string }> {
    return this.#runtime?.getRunningSessions() ?? [];
  }

  startPurgeTimer(): void {
    this.#purgeTimerRequested = true;
    this.#runtime?.startPurgeTimer();
  }

  shutdown(): void {
    this.#shutdownRequested = true;
    this.#cancelPendingOperations();
    this.#runtime?.shutdown();
  }

  async #runAfterLoad<T>(
    agentSessionId: string | null,
    operation: (runtime: PiRuntime) => Promise<T>,
  ): Promise<T> {
    if (this.#shutdownRequested) throw this.#cancelledOperationError();

    const pending: PendingRuntimeOperation = { agentSessionId, cancelled: false };
    this.#pendingOperations.add(pending);
    let runtime: PiRuntime;
    try {
      runtime = await this.#getRuntime();
      if (pending.cancelled || this.#shutdownRequested) {
        throw this.#cancelledOperationError();
      }
    } finally {
      this.#pendingOperations.delete(pending);
    }
    return operation(runtime);
  }

  #cancelPendingOperations(agentSessionId?: string): boolean {
    let cancelled = false;
    for (const operation of this.#pendingOperations) {
      if (agentSessionId !== undefined && operation.agentSessionId !== agentSessionId) continue;
      operation.cancelled = true;
      cancelled = true;
    }
    return cancelled;
  }

  #cancelledOperationError(): Error {
    const error = new Error('Pi runtime operation cancelled before initialization');
    error.name = 'AbortError';
    return error;
  }

  async #getRuntime(): Promise<PiRuntime> {
    if (this.#runtime) return this.#runtime;
    if (this.#runtimePromise) return this.#runtimePromise;

    this.#runtimePromise = this.#loadRuntime().then((runtime) => {
      this.#runtime = runtime;
      runtime.onMessages((chatId, messages, metadata) =>
        this.emitMessages(chatId, messages, metadata),
      );
      runtime.onProcessing((chatId, isProcessing) =>
        this.emitProcessing(chatId, isProcessing),
      );
      runtime.onSessionCreated((chatId) => this.emitSessionCreated(chatId));
      runtime.onFinished((chatId, exitCode, metadata) =>
        this.emitFinished(chatId, exitCode, metadata),
      );
      runtime.onFailed((chatId, message, metadata) => this.emitFailed(chatId, message, metadata));
      if (this.#purgeTimerRequested) runtime.startPurgeTimer();
      if (this.#shutdownRequested) runtime.shutdown();
      return runtime;
    });

    try {
      return await this.#runtimePromise;
    } catch (error) {
      this.#runtimePromise = null;
      throw error;
    }
  }
}
