import type { AgentExecutionAdmission, RunAgentTurnOptions } from '../agents/session-types.ts';
import type { StoredChatExecutionControlState } from '../chat-execution-control-state.ts';
import { DomainError } from '../lib/domain-error.ts';
import type { TurnIdentity } from '../lib/turn-identity.ts';
import type { QueueExecutionAttempt } from './execution-attempt.ts';
import type { ExecutionOwnership } from './execution-ownership.ts';
import {
  executionTurnIdentity,
  type DirectTurnReservation,
} from './types.ts';

export interface DirectTurnLifecycleHost {
  assertRecoveryReady(): void;
  isShuttingDown(): boolean;
  chatExists(chatId: string): boolean;
  isProviderRunning(chatId: string): boolean;
  consumeEmptyContinuation(
    chatId: string,
    checkpoint: () => void,
  ): Promise<{ changed: boolean; control: StoredChatExecutionControlState }>;
  continueRecoveredInput(chatId: string): void;
  runProvider(chatId: string, content: string, options: RunAgentTurnOptions): Promise<void>;
  publishTurnFailed(chatId: string, message: string, options: RunAgentTurnOptions): void;
  publishTurnSettled(chatId: string, turn: TurnIdentity | undefined): void;
  triggerDrain(chatId: string): Promise<void>;
}

export class DirectTurnLifecycle {
  constructor(
    private readonly ownership: ExecutionOwnership,
    private readonly host: DirectTurnLifecycleHost,
  ) {}

  reserve(chatId: string, turn: TurnIdentity = {}): DirectTurnReservation {
    this.host.assertRecoveryReady();
    if (this.host.isShuttingDown()) {
      throw new DomainError('SERVER_SHUTTING_DOWN', 'The server is shutting down', 503, true);
    }
    if (this.ownership.hasOwner(chatId) || this.host.isProviderRunning(chatId)) {
      throw new DomainError('SESSION_BUSY', 'Another chat turn already owns execution', 409, true);
    }
    return this.ownership.reserveDirect(chatId, turn);
  }

  checkpoint(reservation: DirectTurnReservation): void {
    this.host.assertRecoveryReady();
    if (!this.ownership.isDirectCurrent(reservation)) {
      throw new DomainError('SESSION_BUSY', 'Direct turn reservation is no longer active', 409, true);
    }
  }

  async consumeRecoveredInput(
    reservation: DirectTurnReservation,
  ): Promise<StoredChatExecutionControlState> {
    const checkpoint = () => {
      this.checkpoint(reservation);
      reservation.executionAdmission.signal.throwIfAborted();
    };
    checkpoint();
    const result = await this.host.consumeEmptyContinuation(reservation.chatId, checkpoint);
    if (result.changed) this.host.continueRecoveredInput(reservation.chatId);
    return result.control;
  }

  async release(reservation: DirectTurnReservation): Promise<void> {
    await this.#finish(reservation, 'released');
  }

  async complete(reservation: DirectTurnReservation): Promise<void> {
    await this.#finish(reservation, 'completed');
  }

  async fail(reservation: DirectTurnReservation): Promise<void> {
    await this.#finish(reservation, 'failed');
  }

  async run(
    reservation: DirectTurnReservation,
    content: string,
    options: RunAgentTurnOptions,
    dispatch?: (admission: AgentExecutionAdmission) => Promise<void>,
    beforeFailureRelease?: (error: unknown) => Promise<void>,
  ): Promise<void> {
    this.host.assertRecoveryReady();
    this.checkpoint(reservation);
    const identity = executionTurnIdentity(options);
    const attempt = this.ownership.attempt(reservation.chatId);
    if (!attempt) throw new Error('Direct turn execution attempt is missing');
    if (identity && !attempt.matches(identity)) attempt.replaceReservedTurn(identity);
    attempt.markLaunching();
    let outcome: 'completed' | 'failed' = 'failed';
    try {
      reservation.executionAdmission.signal.throwIfAborted();
      if (dispatch) {
        await dispatch(reservation.executionAdmission);
      } else {
        await this.host.runProvider(reservation.chatId, content, {
          ...options,
          ...(this.ownership.usesRecoveredHistory(reservation.chatId)
            ? { directHistoryRecovery: 'allow-empty' as const }
            : {}),
          executionAdmission: reservation.executionAdmission,
        });
      }
      outcome = 'completed';
    } catch (error: unknown) {
      let failure = error;
      if (beforeFailureRelease) {
        try {
          await beforeFailureRelease(error);
        } catch (cleanupError) {
          failure = new AggregateError(
            [error, cleanupError],
            `Direct input cleanup failed for ${reservation.chatId}`,
          );
        }
      }
      const message = failure instanceof Error ? failure.message : String(failure);
      if (!reservation.executionAdmission.signal.aborted) {
        this.host.publishTurnFailed(reservation.chatId, message, options);
      }
      throw failure;
    } finally {
      await this.#finish(reservation, outcome);
    }
  }

  onTerminal(chatId: string, turn: TurnIdentity | undefined): void {
    const attempt = this.ownership.attempt(chatId);
    if (!attempt?.matches(turn)) return;
    attempt.markTerminalObserved();
    this.settleAttempt(chatId, attempt);
  }

  settleAttempt(chatId: string, attempt: QueueExecutionAttempt): void {
    if (!attempt.isSettlementReady) return;
    if (!this.ownership.isCurrentAttempt(chatId, attempt)) return;
    attempt.markSettled();
    this.ownership.removeAttempt(chatId, attempt);
    this.host.publishTurnSettled(chatId, attempt.identity());
    this.ownership.notifyOwnersChanged();
  }

  async #finish(
    reservation: DirectTurnReservation,
    outcome: 'released' | 'completed' | 'failed',
  ): Promise<void> {
    if (!this.ownership.isDirectCurrent(reservation)) {
      if (!this.host.chatExists(reservation.chatId)) return;
      throw new Error('Direct turn reservation is no longer active');
    }
    this.ownership.releaseDirect(reservation);
    const attempt = this.ownership.attempt(reservation.chatId);
    if (attempt) {
      attempt.markRunSettled();
      if (outcome === 'released' || !this.host.isProviderRunning(reservation.chatId)) {
        attempt.markTerminalObserved();
      }
      this.settleAttempt(reservation.chatId, attempt);
    }
    const drainRequested = this.ownership.hasDrainRequest(reservation.chatId);
    this.ownership.notifyOwnersChanged();
    if (!this.host.chatExists(reservation.chatId) || this.host.isShuttingDown()) return;
    if (outcome === 'completed' || drainRequested) await this.host.triggerDrain(reservation.chatId);
  }
}
