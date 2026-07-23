import { matchesTurnIdentity, type TurnIdentity } from '../lib/turn-identity.js';

type ExecutionAttemptPhase =
  | 'reserved'
  | 'registering'
  | 'registered'
  | 'launching'
  | 'abortable'
  | 'settled';

interface AttemptWaiter {
  predicate: () => boolean;
  resolve: (value: boolean) => void;
}

/** Owns the identity and lifecycle gates for one queue-managed provider turn. */
export class QueueExecutionAttempt {
  readonly entryId: string | undefined;
  #turn: TurnIdentity;
  // The phase is the single source of truth for lifecycle waits; `runSettled`
  // and `terminalObserved` are orthogonal completion signals, and `launchAllowed`
  // records the one gate a phase transition cannot express on its own.
  #phase: ExecutionAttemptPhase;
  readonly #expectedAbortStopIds = new Set<string>();
  #runSettled = false;
  #terminalObserved = false;
  #launchAllowed = false;
  #waiters: AttemptWaiter[] = [];

  constructor(turn: TurnIdentity, entryId?: string) {
    this.#turn = { ...turn };
    this.entryId = entryId;
    this.#phase = entryId ? 'registering' : 'reserved';
  }

  get isExpectedAbort(): boolean {
    return this.#expectedAbortStopIds.size > 0;
  }

  get isRunSettled(): boolean {
    return this.#runSettled;
  }

  get isSettlementReady(): boolean {
    return this.#runSettled && this.#terminalObserved;
  }

  get isSettled(): boolean {
    return this.#phase === 'settled';
  }

  identity(): TurnIdentity {
    return { ...this.#turn };
  }

  matches(turn: TurnIdentity | undefined): boolean {
    return matchesTurnIdentity(this.#turn, turn);
  }

  // Resolves true once the turn leaves the 'registering' gate under its own
  // power, or false if it settles while still registering.
  waitUntilRegistered(): Promise<boolean> {
    return this.#waitFor(() => this.#phase !== 'registering' && this.#phase !== 'settled');
  }

  waitUntilAbortable(): Promise<boolean> {
    return this.#waitFor(() => this.#phase === 'abortable');
  }

  waitForLaunchDecision(signal?: AbortSignal): Promise<boolean> {
    if (!signal) return this.#waitFor(() => this.#launchAllowed);
    if (signal.aborted) return Promise.resolve(false);
    return new Promise((resolve) => {
      const finish = (shouldLaunch: boolean) => {
        signal.removeEventListener('abort', onAbort);
        resolve(shouldLaunch);
      };
      const onAbort = () => { finish(false); };
      signal.addEventListener('abort', onAbort, { once: true });
      void this.#waitFor(() => this.#launchAllowed).then(finish);
    });
  }

  waitUntilSettled(): Promise<void> {
    return this.#waitFor(() => this.#phase === 'settled').then(() => undefined);
  }

  replaceReservedTurn(turn: TurnIdentity): void {
    if (this.#phase !== 'reserved') {
      throw new Error('Cannot replace the identity of a launched turn');
    }
    this.#turn = { ...turn };
  }

  async handoffTurn(
    predecessor: TurnIdentity,
    successor: TurnIdentity,
    commit: () => Promise<void>,
  ): Promise<void> {
    if (!sameTurnIdentity(this.#turn, predecessor)) {
      throw new Error('Cannot hand off an execution attempt after its active turn changed');
    }
    const previous = this.#turn;
    const next = { ...successor };
    this.#turn = next;
    try {
      await commit();
    } catch (error) {
      if (this.#turn === next) this.#turn = previous;
      throw error;
    }
  }

  markRegistered(): void {
    if (this.#phase !== 'registering') return;
    this.#phase = 'registered';
    this.#notify();
  }

  allowLaunch(): void {
    if (this.#phase === 'registered') this.#phase = 'launching';
    this.#launchAllowed = true;
    this.#notify();
  }

  markLaunching(): void {
    if (this.#phase === 'reserved' || this.#phase === 'registered') this.#phase = 'launching';
    this.#notify();
  }

  markAbortable(): void {
    if (this.#phase === 'settled') return;
    this.#phase = 'abortable';
    this.#notify();
  }

  expectAbort(stopId: string): void {
    this.#expectedAbortStopIds.add(stopId);
  }

  clearExpectedAbort(stopId?: string): void {
    if (stopId) {
      this.#expectedAbortStopIds.delete(stopId);
      return;
    }
    this.#expectedAbortStopIds.clear();
  }

  markRunSettled(): void {
    this.#runSettled = true;
  }

  markTerminalObserved(): void {
    this.#terminalObserved = true;
  }

  markSettled(): void {
    if (this.#phase === 'settled') return;
    this.#phase = 'settled';
    this.#notify();
  }

  // Resolves true once the predicate holds under its own power, or false once the
  // attempt has settled first. Waiters are single-shot.
  #waitFor(predicate: () => boolean): Promise<boolean> {
    if (predicate()) return Promise.resolve(true);
    if (this.#phase === 'settled') return Promise.resolve(false);
    return new Promise((resolve) => {
      this.#waiters.push({ predicate, resolve });
    });
  }

  #notify(): void {
    if (this.#waiters.length === 0) return;
    const settled = this.#phase === 'settled';
    this.#waiters = this.#waiters.filter((waiter) => {
      if (waiter.predicate()) {
        waiter.resolve(true);
        return false;
      }
      if (settled) {
        waiter.resolve(false);
        return false;
      }
      return true;
    });
  }
}

function sameTurnIdentity(left: TurnIdentity, right: TurnIdentity): boolean {
  return matchesTurnIdentity(left, right) && matchesTurnIdentity(right, left);
}
