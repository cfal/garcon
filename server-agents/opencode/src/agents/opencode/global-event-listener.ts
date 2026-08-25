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
  instanceGeneration?(): number;
  markTemporarilyUnavailable(reason: string, sourceGeneration?: number): boolean;
  failRunningTurns(error: Error): void;
  closeUnavailableInstanceIfIdle(): boolean;
  confirmEventDelivery(input: {
    client: any;
    directory?: string;
    signal: AbortSignal;
    waitForEvent(matches: (event: SSEEvent) => boolean, signal?: AbortSignal): Promise<SSEEvent>;
  }): Promise<void>;
  handleEvent(client: any, event: SSEEvent): void;
}

interface EventWaiter {
  readonly generation: number;
  matches(event: SSEEvent): boolean;
  resolve(event: SSEEvent): void;
  reject(error: Error): void;
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
  #readinessDirectory: string | undefined;
  readonly #eventWaiters = new Set<EventWaiter>();

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
    this.#rejectAllEventWaiters(new Error('OpenCode event listener closed'));
  }

  waitForEvent(
    matches: (event: SSEEvent) => boolean,
    signal?: AbortSignal,
  ): Promise<SSEEvent> {
    return this.#waitForEvent(this.#generation, matches, signal);
  }

  #waitForEvent(
    generation: number,
    matches: (event: SSEEvent) => boolean,
    signal?: AbortSignal,
  ): Promise<SSEEvent> {
    if (
      !this.#started
      || generation !== this.#generation
      || this.#abortController?.signal.aborted
    ) {
      return Promise.reject(new Error('OpenCode event listener is not running'));
    }
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    return new Promise((resolve, reject) => {
      let waiter!: EventWaiter;
      const removeAbortListener = () => signal?.removeEventListener('abort', abort);
      const abort = () => {
        this.#eventWaiters.delete(waiter);
        removeAbortListener();
        reject(signal ? abortReason(signal) : new Error('OpenCode event wait aborted'));
      };
      waiter = {
        generation,
        matches,
        resolve(event) {
          removeAbortListener();
          resolve(event);
        },
        reject(error) {
          removeAbortListener();
          reject(error);
        },
      };
      this.#eventWaiters.add(waiter);
      signal?.addEventListener('abort', abort, { once: true });
    });
  }

  async start(directory?: string): Promise<void> {
    if (directory) this.#readinessDirectory = directory;
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
    let ready = false;
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
      ready = true;
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
      directory: this.#readinessDirectory,
      readyPromise,
      markConnected: () => {
        armHeartbeatWatchdog();
      },
      settleReady,
      armHeartbeatWatchdog,
      settleNotReady,
      ready: () => ready,
      clearReadyTimer: () => clearTimeout(readyTimer),
      clearHeartbeatWatchdog,
    });
    await readyPromise;
  }

  async #run(input: {
    generation: number;
    abortController: AbortController;
    directory?: string;
    readyPromise: Promise<void>;
    markConnected(): void;
    settleReady(): void;
    armHeartbeatWatchdog(): void;
    settleNotReady(error: Error): void;
    ready(): boolean;
    clearReadyTimer(): void;
    clearHeartbeatWatchdog(): void;
  }): Promise<void> {
    const waitForEvent = (
      matches: (event: SSEEvent) => boolean,
      signal?: AbortSignal,
    ): Promise<SSEEvent> => this.#waitForEvent(input.generation, matches, signal);
    let confirmationStarted = false;
    let instanceGeneration: number | undefined;
    try {
      const client = await this.#options.getClient();
      if (input.generation !== this.#generation) {
        throw new Error('OpenCode event listener was superseded during startup');
      }
      // A pre-ready or timeout failure of this attempt reports against the
      // instance generation it connected on; a death-retired generation must
      // not arm a cooldown the replacement has to wait out.
      instanceGeneration = this.#options.instanceGeneration?.();
      for await (const event of streamGlobalEvents(
        client,
        input.abortController.signal,
        () => {
          if (confirmationStarted) return;
          confirmationStarted = true;
          input.markConnected();
          void this.#options.confirmEventDelivery({
            client,
            directory: input.directory,
            signal: input.abortController.signal,
            waitForEvent,
          }).then(() => {
            if (input.generation === this.#generation) input.settleReady();
          }).catch((error) => {
            const failure = error instanceof Error ? error : new Error(String(error));
            input.settleNotReady(failure);
            input.abortController.abort(failure);
          });
        },
      )) {
        if (input.generation !== this.#generation) return;
        input.armHeartbeatWatchdog();
        for (const waiter of this.#eventWaiters) {
          if (waiter.generation !== input.generation) continue;
          if (!waiter.matches(event)) continue;
          this.#eventWaiters.delete(waiter);
          waiter.resolve(event);
        }
        this.#options.handleEvent(client, event);
      }
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      input.settleNotReady(failure);
      if (!input.abortController.signal.aborted) input.abortController.abort(failure);
      if (input.generation !== this.#generation) return;
      if (!input.ready() || failure instanceof OpenCodeTimeoutError) {
        const reason = errorMessage(failure);
        if (this.#options.markTemporarilyUnavailable(reason, instanceGeneration)) {
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
      this.#rejectEventWaitersForGeneration(
        input.generation,
        new Error('OpenCode event stream ended before event delivery confirmation'),
      );
      input.clearReadyTimer();
      input.clearHeartbeatWatchdog();
      if (this.#abortController === input.abortController) this.#abortController = null;
    }
  }

  #rejectEventWaitersForGeneration(generation: number, error: Error): void {
    for (const waiter of this.#eventWaiters) {
      if (waiter.generation !== generation) continue;
      this.#eventWaiters.delete(waiter);
      waiter.reject(error);
    }
  }

  #rejectAllEventWaiters(error: Error): void {
    for (const waiter of this.#eventWaiters) waiter.reject(error);
    this.#eventWaiters.clear();
  }
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('OpenCode event wait aborted');
}
