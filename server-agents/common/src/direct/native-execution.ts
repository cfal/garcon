import type { NativeCleanupObserver } from '../execution/native-cleanup.js';

/** Owns a Direct dispatch's detached turn and exact cancellation through native finalization. */
export class DirectNativeExecution implements NativeCleanupObserver {
  readonly #cancellation = new AbortController();
  readonly #pending = new Set<Promise<void>>();
  #entered = false;
  #settled = false;
  #failure: { readonly error: unknown } | null = null;
  #abortSession: (() => boolean) | null = null;

  constructor(private readonly dispatchStarted: () => void) {}

  get signal(): AbortSignal { return this.#cancellation.signal; }
  get entered(): boolean { return this.#entered; }

  enter(): void {
    this.signal.throwIfAborted();
    this.#entered = true;
  }

  bindAbort(abort: () => boolean): void {
    this.#abortSession = abort;
    if (this.signal.aborted) abort();
  }

  started(): void { this.dispatchStarted(); }

  abort(): boolean {
    if (this.#settled) return false;
    this.#cancellation.abort(new DOMException('Direct execution cancelled', 'AbortError'));
    const requested = this.#abortSession?.() ?? false;
    return requested || this.#entered;
  }

  track(task: Promise<void>): void {
    const completion = task.then(() => {}, () => {});
    this.#pending.add(completion);
    void completion.then(() => this.#pending.delete(completion));
  }

  failed(error: unknown): void {
    this.#failure ??= { error };
  }

  async settled(): Promise<void> {
    while (this.#pending.size) await Promise.all(this.#pending);
    if (this.#failure) throw this.#failure.error;
    this.#settled = true;
    this.#abortSession = null;
  }
}
