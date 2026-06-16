export interface ExpectedUserAbortTrackerOptions {
  ttlMs?: number;
  now?: () => number;
}

const DEFAULT_TTL_MS = 30_000;

export class ExpectedUserAbortTracker {
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #markedAtByChatId = new Map<string, number>();

  constructor(options: ExpectedUserAbortTrackerOptions = {}) {
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.#now = options.now ?? Date.now;
  }

  mark(chatId: string): void {
    this.#prune();
    this.#markedAtByChatId.set(chatId, this.#now());
  }

  has(chatId: string): boolean {
    this.#prune();
    return this.#markedAtByChatId.has(chatId);
  }

  clear(chatId: string): void {
    this.#markedAtByChatId.delete(chatId);
  }

  #prune(): void {
    const cutoff = this.#now() - this.#ttlMs;
    for (const [chatId, markedAt] of this.#markedAtByChatId) {
      if (markedAt < cutoff) this.#markedAtByChatId.delete(chatId);
    }
  }
}
