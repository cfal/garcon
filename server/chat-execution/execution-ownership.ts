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

// One chat's runtime execution state. Collapsing the former twelve parallel
// per-chat collections into a single record makes the invariants ("a chat cannot
// drain while holding a direct reservation") checkable in one place and lets a
// single garbage-collection step retire a chat once every field is back to rest.
interface ChatExecutionState {
  draining: boolean;
  directReservationId: string | null;
  directAdmission: AbortController | null;
  drainAdmission: AbortController | null;
  activeDrainEntryId: string | null;
  shutdownDrainEntryId: string | null;
  drainRequested: boolean;
  suppressions: Set<DrainSuppressionReason>;
  attempt: QueueExecutionAttempt | null;
  sessionStop: SessionStopInFlight | null;
  drainStop: SessionStopInFlight | null;
  recoveredInputContinued: boolean;
}

function emptyChatExecutionState(): ChatExecutionState {
  return {
    draining: false,
    directReservationId: null,
    directAdmission: null,
    drainAdmission: null,
    activeDrainEntryId: null,
    shutdownDrainEntryId: null,
    drainRequested: false,
    suppressions: new Set(),
    attempt: null,
    sessionStop: null,
    drainStop: null,
    recoveredInputContinued: false,
  };
}

function isIdle(state: ChatExecutionState): boolean {
  return !state.draining
    && state.directReservationId === null
    && state.directAdmission === null
    && state.drainAdmission === null
    && state.activeDrainEntryId === null
    && state.shutdownDrainEntryId === null
    && !state.drainRequested
    && state.suppressions.size === 0
    && state.attempt === null
    && state.sessionStop === null
    && state.drainStop === null
    && !state.recoveredInputContinued;
}

export class ExecutionOwnership {
  readonly #chats = new Map<string, ChatExecutionState>();
  readonly #ownerWaiters = new Set<() => void>();
  readonly #turnFinalizations = new QueuedTurnFinalizationTracker();

