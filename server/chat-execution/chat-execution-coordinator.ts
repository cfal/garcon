import { EventEmitter } from 'events';
import type { QueueEntryPlacement } from '../../common/chat-command-contracts.ts';
import type { AutomaticQueuePauseKind, QueueEntry } from '../../common/queue-state.ts';
import {
  isAbortAcknowledged,
  isStopSatisfied,
  type ChatStopIntent,
  type ChatStopOutcome,
} from '../../common/chat-types.ts';
import {
  type AgentExecutionAdmission,
  type AgentSteerOptions,
  type RunAgentTurnOptions,
} from '../agents/session-types.js';
import { KeyedPromiseLock } from '../lib/keyed-lock.js';
import { createLogger } from '../lib/log.js';
import { DomainError } from '../lib/domain-error.js';
import type { TurnIdentity } from '../lib/turn-identity.js';
import { QueueExecutionAttempt } from './execution-attempt.ts';
import {
  type QueuedTurnFinalizationOutcome,
} from './turn-finalization-tracker.js';
import {
  type StoredChatExecutionControlState,
  type StoredQueueEntry,
} from './control-state.ts';
import type { ChatExecutionControlRepository } from './chat-execution-control-repository.ts';
import {
  type QueueCommandIdentity,
} from './chat-execution-control-transitions.ts';
import {
  executionTurnIdentity,
  type AcceptedGoalControl,
  type AcceptedGoalControlOutcome,
  type AcceptedDirectInput,
  type AcceptedDirectOperation,
  type AcceptedQueueCreate,
  type AcceptedQueueDelete,
  type AcceptedQueueMove,
  type AcceptedQueueReplace,
  type AcceptedSteerInput,
  type AcceptedSteerOutcome,
  type AcceptedQueueEntrySteer,
  type AcceptedQueueEntrySteerOutcome,
  type AgentTurnRunnerPort,
  type ChatExecutionService,
  type ChatExecutionCoordinatorEvents,
  type ChatExistsResolver,
  type CapturedSteerTarget,
  type ChatIdleCallback,
  type DirectTurnReservation,
  type DispatchingCallback,
  type DrainSuppressionReason,
  type ExecutionControlUpdatedCallback,
  type PendingInputsPort,
  type PendingUserInputRegistrationOptions,
  type ProcessingInvalidatedCallback,
  type QueueCommandMutationResult,
  type QueueDrainOptionsResolver,
  type SessionStopInFlight,
  type SessionStopRequestedCallback,
  type SessionStoppedCallback,
  type StopActiveTurnResult,
  type TranscriptSnapshotReservation,
  type TurnFailedCallback,
  type TurnSettledCallback,
} from './types.ts';
import { QueueDrainer } from './queue-drainer.ts';
import { ChatExecutionControlOperations } from './chat-execution-control-operations.ts';
import { ExecutionOwnership } from './execution-ownership.ts';
import { AcceptedInputHandler } from './accepted-input-handler.ts';
import { AcceptedInputTranscript } from './accepted-input-transcript.ts';
import type { AcceptedInputProjectionPort } from './accepted-input-transcript.ts';
import { GoalControlDelivery } from './goal-control-delivery.ts';
import { SteerInputDelivery } from './steer-input-delivery.ts';
import { waitUntilStopAbortable } from './stop-abortability.ts';

export type { QueueCommandIdentity } from './chat-execution-control-transitions.ts';
export {
  QueueEntryMutationError,
  QueuePauseChangedError,
  type ChatExecutionService,
  type ChatExecutionCommands,
  type ChatExecutionLifecycle,
  type ChatExecutionQueries,
  type DirectTurnReservation,
  type StopActiveTurnResult,
  type TranscriptSnapshotReservation,
} from './types.ts';

const logger = createLogger('queue');

interface StopResolution {
  outcome: ChatStopOutcome;
  waitMs: number;
}

export class ChatExecutionCoordinator extends EventEmitter<ChatExecutionCoordinatorEvents> implements ChatExecutionService {
  #locks = new KeyedPromiseLock();
  #shuttingDown = false;
  #ownership = new ExecutionOwnership();
  #dispatchTasks = new Set<Promise<void>>();
  #turnRunner: AgentTurnRunnerPort;
  #pendingInputs: PendingInputsPort;
  #getDrainOptions: QueueDrainOptionsResolver;
  #chatExists: ChatExistsResolver;
  #queueDrainer: QueueDrainer;
  #controlOperations: ChatExecutionControlOperations;
  #acceptedInputHandler: AcceptedInputHandler;
  #acceptedInputTranscript: AcceptedInputTranscript;
  #goalControlDelivery: GoalControlDelivery;
  #steerInputDelivery: SteerInputDelivery;

