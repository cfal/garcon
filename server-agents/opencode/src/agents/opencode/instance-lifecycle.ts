import { withAbortableTimeout } from './request-control.js';

export type OpenCodeServerTermination =
  | { readonly kind: 'exit'; readonly code: number | null; readonly signal: NodeJS.Signals | null }
  | { readonly kind: 'error'; readonly error: unknown };

export interface OpenCodeInstance {
  client: any;
  baseUrl?: string;
  server?: {
    close?: () => void;
    // Resolves once when the spawned server process terminates, including after
    // readiness. Optional so injected test instances stay lightweight.
    termination?: Promise<OpenCodeServerTermination>;
    // Reports whether the process already exited or errored; a deliberate
    // close of a still-live process preserves the availability cooldown.
    exitObserved?: () => boolean;
  };
  close?: () => void;
}

export function closeOpenCodeInstance(instance: OpenCodeInstance): void {
  try {
    if (typeof instance.server?.close === 'function') instance.server.close();
    else instance.close?.();
  } catch {
    // Best effort during shutdown and failed startup.
  }
}

// Tracks raw factories so shutdown can close instances that resolve after caller cancellation.
export class OpenCodeInstanceCreationTracker {
  readonly #isShuttingDown: () => boolean;
  readonly #pending = new Set<Promise<void>>();

  constructor(isShuttingDown: () => boolean) {
    this.#isShuttingDown = isShuttingDown;
  }

  track(create: () => Promise<OpenCodeInstance>, signal: AbortSignal): Promise<OpenCodeInstance> {
    const guarded = Promise.resolve().then(create).then((instance) => {
      if (!signal.aborted && !this.#isShuttingDown()) return instance;
      closeOpenCodeInstance(instance);
      throw signal.reason ?? new Error('OpenCode runtime is shutting down');
    });
    let cleanup!: Promise<void>;
    cleanup = guarded.then(() => undefined, () => undefined).finally(() => {
      this.#pending.delete(cleanup);
    });
    this.#pending.add(cleanup);
    return guarded;
  }

  async waitForCleanup(graceMs: number): Promise<void> {
    const pending = [...this.#pending];
    if (pending.length === 0) return;
    await withAbortableTimeout(
      () => Promise.all(pending).then(() => undefined),
      graceMs,
      'OpenCode pending startup cleanup',
    ).catch(() => undefined);
  }
}
