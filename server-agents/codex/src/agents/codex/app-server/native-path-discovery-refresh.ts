const SESSION_REFRESH_INTERVAL_MS = 30_000;
const GLOBAL_REFRESH_INTERVAL_MS = 1_000;

export interface NativePathDiscoveryRefreshLimiterOptions {
  readonly sessionIntervalMs?: number;
  readonly globalIntervalMs?: number;
  readonly now?: () => number;
}

export class NativePathDiscoveryRefreshLimiter {
  readonly #sessionIntervalMs: number;
  readonly #globalIntervalMs: number;
  readonly #now: () => number;
  readonly #sessionRefreshes = new Map<string, number>();
  #lastRefreshAt = Number.NEGATIVE_INFINITY;

  constructor(options: NativePathDiscoveryRefreshLimiterOptions = {}) {
    this.#sessionIntervalMs = options.sessionIntervalMs ?? SESSION_REFRESH_INTERVAL_MS;
    this.#globalIntervalMs = options.globalIntervalMs ?? GLOBAL_REFRESH_INTERVAL_MS;
    this.#now = options.now ?? (() => performance.now());
  }

  accept(agentSessionId: string): boolean {
    const now = this.#now();
    for (const [sessionId, refreshedAt] of this.#sessionRefreshes) {
      const elapsed = now - refreshedAt;
      if (elapsed < 0 || elapsed >= this.#sessionIntervalMs) {
        this.#sessionRefreshes.delete(sessionId);
      }
    }
    if (this.#sessionRefreshes.has(agentSessionId)) return false;

    const globalElapsed = now - this.#lastRefreshAt;
    if (globalElapsed >= 0 && globalElapsed < this.#globalIntervalMs) return false;

    this.#lastRefreshAt = now;
    this.#sessionRefreshes.set(agentSessionId, now);
    return true;
  }
}
