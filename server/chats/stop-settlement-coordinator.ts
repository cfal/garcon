import type { TurnEventMetadata } from '../agents/event-bus.js';
import type {
  PendingUserInputCohort,
  PendingUserInputServiceContract,
} from './pending-user-input-service.js';
import { matchesTurnIdentity } from '../lib/turn-identity.js';

export interface StopSettlementCoordinatorOptions {
  terminalTimeoutMs?: number;
  onSettlementError?: (error: unknown) => void;
}

interface PendingStopSettlement {
  stopId: string;
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
  readonly #pendingByChatId = new Map<string, Map<string, PendingStopSettlement>>();

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

  onStopRequested(
    chatId: string,
    stopId: string,
    turn: TurnEventMetadata | undefined,
  ): void {
    const pendingByStopId = this.#pendingByChatId.get(chatId) ?? new Map();
    pendingByStopId.set(stopId, {
      stopId,
      cohort: this.#pendingInputs.captureCohort(chatId),
      turn: turn ? { ...turn } : undefined,
      acknowledged: false,
      terminalObserved: false,
    });
    this.#pendingByChatId.set(chatId, pendingByStopId);
  }

  onSessionStopped(chatId: string, stopId: string, success: boolean): void {
    const pending = this.#pendingByChatId.get(chatId)?.get(stopId);
    if (!pending) return;
    if (!success) {
      this.discard(chatId, stopId);
      return;
    }

    pending.acknowledged = true;
    if (pending.terminalObserved) {
      this.#settle(chatId, pending);
      return;
    }
    if (this.#hasTurnIdentity(pending.turn)) return;
    if (pending.timeout) clearTimeout(pending.timeout);
    pending.timeout = setTimeout(() => this.#settle(chatId, pending), this.#terminalTimeoutMs);
    pending.timeout.unref?.();
  }

  onTurnTerminal(chatId: string, turn: TurnEventMetadata | undefined): void {
    const pendings = [...(this.#pendingByChatId.get(chatId)?.values() ?? [])];
    if (pendings.length === 0) return;
    const identified = pendings.filter(
      (pending) => this.#hasTurnIdentity(pending.turn)
        && matchesTurnIdentity(pending.turn, turn),
    );
    const matching = identified.length > 0 || this.#hasTurnIdentity(turn)
      ? identified
      : pendings.filter((pending) => !this.#hasTurnIdentity(pending.turn));
    for (const pending of matching) {
      pending.terminalObserved = true;
      if (pending.acknowledged) this.#settle(chatId, pending);
    }
  }

  discard(chatId: string, stopId?: string): void {
    const pendingByStopId = this.#pendingByChatId.get(chatId);
    if (!pendingByStopId) return;
    if (stopId) {
      const pending = pendingByStopId.get(stopId);
      if (!pending) return;
      if (pending.timeout) clearTimeout(pending.timeout);
      pendingByStopId.delete(stopId);
      if (pendingByStopId.size === 0) this.#pendingByChatId.delete(chatId);
      return;
    }
    for (const pending of pendingByStopId.values()) {
      if (pending.timeout) clearTimeout(pending.timeout);
    }
    this.#pendingByChatId.delete(chatId);
  }

  #settle(chatId: string, pending: PendingStopSettlement): void {
    if (this.#pendingByChatId.get(chatId)?.get(pending.stopId) !== pending) return;
    this.discard(chatId, pending.stopId);
    this.#pendingInputs.settleNativeCohort(pending.cohort).catch(this.#onSettlementError);
  }

  #hasTurnIdentity(turn: TurnEventMetadata | undefined): boolean {
    return Boolean(turn?.turnId || turn?.clientRequestId);
  }
}
