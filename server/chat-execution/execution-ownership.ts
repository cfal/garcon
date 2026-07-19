import crypto from 'crypto';
import type { ChatStopIntent } from '../../common/chat-types.ts';
import type { AgentExecutionAdmission } from '../agents/session-types.ts';
import type { TurnIdentity } from '../lib/turn-identity.ts';
import { QueueExecutionAttempt } from './execution-attempt.ts';
import {
  QueuedTurnFinalizationTracker,
  type QueuedTurnFinalizationHandle,
  type QueuedTurnFinalizationOutcome,
} from './turn-finalization-tracker.ts';
import type {
  DirectTurnReservation,
  DrainSuppressionReason,
  SessionStopInFlight,
} from './types.ts';
import { executionTurnIdentity } from './types.ts';

export class ExecutionOwnership {
  readonly #draining = new Set<string>();
  readonly #directTurns = new Map<string, string>();
  readonly #directAdmissions = new Map<string, AbortController>();
  readonly #drainAdmissions = new Map<string, AbortController>();
  readonly #activeDrainEntries = new Map<string, string>();
  readonly #shutdownDrainAborts = new Map<string, string>();
  readonly #ownerWaiters = new Set<() => void>();
  readonly #pendingDrainRequests = new Set<string>();
  readonly #drainSuppressions = new Map<string, Set<DrainSuppressionReason>>();
  readonly #executionAttempts = new Map<string, QueueExecutionAttempt>();
  readonly #turnFinalizations = new QueuedTurnFinalizationTracker();
  readonly #sessionStops = new Map<string, SessionStopInFlight>();
  readonly #drainStops = new Map<string, SessionStopInFlight>();
  readonly #continuedRecoveredInputs = new Set<string>();

