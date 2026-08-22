import { EventEmitter } from 'events';
import type { QueueEntryPlacement } from '../../common/chat-command-contracts.ts';
import type { AutomaticQueuePauseKind, QueueEntry } from '../../common/queue-state.ts';
import {
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
  type DrainSuppressionReason,
  type ExecutionControlUpdatedCallback,
  type UserInputAdmissionOptions,
  type ProcessingInvalidatedCallback,
  type QueueCommandMutationResult,
  type QueueDrainOptionsResolver,
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
import type { AcceptedInputTranscriptPort } from './accepted-input-transcript.ts';
import { GoalControlDelivery } from './goal-control-delivery.ts';
import { SteerInputDelivery } from './steer-input-delivery.ts';

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

export class ChatExecutionCoordinator extends EventEmitter<ChatExecutionCoordinatorEvents> implements ChatExecutionService {
  #locks = new KeyedPromiseLock();
  #shuttingDown = false;
  #ownership = new ExecutionOwnership();
  #dispatchTasks = new Set<Promise<void>>();
  #stopTasks = new Map<string, Promise<ChatStopOutcome>>();
  #turnRunner: AgentTurnRunnerPort;
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
    inputTranscript: AcceptedInputTranscriptPort,
    getDrainOptions: QueueDrainOptionsResolver,
    chatExists: ChatExistsResolver,
    controls: ChatExecutionControlRepository,
    unsettledQueueReceiptKeys: (chatId: string) => ReadonlySet<string> = () => new Set(),
  ) {
    super();
    if (!turnRunner) throw new Error('ChatExecutionCoordinator requires an agent turn runner');
    if (!inputTranscript) throw new Error('ChatExecutionCoordinator requires an input transcript');
    if (!getDrainOptions) throw new Error('ChatExecutionCoordinator requires a drain option resolver');
    if (!chatExists) throw new Error('ChatExecutionCoordinator requires a chat existence resolver');
    if (!controls) {
      throw new Error('ChatExecutionCoordinator requires an execution control repository');
    }
    this.#turnRunner = turnRunner;
    this.#getDrainOptions = getDrainOptions;
    this.#chatExists = chatExists;
    this.#acceptedInputTranscript = new AcceptedInputTranscript(inputTranscript);
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
      ownership: this.#ownership,
      admitInput: (
        chatId: string,
        content: string,
        options: UserInputAdmissionOptions,
      ) => this.admitUserInput(chatId, content, options),
      discardPreparedInput: (chatId: string, clientMessageId: string | null | undefined) => {
        this.#acceptedInputTranscript.discard(chatId, clientMessageId);
      },
    };
    this.#goalControlDelivery = new GoalControlDelivery({
      ...inputDeliveryOptions,
      getDrainOptions: this.#getDrainOptions,
      readControl: (chatId) => this.readChatExecutionControl(chatId),
    });
    this.#steerInputDelivery = new SteerInputDelivery({
      ...inputDeliveryOptions,
      isShuttingDown: () => this.#shuttingDown,
    });
    this.#acceptedInputHandler = new AcceptedInputHandler({
      controls: this.#controlOperations,
      coordinator: {
        requestDrain: (chatId, context) => { this.#requestDrain(chatId, context); },
        reserveDirect: (chatId, turn) => this.#reserveDirect(chatId, turn),
        checkpoint: (reservation) => {
          this.#checkpointDirect(reservation);
          reservation.executionAdmission.signal.throwIfAborted();
        },
        admitInput: (chatId, content, options) => (
          this.admitUserInput(chatId, content, options)
        ),
        discardPreparedInput: (chatId, clientMessageId) => {
          this.#acceptedInputTranscript.discard(chatId, clientMessageId);
        },
        releaseDirect: (reservation) => this.#finishDirect(reservation, 'released'),
        runDirect: (reservation, content, options, dispatch, beforeFailureRelease) => (
          this.#runDirect(reservation, content, options, dispatch, beforeFailureRelease)
        ),
        trackDispatch: (task) => { this.#trackDispatch(task); },
        deliverGoalControl: (chatId, content, options, beforeDelivery) => (
          this.deliverGoalControlInput(chatId, content, options, beforeDelivery)
        ),
        steer: (...args) => this.steerInput(...args),
      },
    });
    this.#queueDrainer = new QueueDrainer({
      ownership: this.#ownership,
      controls: this.#controlOperations,
      turnRunner: this.#turnRunner,
      getDrainOptions: this.#getDrainOptions,
      callbacks: {
        isShuttingDown: () => this.#shuttingDown,
        registerQueued: (chatId, content, options) => (
          this.#acceptedInputTranscript.registerQueued(chatId, content, options)
        ),
        discardPreparedInput: (chatId, clientMessageId) => {
          this.#acceptedInputTranscript.discard(chatId, clientMessageId);
        },
        publishIdle: (chatId) => { this.emit('chat-idle', chatId); },
        publishTurnFailed: (chatId, message, options) => {
          this.emit('turn-failed', chatId, message, options);
        },
        retireAttempt: (chatId, attempt) => {
          this.#retireAttempt(chatId, attempt);
          this.#invalidateProcessing(chatId);
        },
      },
    });
  }

  onExecutionControlUpdated(cb: ExecutionControlUpdatedCallback): void {
    this.on('execution-control-updated', cb);
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
    return isStopSatisfied(await this.#requestStop(chatId, 'stop'));
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

  async onAgentTurnTerminal(
    chatId: string,
    turn: TurnIdentity | undefined,
    outcome: 'finished' | 'failed' = 'finished',
  ): Promise<void> {
    const attempt = this.#ownership.attempt(chatId);
    if (!attempt?.matches(turn)) {
      await this.checkChatIdle(chatId);
      return;
    }
    if (outcome === 'failed' && attempt.entryId) {
      await this.#controlOperations.pauseAfterDispatchFailure(chatId, attempt.entryId);
    }
    this.#retireAttempt(chatId, attempt);
    this.#invalidateProcessing(chatId);
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
    userMessagePresentation?: UserInputAdmissionOptions['userMessagePresentation'],
  ): Promise<AcceptedSteerOutcome> {
    return this.#steerInputDelivery.deliver(
      chatId,
      content,
      providerContent,
      options,
      target,
      afterPendingRegistered,
      userMessagePresentation,
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

  async requeueAndPauseChat(
    chatId: string,
    entryId: string,
    kind: AutomaticQueuePauseKind,
  ): Promise<StoredChatExecutionControlState> {
    return this.#controlOperations.requeueAndPause(chatId, entryId, kind);
  }

  async admitUserInput(
    chatId: string,
    command: string,
    options: UserInputAdmissionOptions,
  ): Promise<boolean> {
    return this.#acceptedInputTranscript.register(chatId, command, options);
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
    return this.#stopTasks.has(chatId);
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
    ) return;
    this.#ownership.beginDrain(chatId);
    try {
      this.#ownership.consumeDrainRequest(chatId);
      await this.#queueDrainer.run(chatId);
    } finally {
      this.#ownership.endDrain(chatId);
      this.#ownership.exitManualStop(chatId, { drainStillActive: false });
      this.#ownership.notifyOwnersChanged();
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
      this.#acceptedInputTranscript.discard(reservation.chatId, options.clientMessageId);
      await this.#finishDirect(reservation, outcome);
    }
  }

  #retireAttempt(chatId: string, attempt: QueueExecutionAttempt, reason?: Error): void {
    if (!this.#ownership.retireAttempt(chatId, attempt, reason)) return;
    this.emit('turn-settled', chatId, attempt.identity());
    this.#ownership.notifyOwnersChanged();
  }

  async #finishDirect(
    reservation: DirectTurnReservation,
    outcome: 'released' | 'completed' | 'failed',
  ): Promise<void> {
    if (!this.#ownership.isDirectCurrent(reservation)) {
      // An accepted interruption retires ownership before the provider promise
      // settles. Its late finally block has no execution state left to release.
      return;
    }
    this.#ownership.releaseDirect(reservation);
    const attempt = this.#ownership.attempt(reservation.chatId);
    if (attempt && outcome !== 'completed') this.#retireAttempt(reservation.chatId, attempt);
    const drainRequested = this.#ownership.hasDrainRequest(reservation.chatId);
    this.#ownership.notifyOwnersChanged();
    this.#invalidateProcessing(reservation.chatId);
    if (!this.#chatExists(reservation.chatId) || this.#shuttingDown) return;
    if (outcome === 'completed' || drainRequested) await this.triggerDrain(reservation.chatId);
  }

  #requestStop(chatId: string, intent: ChatStopIntent): Promise<ChatStopOutcome> {
    const existing = this.#stopTasks.get(chatId);
    if (existing) return existing;
    const task = this.#performStop(chatId).then((outcome) => {
      this.emit('session-stopped', chatId, outcome, intent);
      return outcome;
    }).finally(() => {
      if (this.#stopTasks.get(chatId) === task) this.#stopTasks.delete(chatId);
      this.#invalidateProcessing(chatId);
    });
    this.#stopTasks.set(chatId, task);
    return task;
  }

  async #stopActiveTurn(chatId: string): Promise<StopActiveTurnResult> {
    const drainWasActive = this.#ownership.isDraining(chatId);
    this.#ownership.enterAbortSuppression(chatId);
    this.#ownership.enterManualStop(chatId);
    try {
      await this.pauseChatQueue(chatId);
    } catch (error) {
      this.#ownership.clearAbortSuppression(chatId);
      this.#ownership.exitManualStop(chatId, { drainStillActive: false });
      throw error;
    }
    let outcome: ChatStopOutcome;
    try {
      outcome = await this.#requestStop(chatId, 'stop');
    } finally {
      this.#ownership.clearAbortSuppression(chatId);
      this.#ownership.exitManualStop(chatId, {
        drainStillActive: drainWasActive && this.#ownership.isDraining(chatId),
      });
    }
    return { outcome, control: await this.readChatExecutionControl(chatId) };
  }

  async #interruptActiveTurn(chatId: string): Promise<ChatStopOutcome> {
    try {
      return await this.#requestStop(chatId, 'interrupt-and-send');
    } finally {
      this.#requestDrain(chatId, 'interrupt');
    }
  }

  async #abortForDeletion(chatId: string): Promise<boolean> {
    this.#ownership.enterDeletionSuppression(chatId);
    try {
      const outcome = await this.#requestStop(chatId, 'chat-deletion');
      if (!isStopSatisfied(outcome)) {
        this.#rollbackDeletion(chatId);
        return false;
      }
      return true;
    } catch (error) {
      this.#rollbackDeletion(chatId);
      throw error;
    }
  }

  async #performStop(chatId: string): Promise<ChatStopOutcome> {
    const attempt = this.#ownership.attempt(chatId);
    try {
      const acknowledged = await this.#turnRunner.abortSession(chatId);
      let currentAttempt: QueueExecutionAttempt | undefined;
      if (attempt && this.#ownership.isCurrentAttempt(chatId, attempt)) {
        currentAttempt = attempt;
      }
      if (!acknowledged && !currentAttempt) return 'already-idle';
      if (currentAttempt) {
        this.#retireAttempt(
          chatId,
          currentAttempt,
          new Error('Turn interrupted by the user'),
        );
      }
      return 'interrupt-requested';
    } catch (error) {
      logger.warn('queue: provider interrupt failed', {
        chatId,
        errorType: error instanceof Error ? error.name : typeof error,
      });
      return 'failed';
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
