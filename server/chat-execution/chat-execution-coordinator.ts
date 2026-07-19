// Manages per-chat message queues and orchestrates turn execution.
// Extends EventEmitter to notify listeners of queue state changes,
// dispatching events, stop requests, and session stops.

import crypto from 'crypto';
import { EventEmitter } from 'events';
import type { AutomaticQueuePauseKind, QueueEntry } from '../../common/queue-state.ts';
import {
  requireChatExecutionConfig,
  type RunAgentTurnOptions,
} from '../agents/session-types.js';
import type { IChatRegistry } from '../chats/store.js';
import { KeyedPromiseLock } from '../lib/keyed-lock.js';
import { createLogger } from '../lib/log.js';
import { ActiveInputDeliveryError, DomainError } from '../lib/domain-error.js';
import type { TurnIdentity } from '../lib/turn-identity.js';
import {
  type QueuedTurnFinalizationOutcome,
} from './turn-finalization-tracker.js';
import {
  type StoredChatExecutionControlState,
  type StoredQueueEntry,
} from '../chat-execution-control-state.ts';
import {
  JsonChatExecutionControlRepository,
  type ChatExecutionControlRepository,
} from './chat-execution-control-repository.ts';
import {
  type QueueCommandIdentity,
  type ReceiptRetention,
} from './chat-execution-control-transitions.ts';
import {
  EMPTY_RECEIPT_RETENTION,
  type AcceptedActiveInput,
  type AcceptedActiveInputOutcome,
  type AcceptedDirectInput,
  type AcceptedDirectOperation,
  type AcceptedQueueCreate,
  type AcceptedQueueDelete,
  type AcceptedQueueReplace,
  type AgentTurnRunnerPort,
  type ChatExecutionService,
  type ChatExistsResolver,
  type ChatMessagesCallback,
  type ChatMessagesPort,
  type ChatIdleCallback,
  type DirectTurnReservation,
  type DispatchingCallback,
  type DrainSuppressionReason,
  type ExecutionControlUpdatedCallback,
  type PendingInputsPort,
  type PendingUserInputRegistrationOptions,
  type QueueCommandMutationResult,
  type QueueDrainOptionsResolver,
  type SessionStopRequestedCallback,
  type SessionStoppedCallback,
  type StopActiveTurnResult,
  type TurnFailedCallback,
  type TurnSettledCallback,
} from './types.ts';
import { QueueDispatchSaga } from './queue-dispatch-saga.ts';
import { ChatExecutionControlOperations } from './chat-execution-control-operations.ts';
import { ExecutionOwnership } from './execution-ownership.ts';
import { AcceptedInputSaga } from './accepted-input-saga.ts';
import { AcceptedInputTranscript } from './accepted-input-transcript.ts';
import { SessionStopSaga } from './session-stop-saga.ts';
import { DirectTurnLifecycle } from './direct-turn-lifecycle.ts';

export type { QueueCommandIdentity } from './chat-execution-control-transitions.ts';
export {
  QueueEntryMutationError,
  QueuePauseChangedError,
  RecoveredInputContinuationChangedError,
  RecoveredInputContinuationRequiresQueueError,
  type ChatExecutionService,
  type DirectTurnReservation,
  type StopActiveTurnResult,
} from './types.ts';

const logger = createLogger('queue');

export function queueDrainOptions(chatId: string, registry: IChatRegistry): RunAgentTurnOptions {
  const chat = registry.getChat(chatId);
  const entry = requireChatExecutionConfig(chatId, chat);
  return {
    permissionMode: entry.permissionMode,
    thinkingMode: entry.thinkingMode,
    agentSettings: chat ? entry.agentSettingsById[chat.agentId] : undefined,
    model: entry.model,
    apiProviderId: chat?.apiProviderId,
    modelEndpointId: chat?.modelEndpointId,
    modelProtocol: chat?.modelProtocol,
  };
}