  beginShutdown(reason: Error): string[] {
    for (const controller of this.#directAdmissions.values()) controller.abort(reason);
    for (const [chatId, entryId] of this.#activeDrainEntries) {
      this.#shutdownDrainAborts.set(chatId, entryId);
    }
    for (const controller of this.#drainAdmissions.values()) controller.abort(reason);
    return [...new Set([
      ...this.#directTurns.keys(),
      ...this.#draining,
      ...this.#executionAttempts.keys(),
    ])];
  }

  abortAdmission(chatId: string, reason: Error): void {
    const entryId = this.#activeDrainEntries.get(chatId);
    if (entryId) this.#shutdownDrainAborts.set(chatId, entryId);
    this.#directAdmissions.get(chatId)?.abort(reason);
    this.#drainAdmissions.get(chatId)?.abort(reason);
  }

  hasAnyOwner(): boolean {
    return this.#draining.size > 0
      || this.#directTurns.size > 0
      || this.#executionAttempts.size > 0;
  }

  async waitForOwners(): Promise<void> {
    while (this.hasAnyOwner()) {
      await new Promise<void>((resolve) => {
        this.#ownerWaiters.add(resolve);
        if (!this.hasAnyOwner()) {
          this.#ownerWaiters.delete(resolve);
          resolve();
        }
      });
    }
  }

  notifyOwnersChanged(): void {
    for (const resolve of this.#ownerWaiters) resolve();
    this.#ownerWaiters.clear();
  }

  hasOwner(chatId: string): boolean {
    return this.#draining.has(chatId)
      || this.#directTurns.has(chatId)
      || this.#executionAttempts.has(chatId);
  }

  isReserved(chatId: string): boolean {
    return this.#draining.has(chatId) || this.#directTurns.has(chatId);
  }

  reserveDirect(chatId: string, turn: TurnIdentity): DirectTurnReservation {
    const admissionController = new AbortController();
    const reservation = Object.freeze({
      chatId,
      reservationId: crypto.randomUUID(),
      executionAdmission: Object.freeze<AgentExecutionAdmission>({
        signal: admissionController.signal,
        markStarted: () => undefined,
      }),
    });
    this.#directTurns.set(chatId, reservation.reservationId);
    this.#directAdmissions.set(chatId, admissionController);
    const identity = executionTurnIdentity(turn) ?? { turnId: crypto.randomUUID() };
    this.#executionAttempts.set(chatId, new QueueExecutionAttempt(identity));
    return reservation;
  }

  hasDirect(chatId: string): boolean {
    return this.#directTurns.has(chatId);
  }

  isDirectCurrent(reservation: DirectTurnReservation): boolean {
    return this.#directTurns.get(reservation.chatId) === reservation.reservationId;
  }

  releaseDirect(reservation: DirectTurnReservation): void {
    this.#directTurns.delete(reservation.chatId);
  }

  isDraining(chatId: string): boolean {
    return this.#draining.has(chatId);
  }

  beginDrain(chatId: string): void {
    this.#draining.add(chatId);
  }

  endDrain(chatId: string): void {
    this.#draining.delete(chatId);
    this.#drainAdmissions.delete(chatId);
    this.#activeDrainEntries.delete(chatId);
    this.#shutdownDrainAborts.delete(chatId);
    this.#drainStops.delete(chatId);
  }

  setActiveDrainEntry(chatId: string, entryId: string): void {
    this.#activeDrainEntries.set(chatId, entryId);
  }

  activeDrainEntry(chatId: string): string | undefined {
    return this.#activeDrainEntries.get(chatId);
  }

  setDrainAdmission(chatId: string, controller: AbortController): void {
    this.#drainAdmissions.set(chatId, controller);
  }

  shutdownTargetsEntry(chatId: string, entryId: string): boolean {
    return this.#shutdownDrainAborts.get(chatId) === entryId;
  }

  attempt(chatId: string): QueueExecutionAttempt | undefined {
    return this.#executionAttempts.get(chatId);
  }

  hasAttempt(chatId: string): boolean {
    return this.#executionAttempts.has(chatId);
  }

  installAttempt(chatId: string, attempt: QueueExecutionAttempt): void {
    if (this.#executionAttempts.has(chatId)) {
      throw new Error('Another chat turn already owns execution');
    }
    this.#executionAttempts.set(chatId, attempt);
  }

  isCurrentAttempt(chatId: string, attempt: QueueExecutionAttempt): boolean {
    return this.#executionAttempts.get(chatId) === attempt;
  }

  removeAttempt(chatId: string, attempt: QueueExecutionAttempt): boolean {
    if (!this.isCurrentAttempt(chatId, attempt)) return false;
    this.#executionAttempts.delete(chatId);
    this.#directAdmissions.delete(chatId);
    return true;
  }

  isAttemptRetired(chatId: string, attempt: QueueExecutionAttempt | undefined): boolean {
    return !attempt || (attempt.isSettled && !this.isCurrentAttempt(chatId, attempt));
  }

  requestDrain(chatId: string): void {
    this.#pendingDrainRequests.add(chatId);
  }

  consumeDrainRequest(chatId: string): void {
    this.#pendingDrainRequests.delete(chatId);
  }

  hasDrainRequest(chatId: string): boolean {
    return this.#pendingDrainRequests.has(chatId);
  }

  addSuppression(chatId: string, reason: DrainSuppressionReason): void {
    const reasons = this.#drainSuppressions.get(chatId) ?? new Set();
    reasons.add(reason);
    this.#drainSuppressions.set(chatId, reasons);
  }

  removeSuppression(chatId: string, reason: DrainSuppressionReason): void {
    const reasons = this.#drainSuppressions.get(chatId);
    if (!reasons) return;
    reasons.delete(reason);
    if (reasons.size === 0) this.#drainSuppressions.delete(chatId);
  }

  hasSuppression(chatId: string, reason: DrainSuppressionReason): boolean {
    return this.#drainSuppressions.get(chatId)?.has(reason) === true;
  }

  clearChat(chatId: string, reason: Error): void {
    this.#drainSuppressions.delete(chatId);
    this.#pendingDrainRequests.delete(chatId);
    this.#directTurns.delete(chatId);
    this.#directAdmissions.get(chatId)?.abort(reason);
    this.#directAdmissions.delete(chatId);
    this.#drainAdmissions.get(chatId)?.abort(reason);
    this.#drainAdmissions.delete(chatId);
    this.#activeDrainEntries.delete(chatId);
    this.#shutdownDrainAborts.delete(chatId);
    this.#turnFinalizations.clearChat(chatId);
    this.#executionAttempts.get(chatId)?.markSettled();
    this.#executionAttempts.delete(chatId);
    this.#drainStops.delete(chatId);
    this.#continuedRecoveredInputs.delete(chatId);
    this.notifyOwnersChanged();
  }

  reserveStop(chatId: string, intent: ChatStopIntent): SessionStopInFlight {
    const existing = this.#sessionStops.get(chatId);
    if (existing) return existing;
    let resolveStop!: (success: boolean) => void;
    let rejectStop!: (error: unknown) => void;
    const promise = new Promise<boolean>((resolve, reject) => {
      resolveStop = resolve;
      rejectStop = reject;
    });
    const operation: SessionStopInFlight = {
      intent,
      stopId: crypto.randomUUID(),
      promise,
      resolve: resolveStop,
      reject: rejectStop,
      started: false,
    };
    this.#sessionStops.set(chatId, operation);
    if (this.#draining.has(chatId) && !this.#drainStops.has(chatId)) {
      this.#drainStops.set(chatId, operation);
    }
    return operation;
  }

  stop(chatId: string): SessionStopInFlight | undefined {
    return this.#sessionStops.get(chatId);
  }

  clearStop(chatId: string, operation: SessionStopInFlight): void {
    if (this.#sessionStops.get(chatId) === operation) this.#sessionStops.delete(chatId);
  }

  drainStop(chatId: string): SessionStopInFlight | undefined {
    return this.#drainStops.get(chatId);
  }

  consumeDrainStop(chatId: string, operation: SessionStopInFlight): void {
    if (this.#drainStops.get(chatId) === operation) this.#drainStops.delete(chatId);
  }

  continueRecoveredInput(chatId: string): void {
    this.#continuedRecoveredInputs.add(chatId);
  }

  settleRecoveredInput(chatId: string): void {
    this.#continuedRecoveredInputs.delete(chatId);
  }

  usesRecoveredHistory(chatId: string): boolean {
    return this.#continuedRecoveredInputs.has(chatId);
  }

  beginFinalization(chatId: string, turnId: string): QueuedTurnFinalizationHandle {
    return this.#turnFinalizations.begin(chatId, turnId);
  }

  finalization(
    chatId: string,
    turnId: string | undefined,
  ): Promise<QueuedTurnFinalizationOutcome> | null {
    return this.#turnFinalizations.get(chatId, turnId);
  }
}
