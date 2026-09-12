import { NODE_SESSION_LEASE_POLL_INTERVAL_MS, type NodeSupervisor } from './supervisor.js';

export interface NodeSessionLeaseMonitorOptions {
  readonly authoritySignal: AbortSignal;
  readonly supervisor: Pick<NodeSupervisor, 'poll'>;
  readonly schedulePoll?: (callback: () => void, delayMs: number) => { cancel(): void };
  failed(): void;
}

/** Keeps a logical session's deadline observable while every physical socket is disconnected. */
export class NodeSessionLeaseMonitor {
  readonly #detach: () => void;
  #timer: { cancel(): void } | null = null;
  #closed = false;

  constructor(private readonly options: NodeSessionLeaseMonitorOptions) {
    const close = () => this.close();
    options.authoritySignal.addEventListener('abort', close, { once: true });
    this.#detach = () => options.authoritySignal.removeEventListener('abort', close);
    if (options.authoritySignal.aborted) this.close();
    else this.#poll();
  }

  #poll(): void {
    if (this.#closed) return;
    try {
      this.options.supervisor.poll();
      if (this.#closed) return;
      this.#timer = (this.options.schedulePoll ?? schedulePoll)(() => {
        this.#timer = null;
        this.#poll();
      }, NODE_SESSION_LEASE_POLL_INTERVAL_MS);
    } catch {
      this.close();
      try { this.options.failed(); } catch { /* The owner retains responsibility for exact session teardown. */ }
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#detach();
    this.#timer?.cancel();
    this.#timer = null;
  }
}

function schedulePoll(callback: () => void, delayMs: number): { cancel(): void } {
  const timer = setTimeout(callback, delayMs);
  timer.unref();
  return { cancel: () => clearTimeout(timer) };
}
