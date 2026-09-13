import {
  AgentIntegrationError,
  type AgentDispatchOutcome,
  type AgentNativeTask,
} from '@garcon/server-agent-interface';
import type { NativeCleanupObserver } from './native-cleanup.js';

/** Retains native query work independently of caller cancellation and dispatch certainty. */
export class NativeQueryLifetime implements NativeCleanupObserver {
  readonly #dispatch = Promise.withResolvers<AgentDispatchOutcome>();
  readonly #cancellation = new AbortController();
  readonly #pending = new Set<Promise<void>>();
  #entered = false;
  #finished = false;
  #failure: { readonly error: unknown } | null = null;

  constructor(
    private readonly caller: AbortSignal,
    private readonly timeoutMs: number | undefined,
    private readonly cancellationMessage: string,
  ) {}

  begin(run: (signal: AbortSignal) => Promise<string>): AgentNativeTask<string> {
    const abortFromCaller = () => this.#cancellation.abort(this.caller.reason);
    this.caller.addEventListener('abort', abortFromCaller, { once: true });
    if (this.caller.aborted) abortFromCaller();
    const timeoutMs = this.timeoutMs;
    const timeout = typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0
      ? setTimeout(() => this.#cancellation.abort(new AgentIntegrationError(
        'TIMEOUT', `Single query timed out after ${timeoutMs}ms.`, true,
      )), Math.max(1, Math.round(timeoutMs)))
      : null;
    timeout?.unref();
    const signal = this.#cancellation.signal;
    const cancelled = Promise.withResolvers<never>();
    const rejectCancelled = () => {
      cancelled.reject(signal.reason);
      this.#dispatch.resolve({ kind: this.#entered ? 'unknown' : 'rejected', error: signal.reason });
    };
    signal.addEventListener('abort', rejectCancelled, { once: true });
    const work = Promise.resolve().then(async () => {
      signal.throwIfAborted();
      return run(signal);
    });
    const settled = work.then(() => {}, (error: unknown) => {
      this.#dispatch.resolve({ kind: this.#entered ? 'unknown' : 'rejected', error });
    }).then(async () => {
      while (this.#pending.size) await Promise.all(this.#pending);
      if (this.#failure) throw this.#failure.error;
      this.#finished = true;
    }).finally(() => {
      if (timeout) clearTimeout(timeout);
      this.caller.removeEventListener('abort', abortFromCaller);
    });
    const result = Promise.race([work, cancelled.promise]).then((value) => {
      signal.throwIfAborted();
      return value;
    }).finally(() => signal.removeEventListener('abort', rejectCancelled));
    return Object.freeze({ dispatch: this.#dispatch.promise, result, settled, abort: async () => {
      if (this.#finished) return false;
      this.#cancellation.abort(new DOMException(this.cancellationMessage, 'AbortError'));
      return true;
    } });
  }

  enter(): void {
    this.#cancellation.signal.throwIfAborted();
    this.#entered = true;
  }

  accepted(): void { this.#dispatch.resolve({ kind: 'accepted' }); }

  track(task: Promise<void>): void {
    const completion = task.catch((error: unknown) => this.failed(error));
    this.#pending.add(completion);
    void completion.then(() => this.#pending.delete(completion));
  }

  failed(error: unknown): void { this.#failure ??= { error }; }
}
