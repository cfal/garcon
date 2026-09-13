import type { AgentNativeTask } from '@garcon/server-agent-interface';
import { DomainError } from '../lib/domain-error.js';
import type { NodeNativeOccupancy, NodeNativeReservation } from './native-occupancy.js';
import { DEFAULT_NODE_NATIVE_LIFETIME } from './native-lifetime-limits.js';

interface NativeTask {
  readonly reservation: NodeNativeReservation;
  readonly abort: () => Promise<boolean>;
  readonly contain: () => void;
  readonly detach: () => void;
  readonly reject: (error: unknown) => void;
  dispatchTimer: { cancel(): void } | null;
  settlementTimer: { cancel(): void } | null;
  settled: boolean;
  abortRequested: boolean;
}

interface NativeTaskOptions {
  readonly occupancy: NodeNativeOccupancy;
  readonly signal: AbortSignal;
  readonly dispatchMs?: number;
  readonly nativeSettlementMs?: number;
  readonly scheduleTimeout?: (callback: () => void, delayMs: number) => { cancel(): void };
}

/** Owns auxiliary capacity after caller completion, cancellation and physical channel replacement. */
export class NodeNativeTasks {
  readonly #tasks = new Set<NativeTask>();
  readonly #dispatchMs: number;
  readonly #settlementMs: number;
  readonly #detach: () => void;
  #closed = false;
  #containing = false;

  constructor(private readonly options: NativeTaskOptions) {
    this.#dispatchMs = options.dispatchMs ?? DEFAULT_NODE_NATIVE_LIFETIME.dispatchMs;
    this.#settlementMs = options.nativeSettlementMs ?? DEFAULT_NODE_NATIVE_LIFETIME.nativeSettlementMs;
    if (![this.#dispatchMs, this.#settlementMs].every((ms) => Number.isSafeInteger(ms) && ms > 0)) {
      throw new TypeError('Invalid native task deadlines');
    }
    const close = () => this.close();
    this.#detach = () => options.signal.removeEventListener('abort', close);
    options.signal.addEventListener('abort', close, { once: true });
    if (options.signal.aborted) this.close();
  }

  get active(): number { return this.#tasks.size; }

  run<T>(begin: () => AgentNativeTask<T>, signal: AbortSignal, contain: () => void): Promise<T> {
    signal.throwIfAborted();
    if (this.#closed) throw new DomainError('NODE_UNAVAILABLE', 'Native task admission is retired', 409);
    const reservation = this.options.occupancy.reserveAuxiliary();
    let native: AgentNativeTask<T>;
    try {
      native = begin();
    } catch (error) {
      reservation.release();
      throw error;
    }
    const { dispatch, result, settled, abort } = native;
    const failure = Promise.withResolvers<never>();
    const onAbort = () => this.#abort(task, signal.reason);
    const task: NativeTask = {
      reservation,
      abort: () => Reflect.apply(abort, native, []) as Promise<boolean>,
      contain,
      detach: () => signal.removeEventListener('abort', onAbort),
      reject: failure.reject,
      dispatchTimer: null,
      settlementTimer: null,
      settled: false,
      abortRequested: false,
    };
    this.#tasks.add(task);
    signal.addEventListener('abort', onAbort, { once: true });
    task.dispatchTimer = this.#schedule(() => {
      this.#abort(task, new DOMException('Native dispatch is unconfirmed', 'TimeoutError'));
    }, this.#dispatchMs);
    void dispatch.then((outcome) => {
      task.dispatchTimer?.cancel();
      task.dispatchTimer = null;
      if (outcome.kind !== 'accepted') this.#abort(task, outcome.error);
    }, (error: unknown) => this.#abort(task, error));
    void settled.then(() => this.#settle(task), () => this.#contain(task));
    const observed = result.then((value) => {
      this.#waitForSettlement(task);
      return value;
    }, (error: unknown) => {
      this.#abort(task, error);
      throw error;
    });
    if (signal.aborted) onAbort();
    return Promise.race([observed, failure.promise]);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#detach();
    for (const task of this.#tasks) this.#abort(task, new DOMException('Native task owner closed', 'AbortError'));
  }

  #abort(task: NativeTask, error: unknown): void {
    task.reject(error);
    if (task.settled || task.abortRequested) return;
    task.abortRequested = true;
    task.dispatchTimer?.cancel();
    task.dispatchTimer = null;
    this.#waitForSettlement(task);
    void Promise.resolve().then(task.abort).catch(() => {});
  }

  #waitForSettlement(task: NativeTask): void {
    if (task.settled || task.settlementTimer || this.#containing) return;
    task.settlementTimer = this.#schedule(() => this.#contain(task), this.#settlementMs);
  }

  #settle(task: NativeTask): void {
    if (task.settled) return;
    task.settled = true;
    task.dispatchTimer?.cancel();
    task.settlementTimer?.cancel();
    task.detach();
    if (this.#containing) return;
    this.#tasks.delete(task);
    task.reservation.release();
  }

  #contain(task: NativeTask): void {
    if (task.settled || this.#containing) return;
    this.#containing = true;
    this.options.occupancy.close();
    this.close();
    for (const pending of this.#tasks) {
      pending.dispatchTimer?.cancel();
      pending.settlementTimer?.cancel();
      pending.detach();
    }
    task.contain();
  }

  #schedule(callback: () => void, delayMs: number): { cancel(): void } {
    if (this.options.scheduleTimeout) return this.options.scheduleTimeout(callback, delayMs);
    const timer = setTimeout(callback, delayMs);
    timer.unref();
    return { cancel: () => clearTimeout(timer) };
  }
}
