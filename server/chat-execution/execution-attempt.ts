import { matchesTurnIdentity, type TurnIdentity } from '../lib/turn-identity.js';

/** Owns the identity and lifecycle gates for one queue-managed provider turn. */
export class QueueExecutionAttempt {
  readonly entryId: string | undefined;
  #turn: TurnIdentity;
  #launched = false;
  #settled = false;
  #settledWaiters: Array<() => void> = [];

  constructor(turn: TurnIdentity, entryId?: string) {
    this.#turn = { ...turn };
    this.entryId = entryId;
  }

  get isSettled(): boolean {
    return this.#settled;
  }

  identity(): TurnIdentity {
    return { ...this.#turn };
  }

  matches(turn: TurnIdentity | undefined): boolean {
    return matchesTurnIdentity(this.#turn, turn);
  }

  waitUntilSettled(): Promise<void> {
    if (this.#settled) return Promise.resolve();
    return new Promise((resolve) => this.#settledWaiters.push(resolve));
  }

  replaceReservedTurn(turn: TurnIdentity): void {
    if (this.#launched || this.#settled) {
      throw new Error('Cannot replace the identity of a launched turn');
    }
    this.#turn = { ...turn };
  }

  markLaunching(): void {
    if (!this.#settled) this.#launched = true;
  }

  markSettled(): void {
    if (this.#settled) return;
    this.#settled = true;
    for (const resolve of this.#settledWaiters) resolve();
    this.#settledWaiters = [];
  }
}
