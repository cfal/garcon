import { matchesTurnIdentity, type TurnIdentity } from '../lib/turn-identity.js';

type ExecutionAttemptPhase =
  | 'reserved'
  | 'registering'
  | 'registered'
  | 'launching'
  | 'abortable'
  | 'settled';

/** Owns the identity and lifecycle gates for one queue-managed provider turn. */
export class QueueExecutionAttempt {
  readonly entryId: string | undefined;
  #turn: TurnIdentity;
  #phase: ExecutionAttemptPhase;
  #expectedAbort = false;
  #runSettled = false;
  #terminalObserved = false;

  readonly #registered: Promise<boolean>;
  #resolveRegistered!: (registered: boolean) => void;
  #registeredSettled: boolean;
  readonly #launchDecision: Promise<boolean>;
  #resolveLaunchDecision!: (shouldLaunch: boolean) => void;
  #launchDecisionSettled = false;
  readonly #abortable: Promise<boolean>;
  #resolveAbortable!: (abortable: boolean) => void;
  #abortableSettled = false;
  readonly #settled: Promise<void>;
  #resolveSettled!: () => void;
  #settledResolved = false;

  constructor(turn: TurnIdentity, entryId?: string) {
    this.#turn = { ...turn };
    this.entryId = entryId;
    this.#phase = entryId ? 'registering' : 'reserved';
    this.#registeredSettled = !entryId;
    this.#registered = entryId
      ? new Promise((resolve) => { this.#resolveRegistered = resolve; })
      : Promise.resolve(true);
    this.#launchDecision = new Promise((resolve) => { this.#resolveLaunchDecision = resolve; });
    this.#abortable = new Promise((resolve) => { this.#resolveAbortable = resolve; });
    this.#settled = new Promise((resolve) => { this.#resolveSettled = resolve; });
  }

  get isExpectedAbort(): boolean {
    return this.#expectedAbort;
  }

  get isRunSettled(): boolean {
    return this.#runSettled;
  }

  get isSettlementReady(): boolean {
    return this.#runSettled && this.#terminalObserved;
  }

  get isSettled(): boolean {
    return this.#settledResolved;
  }

  identity(): TurnIdentity {
    return { ...this.#turn };
  }

  matches(turn: TurnIdentity | undefined): boolean {
    return matchesTurnIdentity(this.#turn, turn);
  }

  waitUntilRegistered(): Promise<boolean> {
    return this.#registered;
  }

  waitUntilAbortable(): Promise<boolean> {
    return this.#abortable;
  }

  waitForLaunchDecision(): Promise<boolean> {
    return this.#launchDecision;
  }

  waitUntilSettled(): Promise<void> {
    return this.#settled;
  }

  replaceReservedTurn(turn: TurnIdentity): void {
    if (this.#phase !== 'reserved') {
      throw new Error('Cannot replace the identity of a launched turn');
    }
    this.#turn = { ...turn };
  }

  markRegistered(): void {
    if (this.#phase !== 'registering') return;
    this.#phase = 'registered';
    this.#settleRegistered(true);
  }

  allowLaunch(): void {
    if (this.#phase === 'registered') this.#phase = 'launching';
    this.#settleLaunchDecision(true);
  }

  markLaunching(): void {
    if (this.#phase === 'reserved' || this.#phase === 'registered') this.#phase = 'launching';
  }

  markAbortable(): void {
    if (this.#phase === 'settled') return;
    this.#phase = 'abortable';
    this.#settleAbortable(true);
  }

  expectAbort(): void {
    this.#expectedAbort = true;
  }

  clearExpectedAbort(): void {
    this.#expectedAbort = false;
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
    this.#settleRegistered(false);
    this.#settleLaunchDecision(false);
    this.#settleAbortable(false);
    if (!this.#settledResolved) {
      this.#settledResolved = true;
      this.#resolveSettled();
    }
  }

  #settleRegistered(registered: boolean): void {
    if (this.#registeredSettled) return;
    this.#registeredSettled = true;
    this.#resolveRegistered(registered);
  }

  #settleLaunchDecision(shouldLaunch: boolean): void {
    if (this.#launchDecisionSettled) return;
    this.#launchDecisionSettled = true;
    this.#resolveLaunchDecision(shouldLaunch);
  }

  #settleAbortable(abortable: boolean): void {
    if (this.#abortableSettled) return;
    this.#abortableSettled = true;
    this.#resolveAbortable(abortable);
  }
}
