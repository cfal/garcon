import { matchesTurnIdentity, type TurnIdentity } from './turn-identity.js';

export interface ExpectedUserAbortTrackerOptions {
  ttlMs?: number;
  now?: () => number;
}

export type UserAbortIdentity = TurnIdentity;
export type ExpectedAbortConsumption = 'first' | 'duplicate' | false;

interface ExpectedAbort {
  stopId: string;
  identity: UserAbortIdentity;
  markedAt: number;
  consumed: boolean;
}

const DEFAULT_TTL_MS = 30_000;

export class ExpectedUserAbortTracker {
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #expectedByChatId = new Map<string, ExpectedAbort[]>();
  #nextUnscopedStopId = 0;

  constructor(options: ExpectedUserAbortTrackerOptions = {}) {
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.#now = options.now ?? Date.now;
  }

  mark(chatId: string, identity: UserAbortIdentity = {}, stopId?: string): void {
    this.#prune();
    const resolvedStopId = stopId ?? `unscoped:${++this.#nextUnscopedStopId}`;
    const expected = this.#expectedByChatId.get(chatId) ?? [];
    const next = expected.filter((entry) => entry.stopId !== resolvedStopId);
    next.push({
      stopId: resolvedStopId,
      identity: { ...identity },
      markedAt: this.#now(),
      consumed: false,
    });
    this.#expectedByChatId.set(chatId, next);
  }

  consume(chatId: string, identity: UserAbortIdentity = {}): ExpectedAbortConsumption {
    this.#prune();
    const expected = this.#expectedByChatId.get(chatId) ?? [];
    const identifiedMatches = expected.filter(
      (entry) => this.#hasIdentity(entry.identity)
        && matchesTurnIdentity(entry.identity, identity),
    );
    if (identifiedMatches.length > 0) {
      const firstTerminal = identifiedMatches.some((entry) => !entry.consumed);
      identifiedMatches.forEach((entry) => { entry.consumed = true; });
      return firstTerminal ? 'first' : 'duplicate';
    }

    if (this.#hasIdentity(identity)) return false;
    const identitylessMatches = expected.filter(
      (entry) => !entry.consumed && !this.#hasIdentity(entry.identity),
    );
    if (identitylessMatches.length === 0) return false;
    identitylessMatches.forEach((entry) => { entry.consumed = true; });
    return 'first';
  }

  clear(chatId: string, stopId?: string): void {
    if (!stopId) {
      this.#expectedByChatId.delete(chatId);
      return;
    }
    const expected = this.#expectedByChatId.get(chatId);
    if (!expected) return;
    const next = expected.filter((entry) => entry.stopId !== stopId);
    if (next.length > 0) this.#expectedByChatId.set(chatId, next);
    else this.#expectedByChatId.delete(chatId);
  }

  #prune(): void {
    const cutoff = this.#now() - this.#ttlMs;
    for (const [chatId, expected] of this.#expectedByChatId) {
      const retained = expected.filter(
        (entry) => this.#hasIdentity(entry.identity) || entry.markedAt >= cutoff,
      );
      if (retained.length > 0) this.#expectedByChatId.set(chatId, retained);
      else this.#expectedByChatId.delete(chatId);
    }
  }

  #hasIdentity(identity: UserAbortIdentity): boolean {
    return Boolean(identity.turnId || identity.clientRequestId);
  }
}