export class ChatExecutionCoordinator extends EventEmitter implements ChatExecutionService {
  #locks = new KeyedPromiseLock();
  #shuttingDown = false;
  #ownership = new ExecutionOwnership();
  #dispatchTasks = new Set<Promise<void>>();
  #recoveryFailure: unknown = undefined;
  #turnRunner: AgentTurnRunnerPort;
  #pendingInputs: PendingInputsPort;
  #getDrainOptions: QueueDrainOptionsResolver;
  #chatExists: ChatExistsResolver;
  #dispatchSaga: QueueDispatchSaga;
  #controlOperations: ChatExecutionControlOperations;
  #acceptedInputs: AcceptedInputSaga;
  #acceptedInputTranscript: AcceptedInputTranscript;
  #sessionStops: SessionStopSaga;
  #directTurns: DirectTurnLifecycle;

  constructor(
    workspaceDir: string,
    turnRunner: AgentTurnRunnerPort,
    pendingInputs: PendingInputsPort,
    chatMessages: ChatMessagesPort,
    getDrainOptions: QueueDrainOptionsResolver,
    chatExists: ChatExistsResolver,
    controls: ChatExecutionControlRepository = new JsonChatExecutionControlRepository(workspaceDir),
  ) {
    super();
    if (!turnRunner) throw new Error('ChatExecutionCoordinator requires an agent turn runner');
    if (typeof turnRunner.waitUntilTurnAbortable !== 'function') {
      throw new Error('ChatExecutionCoordinator requires an abortable turn-start boundary');
    }
    if (!pendingInputs) throw new Error('ChatExecutionCoordinator requires a pending input service');
    if (!chatMessages) throw new Error('ChatExecutionCoordinator requires chat message storage');
    if (!getDrainOptions) throw new Error('ChatExecutionCoordinator requires a drain option resolver');
    if (!chatExists) throw new Error('ChatExecutionCoordinator requires a chat existence resolver');
    this.#turnRunner = turnRunner;
    this.#pendingInputs = pendingInputs;
    this.#getDrainOptions = getDrainOptions;
    this.#chatExists = chatExists;
    this.#acceptedInputTranscript = new AcceptedInputTranscript(
      pendingInputs,
      chatMessages,
      {
        appended: (chatId, generationId, messages, metadata) => {
          this.emit('chat-messages', chatId, generationId, messages, metadata);
        },
      },
    );
    this.#controlOperations = new ChatExecutionControlOperations(controls, {
      runExclusive: (chatId, operation) => this.#locks.runExclusive(`chat:${chatId}`, operation),
      assertRecoveryReady: () => this.#assertRecoveryReady(),
      chatExists: (chatId) => this.#chatExists(chatId),
      publish: (chatId, control) => {
        this.emit('execution-control-updated', chatId, control);
      },
    });
    this.#directTurns = new DirectTurnLifecycle(this.#ownership, {
      assertRecoveryReady: () => { this.#assertRecoveryReady(); },
      isShuttingDown: () => this.#shuttingDown,
      chatExists: (chatId) => this.#chatExists(chatId),
      isProviderRunning: (chatId) => this.#turnRunner.isChatRunning(chatId),
      consumeEmptyContinuation: (chatId, checkpoint) => (
        this.#controlOperations.consumeEmptyContinuation(chatId, checkpoint)
      ),
      continueRecoveredInput: (chatId) => { this.#ownership.continueRecoveredInput(chatId); },
      runProvider: (chatId, content, options) => (
        this.#turnRunner.runAgentTurn(chatId, content, options)
      ),
      publishTurnFailed: (chatId, message, options) => {
        this.emit('turn-failed', chatId, message, options);
      },
      publishTurnSettled: (chatId, turn) => { this.emit('turn-settled', chatId, turn); },
      triggerDrain: (chatId) => this.triggerDrain(chatId),
    });
    this.#acceptedInputs = new AcceptedInputSaga({
      createQueueEntry: (chatId, content, command, receipts) => (
        this.createChatQueueEntry(chatId, content, command, receipts)
      ),
      replaceQueueEntry: (chatId, entryId, content, revision, command, receipts) => (
        this.replaceChatQueueEntry(chatId, entryId, content, revision, command, receipts)
      ),
      deleteQueueEntry: (chatId, entryId, command, receipts) => (
        this.deleteChatQueueEntry(chatId, entryId, command, receipts)
      ),
      requestDrain: (chatId, context) => { this.#requestDrain(chatId, context); },
      reserveDirect: (chatId, turn) => this.#directTurns.reserve(chatId, turn),
      checkpoint: (reservation) => {
        this.#directTurns.checkpoint(reservation);
        reservation.executionAdmission.signal.throwIfAborted();
      },
      consumeRecoveredInput: async (reservation) => {
        await this.#directTurns.consumeRecoveredInput(reservation);
      },
      readControl: (chatId) => this.readChatExecutionControl(chatId),
      registerPending: (chatId, content, options) => (
        this.registerPendingUserInput(chatId, content, options)
      ),
      markPendingFailed: (chatId, clientRequestId) => (
        this.#pendingInputs.markFailed(chatId, clientRequestId)
      ),
      releaseDirect: (reservation) => this.#directTurns.release(reservation),
      runDirect: (reservation, content, options, dispatch, beforeFailureRelease) => (
        this.#directTurns.run(reservation, content, options, dispatch, beforeFailureRelease)
      ),
      trackDispatch: (task) => { this.#trackDispatch(task); },
      deliverActive: (chatId, content, options, beforeDelivery) => (
        this.deliverActiveInput(chatId, content, options, beforeDelivery)
      ),
      hasAppliedCreate: (chatId, commandKey, entryId) => (
        this.hasAppliedQueueCreateCommand(chatId, commandKey, entryId)
      ),
    });
    this.#sessionStops = new SessionStopSaga(this.#ownership, this.#turnRunner, {
      pauseQueue: (chatId) => this.pauseChatQueue(chatId),
      readControl: (chatId) => this.readChatExecutionControl(chatId),
      requestDrain: (chatId, context) => { this.#requestDrain(chatId, context); },
      addSuppression: (chatId, reason) => { this.#addDrainSuppression(chatId, reason); },
      removeSuppression: (chatId, reason) => { this.#removeDrainSuppression(chatId, reason); },
      stopRequested: (chatId, stopId, turn) => {
        this.emit('session-stop-requested', chatId, stopId, turn);
      },
      stopped: (chatId, success, intent, stopId) => {
        this.emit('session-stopped', chatId, success, intent, stopId);
      },
      settleAttempt: (chatId, attempt) => { this.#directTurns.settleAttempt(chatId, attempt); },
    });
    this.#dispatchSaga = new QueueDispatchSaga({
      shouldHalt: (chatId) => (
        this.#shuttingDown
        || this.#isDrainSuppressed(chatId)
        || this.#hasDrainSuppression(chatId, 'manual-stop')
        || this.#ownership.hasDirect(chatId)
        || this.#ownership.stop(chatId) !== undefined
        || this.#turnRunner.isChatRunning(chatId)
      ),
      isShuttingDown: () => this.#shuttingDown,
      hasManualStop: (chatId) => this.#hasDrainSuppression(chatId, 'manual-stop'),
      interruptInFlight: (chatId) => {
        const stop = this.#ownership.stop(chatId);
        return stop?.intent === 'interrupt-and-send' ? stop.promise : null;
      },
      popNext: (chatId) => this.popNextChat(chatId),
      readControl: (chatId) => this.readChatExecutionControl(chatId),
      setActiveEntry: (chatId, entryId) => { this.#ownership.setActiveDrainEntry(chatId, entryId); },
      setAdmissionController: (chatId, controller) => {
        this.#ownership.setDrainAdmission(chatId, controller);
      },
      shutdownTargetsEntry: (chatId, entryId) => this.#ownership.shutdownTargetsEntry(chatId, entryId),
      resolveOptions: (chatId) => this.#getDrainOptions(chatId),
      usesRecoveredHistory: (chatId) => this.#ownership.usesRecoveredHistory(chatId),
      beginFinalization: (chatId, turnId) => this.#ownership.beginFinalization(chatId, turnId),
      installAttempt: (chatId, attempt) => { this.#ownership.installAttempt(chatId, attempt); },
      registerPending: (chatId, content, options) => (
        this.registerPendingUserInput(chatId, content, options)
      ),
      publishDispatching: (chatId, entry) => {
        this.emit('dispatching', chatId, entry.id, entry.content);
      },
      waitUntilTurnAbortable: (chatId, turn, signal) => (
        this.#turnRunner.waitUntilTurnAbortable(chatId, turn, signal)
      ),
      runProvider: (chatId, content, options) => (
        this.#turnRunner.runAgentTurn(chatId, content, options)
      ),
      isProviderRunning: (chatId) => this.#turnRunner.isChatRunning(chatId),
      settleAttempt: (chatId, attempt) => this.#directTurns.settleAttempt(chatId, attempt),
      discardPending: (chatId, clientRequestId) => {
        this.#pendingInputs.discard(chatId, clientRequestId);
      },
      returnUnsent: (chatId, entryId) => this.#returnUnsentEntry(chatId, entryId),
      restoreStopped: (chatId, entryId) => this.#restorePoppedEntryAfterStop(chatId, entryId),
      requeueAndPause: async (chatId, entryId, kind) => {
        await this.requeueAndPauseChat(chatId, entryId, kind);
      },
      removeSent: async (chatId, entryId) => {
        await this.removeSentChat(chatId, entryId);
      },
      waitForSessionStop: (chatId) => this.#sessionStops.wait(chatId),
      publishIdle: (chatId) => { this.emit('chat-idle', chatId); },
      publishTurnFailed: (chatId, message, options) => {
        this.emit('turn-failed', chatId, message, options);
      },
    });
  }

  onExecutionControlUpdated(cb: ExecutionControlUpdatedCallback): void {
    this.on('execution-control-updated', cb);
  }
  onDispatching(cb: DispatchingCallback): void {
    this.on('dispatching', cb);
  }
  onSessionStopRequested(cb: SessionStopRequestedCallback): void {
    this.on('session-stop-requested', cb);
  }
  onSessionStopped(cb: SessionStoppedCallback): void {
    this.on('session-stopped', cb);
  }
  onChatIdle(cb: ChatIdleCallback): void {
    this.on('chat-idle', cb);
  }
  onTurnFailed(cb: TurnFailedCallback): void {
    this.on('turn-failed', cb);
  }
  onTurnSettled(cb: TurnSettledCallback): void {
    this.on('turn-settled', cb);
  }

  beginShutdown(): string[] {
    this.#shuttingDown = true;
    const reason = new Error('Turn interrupted because the server is shutting down');
    return this.#ownership.beginShutdown(reason);
  }

  async abortForShutdown(chatId: string): Promise<boolean> {
    this.#ownership.abortAdmission(
      chatId,
      new Error('Turn interrupted because the server is shutting down'),
    );
    if (!this.#ownership.hasAttempt(chatId) && !this.#turnRunner.isChatRunning(chatId)) {
      return true;
    }
    return this.#sessionStops.abort(chatId, 'stop');
  }

  async waitForExecutionOwners(): Promise<void> {
    await this.#ownership.waitForOwners();
  }

  async waitForDispatches(): Promise<void> {
    while (this.#dispatchTasks.size > 0) await Promise.all([...this.#dispatchTasks]);
  }

  #trackDispatch(task: Promise<void>): void {
    this.#dispatchTasks.add(task);
    void task.finally(() => this.#dispatchTasks.delete(task));
  }

  onAgentTurnTerminal(chatId: string, turn: TurnIdentity | undefined): void {
    this.#directTurns.onTerminal(chatId, turn);
  }

  getQueuedTurnFinalization(
    chatId: string,
    turnId: string | undefined,
  ): Promise<QueuedTurnFinalizationOutcome> | null {
    return this.#ownership.finalization(chatId, turnId);
  }
  onChatMessages(cb: ChatMessagesCallback): void {
    this.on('chat-messages', cb);
  }

  // Settles the queue after an agent turn finishes. Called for every turn,
  // including the initial chat-start turn that runs via startSession and never
  // goes through runReservedTurn's post-turn #drain. If a queued entry is
  // waiting and the queue is not paused, resumes draining so the entry is sent
  // without a manual pause/resume; otherwise emits chat-idle when nothing is
  // pending. Skips when a drain loop is already active to avoid duplicate work.
  async checkChatIdle(chatId: string): Promise<void> {
    if (this.#shuttingDown) return;
    if (this.#ownership.isDraining(chatId)) return;
    if (this.#turnRunner.isChatRunning(chatId)) return;
    const queue = await this.readChatExecutionControl(chatId);
    if (this.#isDrainSuppressed(chatId)) {
      const hasPending = queue.entries.some((e) => e.status === 'queued' || e.status === 'sending');
      if (!hasPending) {
        this.#ownership.consumeDrainRequest(chatId);
        this.emit('chat-idle', chatId);
      }
      return;
    }
    const hasQueued = !queue.pause
      && !queue.recoveredInputContinuation
      && queue.entries.some((e) => e.status === 'queued');
    if (hasQueued) {
      await this.triggerDrain(chatId);
      return;
    }
    const hasPending = queue.entries.some((e) => e.status === 'queued' || e.status === 'sending');
    if (!hasPending) {
      this.#ownership.consumeDrainRequest(chatId);
      this.emit('chat-idle', chatId);
    }
  }

  async readChatExecutionControl(chatId: string): Promise<StoredChatExecutionControlState> {
    return this.#controlOperations.read(chatId);
  }

  async createChatQueueEntry(
    chatId: string,
    content: string,
    command?: QueueCommandIdentity,
    receipts: ReceiptRetention = EMPTY_RECEIPT_RETENTION,
  ): Promise<QueueCommandMutationResult & { entry: QueueEntry | null }> {
    return this.#controlOperations.create(chatId, content, command, receipts);
  }

  async replaceChatQueueEntry(
    chatId: string,
    entryId: string,
    content: string,
    expectedRevision: number,
    command?: QueueCommandIdentity,
    receipts: ReceiptRetention = EMPTY_RECEIPT_RETENTION,
  ): Promise<QueueCommandMutationResult & { entry: QueueEntry | null }> {
    return this.#controlOperations.replace(
      chatId,
      entryId,
      content,
      expectedRevision,
      command,
      receipts,
    );
  }

  async deleteChatQueueEntry(
    chatId: string,
    entryId: string,
    command?: QueueCommandIdentity,
    receipts: ReceiptRetention = EMPTY_RECEIPT_RETENTION,
  ): Promise<QueueCommandMutationResult> {
    return this.#controlOperations.delete(chatId, entryId, command, receipts);
  }

  async enqueueAccepted(input: AcceptedQueueCreate): Promise<QueueCommandMutationResult> {
    return this.#acceptedInputs.enqueue(input);
  }

  async replaceAccepted(input: AcceptedQueueReplace): Promise<QueueCommandMutationResult> {
    return this.#acceptedInputs.replace(input);
  }

  async deleteAccepted(input: AcceptedQueueDelete): Promise<QueueCommandMutationResult> {
    return this.#acceptedInputs.delete(input);
  }

  async scheduleDirectInput(input: AcceptedDirectInput): Promise<void> {
    await this.#acceptedInputs.schedule(input);
  }

  async runInitialInput(input: AcceptedDirectInput): Promise<void> {
    await this.#acceptedInputs.runInitial(input);
  }

  async scheduleDirectOperation(input: AcceptedDirectOperation): Promise<void> {
    await this.#acceptedInputs.scheduleOperation(input);
  }

  async deliverActiveInput(
    chatId: string,
    content: string,
    options: RunAgentTurnOptions = {},
    afterPendingRegistered?: () => Promise<void>,
  ): Promise<boolean> {
    const supportsActiveInput =
      this.#turnRunner.isChatRunning(chatId) && typeof this.#turnRunner.submitActiveInput === 'function';
    const currentQueue = supportsActiveInput ? await this.readChatExecutionControl(chatId) : null;
    if (
      !supportsActiveInput
      || currentQueue?.entries.length !== 0
      || currentQueue.pause !== null
      || currentQueue.recoveredInputContinuation !== null
    ) return false;

    const activeOptions = ensureTurnIdentifiers({
      ...this.#getDrainOptions(chatId),
      ...options,
    });
    let pendingRegistered = false;
    let deliveryMayHaveStarted = false;
    try {
      const handled = await this.#turnRunner.submitActiveInput!(chatId, content, activeOptions, async () => {
        await this.registerPendingUserInput(chatId, content, activeOptions);
        pendingRegistered = true;
        await afterPendingRegistered?.();
        deliveryMayHaveStarted = true;
      });
      if (!handled && deliveryMayHaveStarted) {
        throw new Error('Agent accepted active input without handling it');
      }
      return handled;
    } catch (error) {
      if (deliveryMayHaveStarted) {
        this.#pendingInputs.markUnconfirmed(chatId, activeOptions.clientRequestId!);
      } else if (pendingRegistered) {
        this.#pendingInputs.markFailed(chatId, activeOptions.clientRequestId!);
      }
      throw new ActiveInputDeliveryError(error, deliveryMayHaveStarted);
    }
  }

  async deliverAcceptedActiveInput(
    input: AcceptedActiveInput,
  ): Promise<AcceptedActiveInputOutcome> {
    return this.#acceptedInputs.deliverActive(input);
  }

  async recoverAcceptedActiveInput(
    input: AcceptedActiveInput,
  ): Promise<AcceptedActiveInputOutcome> {
    return this.#acceptedInputs.recoverActive(input);
  }

  async clearChatQueue(chatId: string): Promise<StoredChatExecutionControlState> {
    this.#removeDrainSuppression(chatId, 'abort');
    this.#ownership.consumeDrainRequest(chatId);
    return this.#controlOperations.clear(chatId);
  }

  async pauseChatQueue(chatId: string): Promise<StoredChatExecutionControlState> {
    return this.#controlOperations.pause(chatId);
  }

  async resumeChatQueue(chatId: string, pauseId: string): Promise<StoredChatExecutionControlState> {
    const result = await this.#controlOperations.resume(chatId, pauseId);
    if (result.changed) this.#removeDrainSuppression(chatId, 'abort');
    return result.control;
  }

  async resumeAndDrain(chatId: string, pauseId: string): Promise<StoredChatExecutionControlState> {
    const control = await this.resumeChatQueue(chatId, pauseId);
    this.#requestDrain(chatId, 'queue resume');
    return control;
  }

  async continuePastRecoveredInput(
    chatId: string,
    continuationId: string,
  ): Promise<StoredChatExecutionControlState> {
    const result = await this.#controlOperations.continueRecoveredInput(chatId, continuationId);
    this.#ownership.continueRecoveredInput(chatId);
    this.#requestDrain(chatId, 'recovered-input continuation');
    return result;
  }

  async hasAppliedQueueCreateCommand(
    chatId: string,
    commandKey: string,
    entryId: string,
  ): Promise<boolean> {
    return this.#controlOperations.hasAppliedCreate(chatId, commandKey, entryId);
  }

  async dropRecoveredInputContinuation(chatId: string): Promise<StoredChatExecutionControlState> {
    this.#ownership.settleRecoveredInput(chatId);
    const result = (await this.#controlOperations.dropRecoveredInputContinuation(chatId)).control;
    this.#requestDrain(chatId, 'recovered-input settlement');
    return result;
  }

  async popNextChat(
    chatId: string,
  ): Promise<{ entry: StoredQueueEntry; control: StoredChatExecutionControlState } | null> {
    return this.#controlOperations.pop(chatId);
  }

  async removeSentChat(chatId: string, entryId: string): Promise<StoredChatExecutionControlState> {
    return this.#controlOperations.removeSent(chatId, entryId);
  }

  async requeueAndPauseChat(
    chatId: string,
    entryId: string,
    kind: AutomaticQueuePauseKind,
  ): Promise<StoredChatExecutionControlState> {
    return this.#controlOperations.requeueAndPause(chatId, entryId, kind);
  }

  // Submits a command to a chat session. Appends the user message to
  // history, runs the agent turn, then drains any queued entries.
  async submit(chatId: string, command: string, options: RunAgentTurnOptions): Promise<void> {
    const turnOptions = ensureTurnIdentifiers(options);
    const reservation = this.reserveDirectTurn(chatId, turnOptions);
    try {
      reservation.executionAdmission.signal.throwIfAborted();
      const control = await this.readChatExecutionControl(chatId);
      this.assertDirectTurnReservationActive(reservation);
      reservation.executionAdmission.signal.throwIfAborted();
      if (control.entries.length > 0 || control.pause || control.recoveredInputContinuation) {
        throw new DomainError('SESSION_BUSY', 'Chat execution is blocked by pending control state', 409, true);
      }
      await this.registerPendingUserInput(chatId, command, turnOptions);
      reservation.executionAdmission.signal.throwIfAborted();
    } catch (error) {
      await this.releaseDirectTurn(reservation);
      throw error;
    }
    await this.runReservedTurn(reservation, command, turnOptions);
  }

  async registerPendingUserInput(
    chatId: string,
    command: string,
    options: PendingUserInputRegistrationOptions,
  ): Promise<void> {
    await this.#acceptedInputTranscript.register(chatId, command, options);
  }

  reserveDirectTurn(chatId: string, turn: TurnIdentity = {}): DirectTurnReservation {
    return this.#directTurns.reserve(chatId, turn);
  }

  assertDirectTurnReservationActive(reservation: DirectTurnReservation): void {
    this.#directTurns.checkpoint(reservation);
  }

  async consumeRecoveredInputContinuationForDirectTurn(
    reservation: DirectTurnReservation,
  ): Promise<StoredChatExecutionControlState> {
    return this.#directTurns.consumeRecoveredInput(reservation);
  }

  async releaseDirectTurn(reservation: DirectTurnReservation): Promise<void> {
    await this.#directTurns.release(reservation);
  }

  async completeDirectTurn(reservation: DirectTurnReservation): Promise<void> {
    await this.#directTurns.complete(reservation);
  }

  async failDirectTurn(reservation: DirectTurnReservation): Promise<void> {
    await this.#directTurns.fail(reservation);
  }

  async runReservedTurn(
    reservation: DirectTurnReservation,
    command: string,
    options: RunAgentTurnOptions,
  ): Promise<void> {
    return this.#directTurns.run(reservation, command, options);
  }

  async stopActiveTurn(chatId: string): Promise<StopActiveTurnResult> {
    return this.#sessionStops.stop(chatId);
  }

  async interruptActiveTurn(chatId: string): Promise<boolean> {
    return this.#sessionStops.interrupt(chatId);
  }

  async abortForChatDeletion(chatId: string): Promise<boolean> {
    return this.#sessionStops.abortForDeletion(chatId);
  }

  #requestDrain(chatId: string, context: string): void {
    this.#ownership.requestDrain(chatId);
    void this.triggerDrain(chatId).catch((error: Error) => {
      logger.error(`queue: ${context} drain error:`, error.message);
    });
  }

  isChatDraining(chatId: string): boolean {
    return this.#ownership.isDraining(chatId);
  }

  isChatExecutionReserved(chatId: string): boolean {
    return this.#ownership.isReserved(chatId);
  }

  // Includes retained nonblocking attempts across the reservation-to-runtime handoff.
  hasChatExecutionOwner(chatId: string): boolean {
    return this.#ownership.hasOwner(chatId);
  }

  // Triggers drain if the agent is not currently running.
  async triggerDrain(chatId: string): Promise<void> {
    if (this.#shuttingDown) return;
    if (this.#ownership.hasDirect(chatId) || this.#ownership.isDraining(chatId)) {
      this.#ownership.requestDrain(chatId);
      return;
    }
    if (
      this.#isDrainSuppressed(chatId)
      || this.#ownership.stop(chatId) !== undefined
      || this.#turnRunner.isChatRunning(chatId)
    ) return;
    this.#ownership.consumeDrainRequest(chatId);
    await this.#drain(chatId);
  }

  async #drain(chatId: string): Promise<void> {
    if (
      this.#shuttingDown
      || this.#ownership.isDraining(chatId)
      || this.#ownership.hasDirect(chatId)
      || this.#isDrainSuppressed(chatId)
      || this.#ownership.stop(chatId) !== undefined
    ) return;
    this.#ownership.beginDrain(chatId);
    try {
      this.#ownership.consumeDrainRequest(chatId);
      await this.#dispatchSaga.run(chatId);
    } finally {
      this.#ownership.endDrain(chatId);
      this.#removeDrainSuppression(chatId, 'manual-stop');
      this.#ownership.notifyOwnersChanged();
    }
    if (!this.#shuttingDown && this.#ownership.hasDrainRequest(chatId)) await this.triggerDrain(chatId);
  }

  async #returnUnsentEntry(chatId: string, entryId: string): Promise<void> {
    await this.#controlOperations.returnUnsent(chatId, entryId);
  }

  async #restorePoppedEntryAfterStop(chatId: string, entryId: string): Promise<void> {
    await this.#controlOperations.restoreStopped(chatId, entryId);
  }

  async deleteChatQueueFile(chatId: string): Promise<void> {
    await this.#locks.runExclusive(`chat:${chatId}`, async () => {
      this.#ownership.clearChat(
        chatId,
        new Error('Turn interrupted because the chat was deleted'),
      );
      await this.#controlOperations.deleteStored(chatId);
    });
  }

  async recoverChatExecutionControls(
    chatsWithRecoveredInput: ReadonlySet<string> = new Set(),
  ): Promise<void> {
    this.#recoveryFailure = undefined;
    try {
      const { queuesToDrain } = await this.#controlOperations.recover(chatsWithRecoveredInput);
      for (const chatId of queuesToDrain) {
        void this.triggerDrain(chatId).catch((error: Error) => {
          logger.warn(`queue: could not resume recovered chat queue ${chatId}:`, error.message);
        });
      }
    } catch (error: unknown) {
      this.#recoveryFailure = error;
      throw error;
    }
  }

  #assertRecoveryReady(): void {
    if (this.#recoveryFailure !== undefined) throw this.#recoveryFailure;
  }

  #isDrainSuppressed(chatId: string): boolean {
    return this.#hasDrainSuppression(chatId, 'abort')
      || this.#hasDrainSuppression(chatId, 'deletion');
  }

  #addDrainSuppression(chatId: string, reason: DrainSuppressionReason): void {
    this.#ownership.addSuppression(chatId, reason);
  }

  #removeDrainSuppression(chatId: string, reason: DrainSuppressionReason): void {
    this.#ownership.removeSuppression(chatId, reason);
  }

  #hasDrainSuppression(chatId: string, reason: DrainSuppressionReason): boolean {
    return this.#ownership.hasSuppression(chatId, reason);
  }
}

function ensureTurnIdentifiers(options: RunAgentTurnOptions): RunAgentTurnOptions {
  return {
    ...options,
    clientRequestId: options.clientRequestId ?? crypto.randomUUID(),
    clientMessageId: options.clientMessageId ?? crypto.randomUUID(),
    turnId: options.turnId ?? crypto.randomUUID(),
  };
}