  #state(chatId: string): ChatExecutionState {
    let state = this.#chats.get(chatId);
    if (!state) {
      state = emptyChatExecutionState();
      this.#chats.set(chatId, state);
    }
    return state;
  }

  // Retires a chat once it holds no live state, replacing the scattered per-field
  // deletes that previously risked orphaning one collection while clearing another.
  #gc(chatId: string): void {
    const state = this.#chats.get(chatId);
    if (state && isIdle(state)) this.#chats.delete(chatId);
  }

  beginShutdown(reason: Error): string[] {
    for (const state of this.#chats.values()) {
      state.directAdmission?.abort(reason);
      if (state.activeDrainEntryId !== null) state.shutdownDrainEntryId = state.activeDrainEntryId;
      state.drainAdmission?.abort(reason);
    }
    const owners = new Set<string>();
    for (const [chatId, state] of this.#chats) if (state.directReservationId !== null) owners.add(chatId);
    for (const [chatId, state] of this.#chats) if (state.draining) owners.add(chatId);
    for (const [chatId, state] of this.#chats) if (state.attempt !== null) owners.add(chatId);
    return [...owners];
  }

  abortAdmission(chatId: string, reason: Error): void {
    const state = this.#chats.get(chatId);
    if (!state) return;
    if (state.activeDrainEntryId !== null) state.shutdownDrainEntryId = state.activeDrainEntryId;
    state.directAdmission?.abort(reason);
    state.drainAdmission?.abort(reason);
  }

  hasAnyOwner(): boolean {
    for (const state of this.#chats.values()) {
      if (state.draining || state.directReservationId !== null || state.attempt !== null) return true;
    }
    return false;
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
    const state = this.#chats.get(chatId);
    return state !== undefined
      && (state.draining || state.directReservationId !== null || state.attempt !== null);
  }

  isReserved(chatId: string): boolean {
    const state = this.#chats.get(chatId);
    return state !== undefined && (state.draining || state.directReservationId !== null);
  }

  reserveDirect(chatId: string, turn: TurnIdentity): DirectTurnReservation {
    const state = this.#state(chatId);
    if (state.draining) throw new Error('Cannot reserve a direct turn while draining');
    const admissionController = new AbortController();
    const reservation = Object.freeze({
      chatId,
      reservationId: crypto.randomUUID(),
      executionAdmission: Object.freeze<AgentExecutionAdmission>({
        signal: admissionController.signal,
        markStarted: () => undefined,
      }),
    });
    state.directReservationId = reservation.reservationId;
    state.directAdmission = admissionController;
    const identity = executionTurnIdentity(turn) ?? { turnId: crypto.randomUUID() };
    state.attempt = new QueueExecutionAttempt(identity);
    return reservation;
  }

  hasDirect(chatId: string): boolean {
    const state = this.#chats.get(chatId);
    return state !== undefined && state.directReservationId !== null;
  }

  isDirectCurrent(reservation: DirectTurnReservation): boolean {
    return this.#chats.get(reservation.chatId)?.directReservationId === reservation.reservationId;
  }

  releaseDirect(reservation: DirectTurnReservation): void {
    const state = this.#chats.get(reservation.chatId);
    if (!state) return;
    state.directReservationId = null;
    this.#gc(reservation.chatId);
  }

  isDraining(chatId: string): boolean {
    return this.#chats.get(chatId)?.draining === true;
  }

  beginDrain(chatId: string): void {
    const state = this.#state(chatId);
    if (state.directReservationId !== null) {
      throw new Error('Cannot drain a chat holding a direct reservation');
    }
    state.draining = true;
  }

  endDrain(chatId: string): void {
    const state = this.#chats.get(chatId);
    if (!state) return;
    state.draining = false;
    state.drainAdmission = null;
    state.activeDrainEntryId = null;
    state.shutdownDrainEntryId = null;
    state.drainStop = null;
    this.#gc(chatId);
  }

  setActiveDrainEntry(chatId: string, entryId: string): void {
    this.#state(chatId).activeDrainEntryId = entryId;
  }

  activeDrainEntry(chatId: string): string | undefined {
    return this.#chats.get(chatId)?.activeDrainEntryId ?? undefined;
  }

  setDrainAdmission(chatId: string, controller: AbortController): void {
    this.#state(chatId).drainAdmission = controller;
  }

  shutdownTargetsEntry(chatId: string, entryId: string): boolean {
    return this.#chats.get(chatId)?.shutdownDrainEntryId === entryId;
  }

  attempt(chatId: string): QueueExecutionAttempt | undefined {
    return this.#chats.get(chatId)?.attempt ?? undefined;
  }

  hasAttempt(chatId: string): boolean {
    const state = this.#chats.get(chatId);
    return state !== undefined && state.attempt !== null;
  }

  installAttempt(chatId: string, attempt: QueueExecutionAttempt): void {
    const state = this.#state(chatId);
    if (state.attempt !== null) {
      throw new Error('Another chat turn already owns execution');
    }
    state.attempt = attempt;
  }

  isCurrentAttempt(chatId: string, attempt: QueueExecutionAttempt): boolean {
    return this.#chats.get(chatId)?.attempt === attempt;
  }

  removeAttempt(chatId: string, attempt: QueueExecutionAttempt): boolean {
    const state = this.#chats.get(chatId);
    if (!state || state.attempt !== attempt) return false;
    state.attempt = null;
    state.directAdmission = null;
    this.#gc(chatId);
    return true;
  }

  isAttemptRetired(chatId: string, attempt: QueueExecutionAttempt | undefined): boolean {
    return !attempt || (attempt.isSettled && !this.isCurrentAttempt(chatId, attempt));
  }

  requestDrain(chatId: string): void {
    this.#state(chatId).drainRequested = true;
  }

  consumeDrainRequest(chatId: string): void {
    const state = this.#chats.get(chatId);
    if (!state) return;
    state.drainRequested = false;
    this.#gc(chatId);
  }

  hasDrainRequest(chatId: string): boolean {
    return this.#chats.get(chatId)?.drainRequested === true;
  }

  hasSuppression(chatId: string, reason: DrainSuppressionReason): boolean {
    return this.#chats.get(chatId)?.suppressions.has(reason) === true;
  }

  enterAbortSuppression(chatId: string): void {
    this.#addSuppression(chatId, 'abort');
  }

  clearAbortSuppression(chatId: string): void {
    this.#removeSuppression(chatId, 'abort');
  }

  enterManualStop(chatId: string): void {
    this.#addSuppression(chatId, 'manual-stop');
  }

  // Releases the manual-stop hold unless a drain that predated the stop is still
  // running; that case keeps the hold so the running drain observes the stop and exits.
  exitManualStop(chatId: string, options: { drainStillActive: boolean }): void {
    if (options.drainStillActive) return;
    this.#removeSuppression(chatId, 'manual-stop');
  }

  enterDeletionSuppression(chatId: string): void {
    this.#addSuppression(chatId, 'deletion');
  }

  clearDeletionSuppression(chatId: string): void {
    this.#removeSuppression(chatId, 'deletion');
  }

  #addSuppression(chatId: string, reason: DrainSuppressionReason): void {
    this.#state(chatId).suppressions.add(reason);
  }

  #removeSuppression(chatId: string, reason: DrainSuppressionReason): void {
    const state = this.#chats.get(chatId);
    if (!state) return;
    state.suppressions.delete(reason);
    this.#gc(chatId);
  }

  // Clears a chat's transient execution state on reset/deletion. Deliberately
  // preserves `draining` and any in-flight session stop, matching the prior
  // per-collection clear that left `#draining`/`#sessionStops` untouched.
  clearChat(chatId: string, reason: Error): void {
    const state = this.#chats.get(chatId);
    if (state) {
      state.suppressions.clear();
      state.drainRequested = false;
      state.directReservationId = null;
      state.directAdmission?.abort(reason);
      state.directAdmission = null;
      state.drainAdmission?.abort(reason);
      state.drainAdmission = null;
      state.activeDrainEntryId = null;
      state.shutdownDrainEntryId = null;
      state.attempt?.markSettled();
      state.attempt = null;
      state.drainStop = null;
      state.recoveredInputContinued = false;
    }
    this.#turnFinalizations.clearChat(chatId);
    this.#gc(chatId);
    this.notifyOwnersChanged();
  }

  reserveStop(chatId: string, intent: ChatStopIntent): SessionStopInFlight {
    const state = this.#state(chatId);
    if (state.sessionStop) return state.sessionStop;
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
    state.sessionStop = operation;
    if (state.draining && !state.drainStop) {
      state.drainStop = operation;
    }
    return operation;
  }

  stop(chatId: string): SessionStopInFlight | undefined {
    return this.#chats.get(chatId)?.sessionStop ?? undefined;
  }

  clearStop(chatId: string, operation: SessionStopInFlight): void {
    const state = this.#chats.get(chatId);
    if (!state || state.sessionStop !== operation) return;
    state.sessionStop = null;
    this.#gc(chatId);
  }

  drainStop(chatId: string): SessionStopInFlight | undefined {
    return this.#chats.get(chatId)?.drainStop ?? undefined;
  }

  consumeDrainStop(chatId: string, operation: SessionStopInFlight): void {
    const state = this.#chats.get(chatId);
    if (!state || state.drainStop !== operation) return;
    state.drainStop = null;
    this.#gc(chatId);
  }

  continueRecoveredInput(chatId: string): void {
    this.#state(chatId).recoveredInputContinued = true;
  }

  settleRecoveredInput(chatId: string): void {
    const state = this.#chats.get(chatId);
    if (!state) return;
    state.recoveredInputContinued = false;
    this.#gc(chatId);
  }

  usesRecoveredHistory(chatId: string): boolean {
    return this.#chats.get(chatId)?.recoveredInputContinued === true;
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
