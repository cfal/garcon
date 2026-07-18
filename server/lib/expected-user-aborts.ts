import { matchesTurnIdentity, type TurnIdentity } from './turn-identity.js';

export interface ExpectedUserAbortTrackerOptions {
  ttlMs?: number;
  now?: () => number;
}

export type UserAbortIdentity = TurnIdentity;
export type ExpectedAbortConsumption = 'first' | 'duplicate' | 'deferred' | false;
export type ExpectedAbortAcknowledgementDisposition = 'none' | 'suppress' | 'release';

export interface ExpectedAbortAcknowledgement {
  disposition: ExpectedAbortAcknowledgementDisposition;
  identity?: UserAbortIdentity;
}

interface ExpectedAbort {
  stopId: string;
  identity: UserAbortIdentity;
  markedAt: number;
  acknowledged: boolean;
  consumed: boolean;
  terminalDeferred: boolean;
  turnSettled: boolean;
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
      acknowledged: false,
      consumed: false,
      terminalDeferred: false,
      turnSettled: false,
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
    if (identifiedMatches.length > 0) return this.#consumeMatches(identifiedMatches);

    if (this.#hasIdentity(identity)) return false;
    const identitylessMatches = expected.filter(
      (entry) => !entry.consumed && !this.#hasIdentity(entry.identity),
    );
    if (identitylessMatches.length === 0) return false;
    return this.#consumeMatches(identitylessMatches);
  }

  acknowledge(
    chatId: string,
    stopId: string,
    success: boolean,
  ): ExpectedAbortAcknowledgement {
    this.#prune();
    const expected = this.#expectedByChatId.get(chatId);
    const entry = expected?.find((candidate) => candidate.stopId === stopId);
    if (!expected || !entry) return { disposition: 'none' };

    const identity = { ...entry.identity };
    const terminalWasDeferred = entry.terminalDeferred;
    if (!success) {
      this.#remove(chatId, stopId);
      if (!terminalWasDeferred) return { disposition: 'none', identity };

      const remainingMatches = this.#matchingEntries(chatId, identity);
      if (remainingMatches.some((candidate) => candidate.acknowledged)) {
        this.#markConsumed(remainingMatches);
        return { disposition: 'suppress', identity };
      }
      if (remainingMatches.length > 0) return { disposition: 'none', identity };
      return { disposition: 'release', identity };
    }

    entry.acknowledged = true;
    entry.markedAt = this.#now();
    if (!terminalWasDeferred) return { disposition: 'none', identity };
    this.#markConsumed(this.#matchingEntries(chatId, identity));
    this.#removeSettledAcknowledged(chatId);
    return { disposition: 'suppress', identity };
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

  completeTurn(chatId: string, identity: UserAbortIdentity = {}): void {
    const expected = this.#expectedByChatId.get(chatId);
    if (!expected) return;
    const hasIdentity = this.#hasIdentity(identity);
    if (!hasIdentity) return;
    for (const entry of expected) {
      if (matchesTurnIdentity(entry.identity, identity)) entry.turnSettled = true;
    }
    const next = expected.filter((entry) => {
      return !entry.turnSettled || !entry.acknowledged;
    });
    if (next.length > 0) this.#expectedByChatId.set(chatId, next);
    else this.#expectedByChatId.delete(chatId);
  }

  #prune(): void {
    const cutoff = this.#now() - this.#ttlMs;
    for (const [chatId, expected] of this.#expectedByChatId) {
      const retained = expected.filter(
        (entry) => !entry.acknowledged
          || this.#hasIdentity(entry.identity)
          || entry.markedAt >= cutoff,
      );
      if (retained.length > 0) this.#expectedByChatId.set(chatId, retained);
      else this.#expectedByChatId.delete(chatId);
    }
  }

  #consumeMatches(matches: ExpectedAbort[]): ExpectedAbortConsumption {
    if (matches.some((entry) => entry.consumed)) return 'duplicate';
    if (!matches.some((entry) => entry.acknowledged)) {
      matches.forEach((entry) => { entry.terminalDeferred = true; });
      return 'deferred';
    }
    this.#markConsumed(matches);
    return 'first';
  }

  #markConsumed(matches: ExpectedAbort[]): void {
    matches.forEach((entry) => {
      entry.consumed = true;
      entry.terminalDeferred = false;
    });
  }

  #matchingEntries(
    chatId: string,
    identity: UserAbortIdentity,
  ): ExpectedAbort[] {
    const expected = this.#expectedByChatId.get(chatId) ?? [];
    if (this.#hasIdentity(identity)) {
      return expected.filter(
        (entry) => this.#hasIdentity(entry.identity)
          && matchesTurnIdentity(entry.identity, identity),
      );
    }
    return expected.filter((entry) => !this.#hasIdentity(entry.identity));
  }

  #remove(chatId: string, stopId: string): void {
    const expected = this.#expectedByChatId.get(chatId);
    if (!expected) return;
    const next = expected.filter((entry) => entry.stopId !== stopId);
    if (next.length > 0) this.#expectedByChatId.set(chatId, next);
    else this.#expectedByChatId.delete(chatId);
  }

  #removeSettledAcknowledged(chatId: string): void {
    const expected = this.#expectedByChatId.get(chatId);
    if (!expected) return;
    const next = expected.filter((entry) => !entry.turnSettled || !entry.acknowledged);
    if (next.length > 0) this.#expectedByChatId.set(chatId, next);
    else this.#expectedByChatId.delete(chatId);
  }

  #hasIdentity(identity: UserAbortIdentity): boolean {
    return Boolean(identity.turnId || identity.clientRequestId);
  }
}
