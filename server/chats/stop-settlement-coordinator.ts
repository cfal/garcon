import type { TurnEventMetadata } from '../agents/event-bus.js';
import type {
  PendingUserInputCohort,
  PendingUserInputServiceContract,
} from './pending-user-input-service.js';
import { matchesTurnIdentity } from '../lib/turn-identity.js';

interface StopSettlementCoordinatorOptions {
  terminalTimeoutMs?: number;
  onSettlementError?: (error: unknown) => void;
}

interface PendingStopSettlement {
  cohort: PendingUserInputCohort;
  turn: TurnEventMetadata | undefined;
  acknowledged: boolean;
  terminalObserved: boolean;
  timeout?: ReturnType<typeof setTimeout>;
}

const DEFAULT_TERMINAL_TIMEOUT_MS = 10_000;

export class StopSettlementCoordinator {
  readonly #pendingInputs: Pick<
    PendingUserInputServiceContract,
    'captureCohort' | 'settleNativeCohort'
  >;
  readonly #terminalTimeoutMs: number;
  readonly #onSettlementError: (error: unknown) => void;
  readonly #pendingByChatId = new Map<string, PendingStopSettlement>();

  constructor(
    pendingInputs: Pick<
      PendingUserInputServiceContract,
      'captureCohort' | 'settleNativeCohort'
    >,
    options: StopSettlementCoordinatorOptions = {},
  ) {
    this.#pendingInputs = pendingInputs;
    this.#terminalTimeoutMs = options.terminalTimeoutMs ?? DEFAULT_TERMINAL_TIMEOUT_MS;
    this.#onSettlementError = options.onSettlementError ?? (() => undefined);
  }

  onStopRequested(chatId: string, turn: TurnEventMetadata | undefined): void {
    if (this.#pendingByChatId.has(chatId)) return;
    this.#pendingByChatId.set(chatId, {
      cohort: this.#pendingInputs.captureCohort(chatId),
      turn: turn ? { ...turn } : undefined,
      acknowledged: false,
      terminalObserved: false,
    });
  }

  onSessionStopped(chatId: string, success: boolean): void {
    const pending = this.#pendingByChatId.get(chatId);
    if (!pending) return;
    if (!success) {
      this.discard(chatId);
      return;
    }

    pending.acknowledged = true;
    if (pending.terminalObserved) {
      this.#settle(chatId, pending);
      return;
    }
    if (pending.timeout) clearTimeout(pending.timeout);
    pending.timeout = setTimeout(() => this.#settle(chatId, pending), this.#terminalTimeoutMs);
    pending.timeout.unref?.();
  }

  onTurnTerminal(chatId: string, turn: TurnEventMetadata | undefined): void {
    const pending = this.#pendingByChatId.get(chatId);
    if (!pending || !matchesTurnIdentity(pending.turn, turn)) return;
    pending.terminalObserved = true;
    if (pending.acknowledged) this.#settle(chatId, pending);
  }

  discard(chatId: string): void {
    const pending = this.#pendingByChatId.get(chatId);
    if (!pending) return;
    if (pending.timeout) clearTimeout(pending.timeout);
    this.#pendingByChatId.delete(chatId);
  }

  #settle(chatId: string, pending: PendingStopSettlement): void {
    if (this.#pendingByChatId.get(chatId) !== pending) return;
    this.discard(chatId);
    this.#pendingInputs.settleNativeCohort(pending.cohort).catch(this.#onSettlementError);
  }
}
