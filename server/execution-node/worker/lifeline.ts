import { SuspendAwareLeaseClock, type LeaseClock } from '../lease-clock.js';
import { NodeWorkerTransportError } from './framing.js';

export const NODE_WORKER_INERT_TIMEOUT_MS = 30_000;
export const NODE_WORKER_PULSE_INTERVAL_MS = 2_000;
export const NODE_WORKER_PULSE_TIMEOUT_MS = 6_000;

export interface NodeWorkerLifelineOptions {
  readonly clock?: LeaseClock;
  readonly scheduleTimeout?: (callback: () => void, delayMs: number) => { cancel(): void };
  retired(error: NodeWorkerTransportError): void;
}

/** A local parent pulse can shorten worker lifetime; it never supplies or renews controller authority. */
export class NodeWorkerLifeline {
  readonly #controller = new AbortController();
  readonly #clock: LeaseClock;
  #deadline = 0;
  #configured = false;
  #timer: { cancel(): void } | null = null;

  constructor(private readonly options: NodeWorkerLifelineOptions) {
    this.#clock = options.clock ?? new SuspendAwareLeaseClock();
    const reading = this.#clock.read();
    if (reading.discontinuity || !Number.isFinite(reading.elapsedMs) || reading.elapsedMs < 0) {
      this.#retire(new NodeWorkerTransportError('NODE_WORKER_TIMEOUT'));
    } else {
      this.#deadline = reading.elapsedMs + NODE_WORKER_INERT_TIMEOUT_MS;
      this.#schedule(NODE_WORKER_INERT_TIMEOUT_MS);
    }
  }

  get signal(): AbortSignal { return this.#controller.signal; }

  configure(): void {
    const now = this.poll();
    this.signal.throwIfAborted();
    if (this.#configured) throw new NodeWorkerTransportError('NODE_WORKER_PROTOCOL');
    this.#configured = true;
    this.#deadline = now + NODE_WORKER_PULSE_TIMEOUT_MS;
    this.#schedule(NODE_WORKER_PULSE_TIMEOUT_MS);
  }

  pulse(): void {
    const now = this.poll();
    this.signal.throwIfAborted();
    if (!this.#configured) return;
    this.#deadline = now + NODE_WORKER_PULSE_TIMEOUT_MS;
    this.#schedule(NODE_WORKER_PULSE_TIMEOUT_MS);
  }

  poll(): number {
    this.signal.throwIfAborted();
    const reading = this.#clock.read();
    if (reading.discontinuity || !Number.isFinite(reading.elapsedMs) || reading.elapsedMs < 0 || reading.elapsedMs >= this.#deadline) {
      this.#retire(new NodeWorkerTransportError('NODE_WORKER_TIMEOUT'));
      this.signal.throwIfAborted();
    }
    return reading.elapsedMs;
  }

  close(): void { this.#retire(new NodeWorkerTransportError('NODE_WORKER_CLOSED')); }

  #retire(error: NodeWorkerTransportError): void {
    if (this.signal.aborted) return;
    this.#timer?.cancel();
    this.#timer = null;
    this.#controller.abort(error);
    try { this.options.retired(error); } catch { /* Retirement cannot be undone by its observer. */ }
  }

  #schedule(delayMs: number): void {
    this.#timer?.cancel();
    this.#timer = (this.options.scheduleTimeout ?? scheduleTimeout)(() => {
      this.#timer = null;
      try { this.#schedule(Math.max(1, this.#deadline - this.poll())); } catch { /* Poll owns retirement. */ }
    }, delayMs);
  }
}

function scheduleTimeout(callback: () => void, delayMs: number): { cancel(): void } {
  const timer = setTimeout(callback, delayMs);
  timer.unref();
  return { cancel: () => clearTimeout(timer) };
}