  constructor(
    _workspaceDir: string,
    turnRunner: AgentTurnRunnerPort,
    pendingInputs: PendingInputsPort,
    inputProjection: AcceptedInputProjectionPort,
    getDrainOptions: QueueDrainOptionsResolver,
    chatExists: ChatExistsResolver,
    controls: ChatExecutionControlRepository,
    unsettledQueueReceiptKeys: (chatId: string) => ReadonlySet<string> = () => new Set(),
  ) {
    super();
    if (!turnRunner) throw new Error('ChatExecutionCoordinator requires an agent turn runner');
    if (typeof turnRunner.waitUntilTurnAbortable !== 'function') {
      throw new Error('ChatExecutionCoordinator requires an abortable turn-start boundary');
    }
    if (!pendingInputs) throw new Error('ChatExecutionCoordinator requires a pending input service');
    if (!inputProjection) throw new Error('ChatExecutionCoordinator requires input projection');
    if (!getDrainOptions) throw new Error('ChatExecutionCoordinator requires a drain option resolver');
    if (!chatExists) throw new Error('ChatExecutionCoordinator requires a chat existence resolver');
    if (!controls) {
      throw new Error('ChatExecutionCoordinator requires an execution control repository');
    }
    this.#turnRunner = turnRunner;
    this.#pendingInputs = pendingInputs;
    this.#getDrainOptions = getDrainOptions;
    this.#chatExists = chatExists;
    this.#acceptedInputTranscript = new AcceptedInputTranscript(
      pendingInputs,
      inputProjection,
    );
    this.#controlOperations = new ChatExecutionControlOperations(controls, {
      runExclusive: (chatId, operation) => this.#locks.runExclusive(`chat:${chatId}`, operation),
      chatExists: (chatId) => this.#chatExists(chatId),
      unsettledQueueReceiptKeys,
      publish: (chatId, control) => {
        this.emit('execution-control-updated', chatId, control);
      },
    });
    const inputDeliveryOptions = {
      turnRunner: this.#turnRunner,
      pendingInputs: this.#pendingInputs,
      ownership: this.#ownership,
      registerPending: (
        chatId: string,
        content: string,
        options: PendingUserInputRegistrationOptions,
      ) => this.registerPendingUserInput(chatId, content, options).then(() => undefined),
    };
    this.#goalControlDelivery = new GoalControlDelivery({
      ...inputDeliveryOptions,
      getDrainOptions: this.#getDrainOptions,
      readControl: (chatId) => this.readChatExecutionControl(chatId),
    });
    this.#steerInputDelivery = new SteerInputDelivery({
      turnRunner: this.#turnRunner,
      ownership: this.#ownership,
      registerPending: (chatId, content, options) => (
        this.registerPendingUserInput(chatId, content, options)
      ),
      isShuttingDown: () => this.#shuttingDown,
    });
    this.#acceptedInputHandler = new AcceptedInputHandler({
      controls: this.#controlOperations,
      pendingInputs: this.#pendingInputs,
      coordinator: {
        requestDrain: (chatId, context) => { this.#requestDrain(chatId, context); },
        reserveDirect: (chatId, turn) => this.#reserveDirect(chatId, turn),
        checkpoint: (reservation) => {
          this.#checkpointDirect(reservation);
          reservation.executionAdmission.signal.throwIfAborted();
        },
        registerPending: (chatId, content, options) => (
          this.registerPendingUserInput(chatId, content, options)
        ),
        releaseDirect: (reservation) => this.#finishDirect(reservation, 'released'),
        runDirect: (reservation, content, options, dispatch, beforeFailureRelease) => (
          this.#runDirect(reservation, content, options, dispatch, beforeFailureRelease)
        ),
        trackDispatch: (task) => { this.#trackDispatch(task); },
        deliverGoalControl: (chatId, content, options, beforeDelivery) => (
          this.deliverGoalControlInput(chatId, content, options, beforeDelivery)
        ),
        steer: (...args) => this.steerInput(...args),
        hasAppliedCreate: (chatId, commandKey, entryId) => (
          this.hasAppliedQueueCreateCommand(chatId, commandKey, entryId)
        ),
      },
    });
    this.#queueDrainer = new QueueDrainer({
      ownership: this.#ownership,
      controls: this.#controlOperations,
      turnRunner: this.#turnRunner,
      pendingInputs: this.#pendingInputs,
      getDrainOptions: this.#getDrainOptions,
      callbacks: {
        isShuttingDown: () => this.#shuttingDown,
        registerPending: (chatId, content, options) => (
          this.registerPendingUserInput(chatId, content, options)
        ),
        publishDispatching: (chatId, entry) => {
          this.#invalidateProcessing(chatId);
          this.emit('dispatching', chatId, entry.id, entry.content);
        },
        publishIdle: (chatId) => { this.emit('chat-idle', chatId); },
        publishTurnFailed: (chatId, message, options) => {
          this.emit('turn-failed', chatId, message, options);
        },
        settleAttempt: (chatId, attempt) => { this.#settleDirectAttempt(chatId, attempt); },
        stopBarrier: (chatId) => this.#drainStopBarrier(chatId),
        removeSent: (chatId, entryId) => this.removeSentChat(chatId, entryId),
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
  onProcessingInvalidated(cb: ProcessingInvalidatedCallback): void {
    this.on('processing-invalidated', cb);
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
    return isStopSatisfied(await this.#abortStop(chatId, 'stop'));
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

  async onAgentTurnTerminal(chatId: string, turn: TurnIdentity | undefined): Promise<void> {
    const attempt = this.#ownership.attempt(chatId);
    if (!attempt?.matches(turn)) {
      // A terminal for an already-retired attempt still clears a resolved
      // interrupt latch and resumes queued work.
      await this.checkChatIdle(chatId);
      return;
    }
    attempt.markTerminalObserved();
    this.#settleDirectAttempt(chatId, attempt);
    await attempt.waitUntilSettled();
  }

  replaceTurnWithTranscriptSnapshotReservation(
    chatId: string,
    turn: TurnIdentity,
  ): TranscriptSnapshotReservation | null {
    return this.#ownership.replaceTurnWithTranscriptSnapshot(chatId, turn);
  }

  getQueuedTurnFinalization(chatId: string, turnId: string | undefined): Promise<QueuedTurnFinalizationOutcome> | null {
    return this.#ownership.finalization(chatId, turnId);
  }
  // Resumes queued work after every turn, including initial turns that bypass
  // runReservedTurn's post-turn drain, unless a drain already owns the chat.
  async checkChatIdle(chatId: string): Promise<void> {
    this.#reconcileStopLatch(chatId);
    if (this.#shuttingDown) return;
    if (this.#ownership.isDraining(chatId)) return;
    if (this.#turnRunner.isChatRunning(chatId)) return;
    const queue = await this.readChatExecutionControl(chatId);
    if (this.#isDrainSuppressed(chatId)) {
      if (queue.entries.length === 0) {
        this.#ownership.consumeDrainRequest(chatId);
        this.emit('chat-idle', chatId);
      }
      return;
    }
    const hasQueued = !queue.pause && queue.entries.some((e) => e.status === 'queued');
    if (hasQueued) {
      await this.triggerDrain(chatId);
      return;
    }
    if (queue.entries.length === 0) {
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
  ): Promise<QueueCommandMutationResult & { entry: QueueEntry | null }> {
    return this.#controlOperations.create(chatId, content, command);
  }

  async replaceChatQueueEntry(
    chatId: string,
    entryId: string,
    content: string,
    expectedRevision: number,
    command?: QueueCommandIdentity,
  ): Promise<QueueCommandMutationResult & { entry: QueueEntry | null }> {
    return this.#controlOperations.replace(
      chatId,
      entryId,
      content,
      expectedRevision,
      command,
    );
  }

  async deleteChatQueueEntry(
    chatId: string,
    entryId: string,
    command?: QueueCommandIdentity,
  ): Promise<QueueCommandMutationResult> {
    return this.#controlOperations.delete(chatId, entryId, command);
  }

  async moveChatQueueEntry(
    chatId: string,
    input: {
      entryId: string;
      targetEntryId: string;
      placement: QueueEntryPlacement;
      expectedReorderRevision: number;
      expectedSourceRevision: number;
      expectedTargetRevision: number;
    },
    command?: QueueCommandIdentity,
  ): Promise<QueueCommandMutationResult & { rebased: boolean | null }> {
    return this.#controlOperations.move(chatId, input, command);
  }

  async enqueueAccepted(input: AcceptedQueueCreate): Promise<QueueCommandMutationResult> {
    return this.#acceptedInputHandler.enqueue(input);
  }

  async replaceAccepted(input: AcceptedQueueReplace): Promise<QueueCommandMutationResult> {
    return this.#acceptedInputHandler.replace(input);
  }

  async deleteAccepted(input: AcceptedQueueDelete): Promise<QueueCommandMutationResult> {
    return this.#acceptedInputHandler.delete(input);
  }

  async moveAccepted(input: AcceptedQueueMove): Promise<QueueCommandMutationResult> {
    return this.#acceptedInputHandler.move(input);
  }

  async scheduleDirectInput(input: AcceptedDirectInput): Promise<void> {
    await this.#acceptedInputHandler.schedule(input);
  }

  async runInitialInput(input: AcceptedDirectInput): Promise<void> {
    await this.#acceptedInputHandler.runInitial(input);
  }

  async scheduleDirectOperation(input: AcceptedDirectOperation): Promise<void> {
    await this.#acceptedInputHandler.scheduleOperation(input);
  }

  captureSteerTarget(chatId: string): CapturedSteerTarget | null {
    return this.#steerInputDelivery.captureTarget(chatId);
  }

  async steerInput(
    chatId: string,
    content: string,
    providerContent: string,
    options: AgentSteerOptions,
    target: CapturedSteerTarget,
    afterPendingRegistered: (turnId: string) => Promise<void>,
  ): Promise<AcceptedSteerOutcome> {
    return this.#steerInputDelivery.deliver(
      chatId,
      content,
      providerContent,
      options,
      target,
      afterPendingRegistered,
    );
  }

  async deliverGoalControlInput(
    chatId: string,
    content: string,
    options: RunAgentTurnOptions = {},
    afterPendingRegistered?: () => Promise<void>,
  ): Promise<boolean> {
    return this.#goalControlDelivery.deliver(
      chatId,
      content,
      options,
      afterPendingRegistered,
    );
  }

  async deliverAcceptedGoalControl(
    input: AcceptedGoalControl,
  ): Promise<AcceptedGoalControlOutcome> {
    return this.#acceptedInputHandler.deliverGoalControl(input);
  }

  async deliverAcceptedSteer(input: AcceptedSteerInput): Promise<AcceptedSteerOutcome> {
    return this.#acceptedInputHandler.steer(input);
  }

  async deliverAcceptedQueueEntrySteer(input: AcceptedQueueEntrySteer): Promise<AcceptedQueueEntrySteerOutcome> {
    return this.#acceptedInputHandler.steerQueueEntry(input);
  }

  async recoverQueueEntrySteer(chatId: string, entryId: string): Promise<StoredChatExecutionControlState> {
    return this.#acceptedInputHandler.recoverQueueEntrySteer(chatId, entryId);
  }
  async recoverAcceptedGoalControl(
    input: AcceptedGoalControl,
  ): Promise<AcceptedGoalControlOutcome> {
    return this.#acceptedInputHandler.recoverGoalControl(input);
  }

  async clearChatQueue(chatId: string): Promise<StoredChatExecutionControlState> {
    this.#ownership.clearAbortSuppression(chatId);
    this.#ownership.consumeDrainRequest(chatId);
    return this.#controlOperations.clear(chatId);
  }

  async pauseChatQueue(chatId: string): Promise<StoredChatExecutionControlState> {
    return this.#controlOperations.pause(chatId);
  }

  async resumeChatQueue(chatId: string, pauseId: string): Promise<StoredChatExecutionControlState> {
    const result = await this.#controlOperations.resume(chatId, pauseId);
    if (result.changed) this.#ownership.clearAbortSuppression(chatId);
    return result.control;
  }

  async resumeAndDrain(chatId: string, pauseId: string): Promise<StoredChatExecutionControlState> {
    const control = await this.resumeChatQueue(chatId, pauseId);
    this.#requestDrain(chatId, 'queue resume');
    return control;
  }

  async hasAppliedQueueCreateCommand(
    chatId: string,
    commandKey: string,
    entryId: string,
  ): Promise<boolean> {
    return this.#controlOperations.hasAppliedCreate(chatId, commandKey, entryId);
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

  async registerPendingUserInput(
    chatId: string,
    command: string,
    options: PendingUserInputRegistrationOptions,
  ): Promise<boolean> {
    return this.#acceptedInputTranscript.register(chatId, command, options);
  }

  onAcceptedInputSettled(chatId: string, clientRequestId: string): void {
    void chatId;
    void clientRequestId;
  }

  reserveDirectTurn(chatId: string, turn: TurnIdentity = {}): DirectTurnReservation {
    return this.#reserveDirect(chatId, turn);
  }

  assertDirectTurnReservationActive(reservation: DirectTurnReservation): void {
    this.#checkpointDirect(reservation);
  }

  async releaseDirectTurn(reservation: DirectTurnReservation): Promise<void> {
    await this.#finishDirect(reservation, 'released');
  }

  reserveTranscriptSnapshot(chatId: string): TranscriptSnapshotReservation {
    if (this.#shuttingDown) {
      throw new DomainError('SERVER_SHUTTING_DOWN', 'The server is shutting down', 503, true);
    }
    if (this.ownsExecution(chatId)) {
      throw new DomainError('SESSION_BUSY', 'Another chat turn already owns execution', 409, true);
    }
    return this.#ownership.reserveTranscriptSnapshot(chatId);
  }

  async releaseTranscriptSnapshot(reservation: TranscriptSnapshotReservation): Promise<void> {
    this.#ownership.releaseTranscriptSnapshot(reservation);
    const drainRequested = this.#ownership.hasDrainRequest(reservation.chatId);
    this.#ownership.notifyOwnersChanged();
    if (!drainRequested || !this.#chatExists(reservation.chatId) || this.#shuttingDown) return;
    await this.triggerDrain(reservation.chatId);
  }

  async completeDirectTurn(reservation: DirectTurnReservation): Promise<void> {
    await this.#finishDirect(reservation, 'completed');
  }

  async failDirectTurn(reservation: DirectTurnReservation): Promise<void> {
    await this.#finishDirect(reservation, 'failed');
  }

  async runReservedTurn(
    reservation: DirectTurnReservation,
    command: string,
    options: RunAgentTurnOptions,
  ): Promise<void> {
    return this.#runDirect(reservation, command, options);
  }

  async stopActiveTurn(chatId: string): Promise<StopActiveTurnResult> {
    return this.#stopActiveTurn(chatId);
  }

  async interruptActiveTurn(chatId: string): Promise<ChatStopOutcome> {
    return this.#interruptActiveTurn(chatId);
  }

  async abortForChatDeletion(chatId: string): Promise<boolean> { return this.#abortForDeletion(chatId); }

  rollbackChatDeletion(chatId: string): void { this.#rollbackDeletion(chatId); }

  #requestDrain(chatId: string, context: string): void {
    this.#ownership.requestDrain(chatId);
    void this.triggerDrain(chatId).catch((error: Error) => {
      logger.error(`queue: ${context} drain error:`, error.message);
    });
  }

  // Answers whether any execution state may read or mutate this chat's transcript or view: a
  // provider session is running, a direct or queued turn holds the chat, a fork holds a
  // transcript snapshot, or a finished turn has not settled yet. Direct-turn and snapshot
  // admission refuse on exactly this predicate, so callers that bypass an admission ask this
  // instead of assembling their own union. Use showsAsProcessing for UI turn visibility: it is
  // narrower on purpose.
  ownsExecution(chatId: string): boolean {
    return this.#ownership.hasOwner(chatId) || this.#turnRunner.isChatRunning(chatId);
  }

  isChatTurnReserved(chatId: string): boolean {
    return this.#ownership.isTurnReserved(chatId);
  }

  getTurnReservedChatIds(): string[] {
    return this.#ownership.turnReservedChatIds();
  }

  isChatStopInFlight(chatId: string): boolean {
    return this.#ownership.stop(chatId) !== undefined;
  }

  async triggerDrain(chatId: string): Promise<void> {
    if (this.#shuttingDown) return;
    if (
      this.#ownership.hasDirect(chatId)
      || this.#ownership.hasTranscriptSnapshot(chatId)
      || this.#ownership.isDraining(chatId)
      || this.#ownership.hasAttempt(chatId)
    ) {
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
      || this.#ownership.hasTranscriptSnapshot(chatId)
      || this.#ownership.hasAttempt(chatId)
      || this.#isDrainSuppressed(chatId)
      || this.#ownership.stop(chatId) !== undefined
    ) return;
    this.#ownership.beginDrain(chatId);
    try {
      this.#ownership.consumeDrainRequest(chatId);
      await this.#queueDrainer.run(chatId);
    } finally {
      this.#ownership.endDrain(chatId);
      this.#ownership.exitManualStop(chatId, { drainStillActive: false });
      this.#ownership.notifyOwnersChanged();
      this.#reconcileStopLatch(chatId);
      this.#invalidateProcessing(chatId);
    }
    if (!this.#shuttingDown && this.#ownership.hasDrainRequest(chatId)) await this.triggerDrain(chatId);
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

  #isDrainSuppressed(chatId: string): boolean {
    return this.#hasDrainSuppression(chatId, 'abort')
      || this.#hasDrainSuppression(chatId, 'deletion');
  }

  #hasDrainSuppression(chatId: string, reason: DrainSuppressionReason): boolean {
    return this.#ownership.hasSuppression(chatId, reason);
  }

  #reserveDirect(chatId: string, turn: TurnIdentity = {}): DirectTurnReservation {
    if (this.#shuttingDown) {
      throw new DomainError('SERVER_SHUTTING_DOWN', 'The server is shutting down', 503, true);
    }
    if (this.ownsExecution(chatId)) {
      throw new DomainError('SESSION_BUSY', 'Another chat turn already owns execution', 409, true);
    }
    const reservation = this.#ownership.reserveDirect(chatId, turn);
    this.#invalidateProcessing(chatId);
    return reservation;
  }

  #checkpointDirect(reservation: DirectTurnReservation): void {
    if (!this.#ownership.isDirectCurrent(reservation)) {
      throw new DomainError('SESSION_BUSY', 'Direct turn reservation is no longer active', 409, true);
    }
  }

  async #runDirect(
    reservation: DirectTurnReservation,
    content: string,
    options: RunAgentTurnOptions,
    dispatch?: (admission: AgentExecutionAdmission) => Promise<void>,
    beforeFailureRelease?: (error: unknown) => Promise<void>,
  ): Promise<void> {
    this.#checkpointDirect(reservation);
    const identity = executionTurnIdentity(options);
    const attempt = this.#ownership.attempt(reservation.chatId);
    if (!attempt) throw new Error('Direct turn execution attempt is missing');
    if (identity && !attempt.matches(identity)) attempt.replaceReservedTurn(identity);
    attempt.markLaunching();
    let outcome: 'completed' | 'failed' = 'failed';
    try {
      reservation.executionAdmission.signal.throwIfAborted();
      if (dispatch) {
        await dispatch(reservation.executionAdmission);
      } else {
        await this.#turnRunner.runAgentTurn(reservation.chatId, content, {
          ...options,
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
        this.emit('turn-failed', reservation.chatId, message, options);
      }
      throw failure;
    } finally {
      await this.#finishDirect(reservation, outcome);
    }
  }

  #settleDirectAttempt(chatId: string, attempt: QueueExecutionAttempt): void {
    if (!attempt.isSettlementReady) return;
    if (!this.#ownership.isCurrentAttempt(chatId, attempt)) return;
    attempt.markSettled();
    this.#ownership.removeAttempt(chatId, attempt);
    this.emit('turn-settled', chatId, attempt.identity());
    this.#ownership.notifyOwnersChanged();
    this.#reconcileStopLatch(chatId);
    this.#invalidateProcessing(chatId);
  }

  async #finishDirect(
    reservation: DirectTurnReservation,
    outcome: 'released' | 'completed' | 'failed',
  ): Promise<void> {
    if (!this.#ownership.isDirectCurrent(reservation)) {
      if (!this.#chatExists(reservation.chatId)) return;
      throw new Error('Direct turn reservation is no longer active');
    }
    this.#ownership.releaseDirect(reservation);
    const attempt = this.#ownership.attempt(reservation.chatId);
    if (attempt) {
      attempt.markRunSettled();
      if (outcome !== 'completed') {
        attempt.markTerminalObserved();
      }
      this.#settleDirectAttempt(reservation.chatId, attempt);
    }
    const drainRequested = this.#ownership.hasDrainRequest(reservation.chatId);
    this.#ownership.notifyOwnersChanged();
    this.#reconcileStopLatch(reservation.chatId);
    this.#invalidateProcessing(reservation.chatId);
    if (!this.#chatExists(reservation.chatId) || this.#shuttingDown) return;
    if (outcome === 'completed' || drainRequested) await this.triggerDrain(reservation.chatId);
  }

  async #abortStop(chatId: string, intent: ChatStopIntent): Promise<ChatStopOutcome> {
    const operation = this.#ownership.reserveStop(chatId, intent);
    this.#invalidateProcessing(chatId);
    this.#startStop(chatId, operation);
    return operation.promise;
  }

  #drainStopBarrier(chatId: string): Promise<ChatStopOutcome> | null {
    const operation = this.#ownership.drainStop(chatId);
    if (!operation) return null;
    return operation.promise.finally(() => {
      this.#ownership.consumeDrainStop(chatId, operation);
    });
  }

  async #stopActiveTurn(chatId: string): Promise<StopActiveTurnResult> {
    const drainWasActive = this.#ownership.isDraining(chatId);
    this.#ownership.enterAbortSuppression(chatId);
    this.#ownership.enterManualStop(chatId);
    const existingStop = this.#ownership.stop(chatId);
    const operation = this.#ownership.reserveStop(chatId, 'stop');
    this.#invalidateProcessing(chatId);
    const ownsStop = existingStop === undefined;
    try {
      await this.pauseChatQueue(chatId);
    } catch (error) {
      if (ownsStop && !operation.started) operation.resolve('failed');
      if (ownsStop) {
        this.#ownership.clearStop(chatId, operation);
        this.#invalidateProcessing(chatId);
      }
      this.#ownership.clearAbortSuppression(chatId);
      this.#ownership.exitManualStop(chatId, { drainStillActive: false });
      throw error;
    }
    let outcome: ChatStopOutcome;
    try {
      this.#startStop(chatId, operation);
      outcome = await operation.promise;
    } finally {
      this.#ownership.clearAbortSuppression(chatId);
      this.#ownership.exitManualStop(chatId, {
        drainStillActive: drainWasActive && this.#ownership.isDraining(chatId),
      });
    }
    return { outcome, control: await this.readChatExecutionControl(chatId) };
  }

  async #interruptActiveTurn(chatId: string): Promise<ChatStopOutcome> {
    const interruptedAttempt = this.#ownership.attempt(chatId);
    try {
      const outcome = await this.#abortStop(chatId, 'interrupt-and-send');
      if (isStopSatisfied(outcome)) this.#ownership.clearAbortSuppression(chatId);
      if (isStopSatisfied(outcome) && interruptedAttempt) {
        await interruptedAttempt.waitUntilSettled();
      }
      return outcome;
    } finally {
      this.#requestDrain(chatId, 'interrupt');
    }
  }

  async #abortForDeletion(chatId: string): Promise<boolean> {
    this.#ownership.enterDeletionSuppression(chatId);
    try {
      const attempt = this.#ownership.attempt(chatId);
      if (!attempt && !this.#turnRunner.isChatRunning(chatId)) return true;
      const outcome = await this.#abortStop(chatId, 'chat-deletion');
      if (!isStopSatisfied(outcome)) {
        const retired = !this.#turnRunner.isChatRunning(chatId)
          && this.#ownership.isAttemptRetired(chatId, attempt);
        if (!retired) this.#rollbackDeletion(chatId);
        return retired;
      }
      if (attempt) await attempt.waitUntilSettled();
      const retired = !this.#turnRunner.isChatRunning(chatId)
        && this.#ownership.isAttemptRetired(chatId, attempt);
      if (!retired) this.#rollbackDeletion(chatId);
      return retired;
    } catch (error) {
      this.#rollbackDeletion(chatId);
      throw error;
    }
  }

  #startStop(chatId: string, operation: SessionStopInFlight): void {
    if (operation.started) return;
    operation.started = true;
    this.#performStop(chatId, operation.stopId, operation.intent).then(
      ({ outcome, waitMs }) => {
        operation.outcome = outcome;
        operation.phase = outcome === 'interrupt-requested' ? 'settling' : 'requesting';
        if (outcome !== 'interrupt-requested') {
          this.#ownership.clearStop(chatId, operation);
        }
        try {
          this.#invalidateProcessing(chatId);
          this.emit('session-stopped', chatId, outcome, operation.intent, operation.stopId, waitMs);
        } catch (error) {
          this.#ownership.clearStop(chatId, operation);
          operation.reject(error);
          return;
        }
        operation.resolve(outcome);
        if (outcome === 'interrupt-requested') this.#reconcileStopLatch(chatId);
      },
      (error) => {
        this.#ownership.clearStop(chatId, operation);
        this.#invalidateProcessing(chatId);
        operation.reject(error);
      },
    );
  }

  async #performStop(
    chatId: string, stopId: string,
    intent: ChatStopIntent,
  ): Promise<StopResolution> {
    const startedAt = Date.now();
    const attempt = this.#ownership.attempt(chatId);
    const registered = attempt?.entryId ? await attempt.waitUntilRegistered() : Boolean(attempt);
    const currentAttempt = attempt && this.#ownership.isCurrentAttempt(chatId, attempt)
      ? attempt
      : undefined;
    if (!this.#hasAbortTarget(chatId, currentAttempt)) {
      return { outcome: 'already-idle', waitMs: Date.now() - startedAt };
    }
    try {
      this.emit('session-stop-requested', chatId, stopId, currentAttempt?.identity(), intent);
    } catch (error) {
      currentAttempt?.allowLaunch();
      throw error;
    }
    if (currentAttempt && registered) {
      currentAttempt.allowLaunch();
      const abortable = await waitUntilStopAbortable(
        chatId,
        currentAttempt,
        this.#turnRunner,
        () => this.#ownership.isCurrentAttempt(chatId, currentAttempt),
      );
      if (!abortable) {
        currentAttempt.clearExpectedAbort(stopId);
        const outcome = await this.#outcomeAfterUnacknowledgedAbort(chatId, currentAttempt);
        return { outcome, waitMs: Date.now() - startedAt };
      }
      if (currentAttempt.entryId) currentAttempt.expectAbort(stopId);
    }
    try {
      const acknowledged = await this.#turnRunner.abortSession(chatId);
      if (!acknowledged) {
        currentAttempt?.clearExpectedAbort(stopId);
      }
      const outcome: ChatStopOutcome = acknowledged
        ? 'interrupt-requested'
        : await this.#outcomeAfterUnacknowledgedAbort(chatId, currentAttempt);
      if (isAbortAcknowledged(outcome) && currentAttempt && !this.#turnRunner.isChatRunning(chatId)) {
        currentAttempt.markTerminalObserved();
        this.#settleDirectAttempt(chatId, currentAttempt);
      }
      return { outcome, waitMs: Date.now() - startedAt };
    } catch (error) {
      currentAttempt?.clearExpectedAbort(stopId);
      logger.warn('queue: provider interrupt failed', {
        chatId,
        errorType: error instanceof Error ? error.name : typeof error,
      });
      return { outcome: 'failed', waitMs: Date.now() - startedAt };
    }
  }

  #hasAbortTarget(chatId: string, attempt = this.#ownership.attempt(chatId)): boolean {
    return this.#turnRunner.isChatRunning(chatId)
      || Boolean(attempt && !attempt.isRunSettled && !attempt.isSettled);
  }

  async #outcomeAfterUnacknowledgedAbort(
    chatId: string,
    attempt: QueueExecutionAttempt | undefined,
  ): Promise<ChatStopOutcome> {
    if (!this.#turnRunner.isChatRunning(chatId) && attempt && !attempt.isRunSettled) {
      await attempt.waitUntilSettled();
    }
    return this.#hasAbortTarget(chatId, attempt) ? 'failed' : 'already-idle';
  }

  #reconcileStopLatch(chatId: string): void {
    const operation = this.#ownership.stop(chatId);
    if (
      !operation
      || operation.phase !== 'settling'
      || operation.outcome !== 'interrupt-requested'
      || this.#turnRunner.isChatRunning(chatId)
      || this.#ownership.isTurnReserved(chatId)
    ) return;
    this.#ownership.clearStop(chatId, operation);
    this.#invalidateProcessing(chatId);
    if (!this.#shuttingDown && this.#chatExists(chatId)) {
      this.#ownership.requestDrain(chatId);
    }
  }

  #invalidateProcessing(chatId: string): void {
    this.emit('processing-invalidated', chatId);
  }

  #rollbackDeletion(chatId: string): void {
    this.#ownership.clearDeletionSuppression(chatId);
    this.#requestDrain(chatId, 'deletion rollback');
  }
}
