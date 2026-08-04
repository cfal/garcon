import { errorMessage } from '@garcon/server-agent-common/lib/errors';
import type { AgentLogger } from '@garcon/server-agent-interface';
import { OpenCodeTimeoutError } from './request-control.js';
import { streamGlobalEvents, type SSEEvent } from './sse-events.js';

interface OpenCodeGlobalEventListenerOptions {
  requestTimeoutMs: number;
  heartbeatTimeoutMs: number;
  retryDelayMs: number;
  logger: AgentLogger;
  getClient(): Promise<any>;
  isShuttingDown(): boolean;
  isTemporarilyUnavailable(): boolean;
  getUnavailableRetryAfterMs(): number;
  markTemporarilyUnavailable(reason: string): boolean;
  failRunningTurns(error: Error): void;
  closeUnavailableInstanceIfIdle(): boolean;
  handleEvent(client: any, event: SSEEvent): void;
}

// Owns readiness, liveness, and retry state for the single process-wide OpenCode event stream.
export class OpenCodeGlobalEventListener {
  readonly #options: OpenCodeGlobalEventListenerOptions;
  #started = false;
  #generation = 0;
  #readyPromise: Promise<void> | null = null;
  #rejectReady: ((error: Error) => void) | null = null;
  #abortController: AbortController | null = null;
  #retryTimer: ReturnType<typeof setTimeout> | null = null;
  #heartbeatTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: OpenCodeGlobalEventListenerOptions) {
    this.#options = options;
  }

  close(): void {
    this.#rejectReady?.(new Error('OpenCode event listener closed before it was ready'));
    this.#rejectReady = null;
    this.#readyPromise = null;
    this.#generation += 1;
    this.#abortController?.abort(new Error('OpenCode event listener closed'));
    this.#abortController = null;
    if (this.#retryTimer) clearTimeout(this.#retryTimer);
    this.#retryTimer = null;
    if (this.#heartbeatTimer) clearTimeout(this.#heartbeatTimer);
    this.#heartbeatTimer = null;
    this.#started = false;
  }

  async start(): Promise<void> {
    if (this.#retryTimer) clearTimeout(this.#retryTimer);
    this.#retryTimer = null;
    if (this.#started) {
      if (this.#readyPromise) await this.#readyPromise;
      return;
    }

    this.#started = true;
    const generation = ++this.#generation;
    const abortController = new AbortController();
    this.#abortController = abortController;
    let readySettled = false;
    let connected = false;
    let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    const readyPromise = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    this.#readyPromise = readyPromise;
    const settleReady = () => {
      if (readySettled) return;
      readySettled = true;
      clearTimeout(readyTimer);
      resolveReady();
      if (this.#readyPromise === readyPromise) {
        this.#readyPromise = null;
        this.#rejectReady = null;
      }
    };
    const settleNotReady = (error: Error) => {
      if (readySettled) return;
      readySettled = true;
      clearTimeout(readyTimer);
      rejectReady(error);
    };
    this.#rejectReady = settleNotReady;
    const clearHeartbeatWatchdog = () => {
      if (heartbeatTimer) clearTimeout(heartbeatTimer);
      if (this.#heartbeatTimer === heartbeatTimer) this.#heartbeatTimer = null;
      heartbeatTimer = null;
    };
    const armHeartbeatWatchdog = () => {
      clearHeartbeatWatchdog();
      heartbeatTimer = setTimeout(() => {
        if (generation !== this.#generation || this.#options.isShuttingDown()) return;
        abortController.abort(new OpenCodeTimeoutError(
          'OpenCode event stream heartbeat',
          this.#options.heartbeatTimeoutMs,
        ));
      }, this.#options.heartbeatTimeoutMs);
      heartbeatTimer.unref?.();
      this.#heartbeatTimer = heartbeatTimer;
    };
    const readyTimer = setTimeout(() => {
      const error = new OpenCodeTimeoutError(
        'OpenCode event stream readiness',
        this.#options.requestTimeoutMs,
      );
      abortController.abort(error);
      settleNotReady(error);
    }, this.#options.requestTimeoutMs);
    readyTimer.unref?.();

    void this.#run({
      generation,
      abortController,
      readyPromise,
      settleReady: () => {
        connected = true;
        settleReady();
        armHeartbeatWatchdog();
      },
      armHeartbeatWatchdog,
      settleNotReady,
      connected: () => connected,
      clearReadyTimer: () => clearTimeout(readyTimer),
      clearHeartbeatWatchdog,
    });
    await readyPromise;
  }

  async #run(input: {
    generation: number;
    abortController: AbortController;
    readyPromise: Promise<void>;
    settleReady(): void;
    armHeartbeatWatchdog(): void;
    settleNotReady(error: Error): void;
    connected(): boolean;
    clearReadyTimer(): void;
    clearHeartbeatWatchdog(): void;
  }): Promise<void> {
    try {
      const client = await this.#options.getClient();
      if (input.generation !== this.#generation) {
        throw new Error('OpenCode event listener was superseded during startup');
      }
      for await (const event of streamGlobalEvents(
        client,
        input.abortController.signal,
        input.settleReady,
      )) {
        if (input.generation !== this.#generation) return;
        input.armHeartbeatWatchdog();
        this.#options.handleEvent(client, event);
      }
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      input.settleNotReady(failure);
      if (input.generation !== this.#generation) return;
      if (!input.connected() || failure instanceof OpenCodeTimeoutError) {
        const reason = errorMessage(failure);
        if (this.#options.markTemporarilyUnavailable(reason)) {
          this.#options.logger.warn('OpenCode event stream marked the runtime unavailable', { reason });
        }
      }
      if (input.generation !== this.#generation) return;
      this.#options.failRunningTurns(failure);
      if (
        this.#options.isTemporarilyUnavailable()
        && this.#options.closeUnavailableInstanceIfIdle()
      ) return;
      const retryMs = this.#options.isTemporarilyUnavailable()
        ? Math.max(
          this.#options.retryDelayMs,
          Math.min(this.#options.getUnavailableRetryAfterMs(), 30_000),
        )
        : this.#options.retryDelayMs;
      this.#options.logger.error('OpenCode SSE listener failed and will reconnect', {
        retrySeconds: Math.round(retryMs / 1000),
        error: failure.message,
      });
      this.#started = false;
      if (this.#readyPromise === input.readyPromise) {
        this.#readyPromise = null;
        this.#rejectReady = null;
      }
      this.#retryTimer = setTimeout(() => {
        this.#retryTimer = null;
        void this.start().catch((restartError) => {
          this.#options.logger.error('OpenCode SSE listener restart failed', {
            error: errorMessage(restartError),
          });
        });
      }, retryMs);
      this.#retryTimer.unref?.();
    } finally {
      input.clearReadyTimer();
      input.clearHeartbeatWatchdog();
      if (this.#abortController === input.abortController) this.#abortController = null;
    }
  }
}
