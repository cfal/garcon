import { matchesTurnIdentity, type TurnIdentity } from './turn-identity.js';

export interface ExpectedUserAbortTrackerOptions {
  ttlMs?: number;
  now?: () => number;
}

export type UserAbortIdentity = TurnIdentity;

interface ExpectedAbort {
  identity: UserAbortIdentity;
  markedAt: number;
  consumed: boolean;
}

const DEFAULT_TTL_MS = 30_000;

export class ExpectedUserAbortTracker {
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #expectedByChatId = new Map<string, ExpectedAbort>();

  constructor(options: ExpectedUserAbortTrackerOptions = {}) {
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.#now = options.now ?? Date.now;
  }

  mark(chatId: string, identity: UserAbortIdentity = {}): void {
    this.#prune();
    this.#expectedByChatId.set(chatId, {
      identity: { ...identity },
      markedAt: this.#now(),
      consumed: false,
    });
  }

  consume(chatId: string, identity: UserAbortIdentity = {}): boolean {
    this.#prune();
    const expected = this.#expectedByChatId.get(chatId);
    if (!expected || !matchesTurnIdentity(expected.identity, identity)) return false;
    if (expected.consumed && !identity.turnId && !identity.clientRequestId) return false;
    expected.consumed = true;
    return true;
  }

  clear(chatId: string): void {
    this.#expectedByChatId.delete(chatId);
  }

  #prune(): void {
    const cutoff = this.#now() - this.#ttlMs;
    for (const [chatId, expected] of this.#expectedByChatId) {
      if (expected.markedAt < cutoff) this.#expectedByChatId.delete(chatId);
    }
  }
}
