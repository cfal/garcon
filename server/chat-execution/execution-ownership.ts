import crypto from 'crypto';
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
  TranscriptSnapshotReservation,
} from './types.ts';
import { executionTurnIdentity } from './types.ts';

// Exactly one of these owns a chat at a time, which the reserve methods enforce. Handles that
// only mean something during a drain live inside that variant so they cannot outlast it.
type ChatOwner =
  | { readonly kind: 'idle' }
  | { readonly kind: 'direct'; readonly reservationId: string }
  | {
      readonly kind: 'draining';
      activeEntryId: string | null;
    }
  | { readonly kind: 'snapshot'; readonly reservationId: string };

const IDLE_OWNER: ChatOwner = { kind: 'idle' };

interface ChatExecutionState {
  owner: ChatOwner;
  // Outlives the owner that created it: a finished turn keeps the chat owned until its terminal
  // event retires it, so its admission handle is released with the attempt, not the reservation.
  turn: { attempt: QueueExecutionAttempt; admissionController: AbortController } | null;
  // Intent recorded while something else owns the chat.
  pending: { drainRequested: boolean; suppressions: Set<DrainSuppressionReason> };
  repairSnapshot: TranscriptSnapshotReservation | null;
}

function ownsExecution(state: ChatExecutionState): boolean {
  return state.owner.kind !== 'idle' || state.turn !== null || state.repairSnapshot !== null;
}

// A turn the user started holds the chat: a direct reservation, or the queue entry a drain is
// currently running. A drain between entries and a settling turn are excluded.
function isTurnReservedState(state: ChatExecutionState): boolean {
  return state.owner.kind === 'direct'
    || (state.owner.kind === 'draining' && state.owner.activeEntryId !== null);
}

function emptyChatExecutionState(): ChatExecutionState {
  return {
    owner: IDLE_OWNER,
    turn: null,
    pending: { drainRequested: false, suppressions: new Set() },
    repairSnapshot: null,
  };
}

function createExecutionAdmission(): {
  readonly admissionController: AbortController;
  readonly executionAdmission: AgentExecutionAdmission;
} {
  const admissionController = new AbortController();
  return {
    admissionController,
    executionAdmission: Object.freeze({
      signal: admissionController.signal,
      markStarted: async () => {},
    }),
  };
}

function isIdle(state: ChatExecutionState): boolean {
  return !ownsExecution(state)
    && !state.pending.drainRequested
    && state.pending.suppressions.size === 0;
}

export class ExecutionOwnership {
  readonly #chats = new Map<string, ChatExecutionState>();
  readonly #ownerWaiters = new Set<() => void>();
  readonly #chatOwnerWaiters = new Map<string, Set<() => void>>();
  readonly #turnFinalizations = new QueuedTurnFinalizationTracker();

  #state(chatId: string): ChatExecutionState {
    let state = this.#chats.get(chatId);
    if (!state) {
      state = emptyChatExecutionState();
      this.#chats.set(chatId, state);
    }
    return state;
  }

  // Shutdown aborts whichever admissions are live. Provider abort is handled separately and
  // never delays ownership retirement.
  #abortAdmissions(state: ChatExecutionState, reason: Error): void {
    state.turn?.admissionController.abort(reason);
  }

  // Drain handles only exist while a drain owns the chat. The drainer sets them between
  // beginDrain and endDrain, so reaching here otherwise means a caller escaped that window.
  #requireDraining(chatId: string, action: string): Extract<ChatOwner, { kind: 'draining' }> {
    const state = this.#chats.get(chatId);
    if (state?.owner.kind !== 'draining') {
      throw new Error(`Cannot ${action} for a chat that is not draining`);
    }
    return state.owner;
  }

  // Retires the complete record once the chat holds no live execution state.
  #gc(chatId: string): void {
    const state = this.#chats.get(chatId);
    if (state && isIdle(state)) this.#chats.delete(chatId);
  }

  beginShutdown(reason: Error): string[] {
    const owners: string[] = [];
    for (const [chatId, state] of this.#chats) {
      this.#abortAdmissions(state, reason);
      if (ownsExecution(state)) owners.push(chatId);
      this.notifyOwnersChanged(chatId);
    }
    for (const chatId of [...this.#chatOwnerWaiters.keys()]) {
      this.notifyOwnersChanged(chatId);
    }
    return owners;
  }

  abortAdmission(chatId: string, reason: Error): void {
    const state = this.#chats.get(chatId);
    if (!state) return;
    this.#abortAdmissions(state, reason);
  }

  hasAnyOwner(): boolean {
    for (const state of this.#chats.values()) if (ownsExecution(state)) return true;
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

  // Watches the complete coordinator admission route. External busy inputs, including provider
  // run state, notify this watch when they change.
  watchOwnerChange(chatId: string): { readonly promise: Promise<void>; cancel(): void } {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    let waiters = this.#chatOwnerWaiters.get(chatId);
    if (!waiters) {
      waiters = new Set();
      this.#chatOwnerWaiters.set(chatId, waiters);
    }
    const complete = () => {
      this.#deleteChatOwnerWaiter(chatId, complete);
      resolve();
    };
    waiters.add(complete);
    return {
      promise,
      cancel: () => this.#deleteChatOwnerWaiter(chatId, complete),
    };
  }

  notifyOwnersChanged(chatId: string): void {
    for (const resolve of this.#ownerWaiters) resolve();
    this.#ownerWaiters.clear();
    for (const resolve of [...(this.#chatOwnerWaiters.get(chatId) ?? [])]) resolve();
  }

  #deleteChatOwnerWaiter(chatId: string, waiter: () => void): void {
    const waiters = this.#chatOwnerWaiters.get(chatId);
    if (!waiters) return;
    waiters.delete(waiter);
    if (waiters.size === 0) this.#chatOwnerWaiters.delete(chatId);
  }

  hasOwner(chatId: string): boolean {
    const state = this.#chats.get(chatId);
    return state !== undefined && ownsExecution(state);
  }

  isTurnReserved(chatId: string): boolean {
    const state = this.#chats.get(chatId);
    return state !== undefined && isTurnReservedState(state);
  }

  turnReservedChatIds(): string[] {
    return [...this.#chats]
      .filter(([, state]) => isTurnReservedState(state))
      .map(([chatId]) => chatId);
  }

  reserveTranscriptSnapshot(chatId: string): TranscriptSnapshotReservation {
    if (this.hasOwner(chatId)) throw new Error('Another chat operation already owns execution');
    const reservation = Object.freeze({ chatId, reservationId: crypto.randomUUID() });
    this.#state(chatId).owner = { kind: 'snapshot', reservationId: reservation.reservationId };
    return reservation;
  }

  hasTranscriptSnapshot(chatId: string): boolean {
    const state = this.#chats.get(chatId);
    return state !== undefined
      && (state.owner.kind === 'snapshot' || state.repairSnapshot !== null);
  }

  releaseTranscriptSnapshot(reservation: TranscriptSnapshotReservation): void {
    const state = this.#chats.get(reservation.chatId);
    if (!state) return;
    if (state.repairSnapshot?.reservationId === reservation.reservationId) {
      state.repairSnapshot = null;
      if (state.owner.kind === 'snapshot'
          && state.owner.reservationId === reservation.reservationId) {
        state.owner = IDLE_OWNER;
      }
      this.#gc(reservation.chatId);
      return;
    }
    if (state.owner.kind !== 'snapshot') return;
    if (state.owner.reservationId !== reservation.reservationId) {
      throw new Error('Transcript snapshot reservation is no longer active');
    }
    state.owner = IDLE_OWNER;
    this.#gc(reservation.chatId);
  }

  replaceTurnWithTranscriptSnapshot(
    chatId: string,
    turn: TurnIdentity,
  ): TranscriptSnapshotReservation | null {
    const state = this.#chats.get(chatId);
    if (!state?.turn?.attempt.matches(turn)) return null;
    if (state.repairSnapshot) return state.repairSnapshot;
    const reservation = Object.freeze({ chatId, reservationId: crypto.randomUUID() });
    state.repairSnapshot = reservation;
    return reservation;
  }

  // Refuses every owner kind, including a direct reservation and a turn still settling. The
  // coordinator already screens callers on the wider `hasOwner || isChatRunning`, so these
  // throws are unreachable through it; they keep the invariant local to the class instead of
  // resting on callers, and they are the only guard against re-reserving the same kind, which
  // would strand the settling attempt this overwrites.
  reserveDirect(chatId: string, turn: TurnIdentity): DirectTurnReservation {
    const state = this.#state(chatId);
    if (ownsExecution(state)) {
      throw new Error('Cannot reserve a direct turn while another operation owns execution');
    }
    const { admissionController, executionAdmission } = createExecutionAdmission();
    const reservation = Object.freeze({
      chatId,
      reservationId: crypto.randomUUID(),
      executionAdmission,
    });
    const identity = executionTurnIdentity(turn) ?? { turnId: crypto.randomUUID() };
    state.owner = { kind: 'direct', reservationId: reservation.reservationId };
    state.turn = { attempt: new QueueExecutionAttempt(identity), admissionController };
    return reservation;
  }

  hasDirect(chatId: string): boolean {
    return this.#chats.get(chatId)?.owner.kind === 'direct';
  }

  isDirectCurrent(reservation: DirectTurnReservation): boolean {
    const owner = this.#chats.get(reservation.chatId)?.owner;
    return owner?.kind === 'direct' && owner.reservationId === reservation.reservationId;
  }

  releaseDirect(reservation: DirectTurnReservation): void {
    const state = this.#chats.get(reservation.chatId);
    if (!state) return;
    if (state.owner.kind === 'direct') {
      state.owner = state.repairSnapshot
        ? { kind: 'snapshot', reservationId: state.repairSnapshot.reservationId }
        : IDLE_OWNER;
    }
    this.#gc(reservation.chatId);
  }

  isDraining(chatId: string): boolean {
    return this.#chats.get(chatId)?.owner.kind === 'draining';
  }

  beginDrain(chatId: string): void {
    const state = this.#state(chatId);
    if (state.owner.kind === 'direct' || state.owner.kind === 'snapshot') {
      throw new Error('Cannot drain a chat holding an execution reservation');
    }
    if (state.owner.kind === 'draining') return;
    state.owner = { kind: 'draining', activeEntryId: null };
  }

  endDrain(chatId: string): void {
    const state = this.#chats.get(chatId);
    if (!state) return;
    if (state.owner.kind === 'draining') {
      state.owner = state.repairSnapshot
        ? { kind: 'snapshot', reservationId: state.repairSnapshot.reservationId }
        : IDLE_OWNER;
    }
    this.#gc(chatId);
  }

  setActiveDrainEntry(chatId: string, entryId: string): void {
    this.#requireDraining(chatId, 'set the active drain entry').activeEntryId = entryId;
  }

  attempt(chatId: string): QueueExecutionAttempt | undefined {
    return this.#chats.get(chatId)?.turn?.attempt ?? undefined;
  }

  hasAttempt(chatId: string): boolean {
    return this.#chats.get(chatId)?.turn != null;
  }

  installAttempt(chatId: string, attempt: QueueExecutionAttempt): AgentExecutionAdmission {
    const state = this.#state(chatId);
    if (state.turn !== null) {
      throw new Error('Another chat turn already owns execution');
    }
    const { admissionController, executionAdmission } = createExecutionAdmission();
    state.turn = { attempt, admissionController };
    return executionAdmission;
  }

  isCurrentAttempt(chatId: string, attempt: QueueExecutionAttempt): boolean {
    return this.#chats.get(chatId)?.turn?.attempt === attempt;
  }

  removeAttempt(chatId: string, attempt: QueueExecutionAttempt): boolean {
    const state = this.#chats.get(chatId);
    if (!state || state.turn?.attempt !== attempt) return false;
    state.turn = null;
    if (state.owner.kind === 'idle' && state.repairSnapshot) {
      state.owner = {
        kind: 'snapshot',
        reservationId: state.repairSnapshot.reservationId,
      };
    }
    this.#gc(chatId);
    return true;
  }

  retireAttempt(chatId: string, attempt: QueueExecutionAttempt, reason?: Error): boolean {
    const state = this.#chats.get(chatId);
    if (!state || state.turn?.attempt !== attempt) return false;
    if (reason) state.turn.admissionController.abort(reason);
    attempt.markSettled();
    state.turn = null;
    if (state.owner.kind === 'direct') {
      state.owner = state.repairSnapshot
        ? { kind: 'snapshot', reservationId: state.repairSnapshot.reservationId }
        : IDLE_OWNER;
    } else if (state.owner.kind === 'draining') {
      state.owner.activeEntryId = null;
    }
    this.#gc(chatId);
    return true;
  }

  isAttemptRetired(chatId: string, attempt: QueueExecutionAttempt | undefined): boolean {
    return !attempt || (attempt.isSettled && !this.isCurrentAttempt(chatId, attempt));
  }

  requestDrain(chatId: string): void {
    this.#state(chatId).pending.drainRequested = true;
  }

  consumeDrainRequest(chatId: string): void {
    const state = this.#chats.get(chatId);
    if (!state) return;
    state.pending.drainRequested = false;
    this.#gc(chatId);
  }

  hasDrainRequest(chatId: string): boolean {
    return this.#chats.get(chatId)?.pending.drainRequested === true;
  }

  hasSuppression(chatId: string, reason: DrainSuppressionReason): boolean {
    return this.#chats.get(chatId)?.pending.suppressions.has(reason) === true;
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
    this.#state(chatId).pending.suppressions.add(reason);
  }

  #removeSuppression(chatId: string, reason: DrainSuppressionReason): void {
    const state = this.#chats.get(chatId);
    if (!state) return;
    state.pending.suppressions.delete(reason);
    this.#gc(chatId);
  }

  // Preserves an active drain while clearing other transient state.
  clearChat(chatId: string, reason: Error): void {
    const state = this.#chats.get(chatId);
    if (state) {
      state.pending.suppressions.clear();
      state.pending.drainRequested = false;
      this.#abortAdmissions(state, reason);
      state.turn?.attempt.markSettled();
      state.turn = null;
      state.repairSnapshot = null;
      // A live drain keeps its ownership while its loop unwinds against a deleted chat, but
      // loses the handles that only describe the entry it was running.
      state.owner = state.owner.kind === 'draining'
        ? { kind: 'draining', activeEntryId: null }
        : IDLE_OWNER;
    }
    this.#turnFinalizations.clearChat(chatId);
    this.#gc(chatId);
    this.notifyOwnersChanged(chatId);
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
