import { EventEmitter } from 'events';
import type { AutomaticQueuePauseKind, QueueEntry } from '../../common/queue-state.ts';
import type { ChatStopIntent } from '../../common/chat-types.ts';
import {
  requireChatExecutionConfig,
  type AgentExecutionAdmission,
  type RunAgentTurnOptions,
} from '../agents/session-types.js';
import type { IChatRegistry } from '../chats/store.js';
import { KeyedPromiseLock } from '../lib/keyed-lock.js';
import { createLogger } from '../lib/log.js';
import { ActiveInputDeliveryError, DomainError } from '../lib/domain-error.js';
import type { TurnIdentity } from '../lib/turn-identity.js';
import { QueueExecutionAttempt } from './execution-attempt.ts';
import {
  type QueuedTurnFinalizationOutcome,
} from './turn-finalization-tracker.js';
import {
  type StoredChatExecutionControlState,
  type StoredQueueEntry,
} from './control-state.ts';
import {
  InMemoryChatExecutionControlRepository,
  type ChatExecutionControlRepository,
} from './chat-execution-control-repository.ts';
import {
  type QueueCommandIdentity,
} from './chat-execution-control-transitions.ts';
import {
  executionTurnIdentity,
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

interface ChatExecutionCoordinatorEvents {
  'chat-messages': Parameters<ChatMessagesCallback>;
  'execution-control-updated': Parameters<ExecutionControlUpdatedCallback>;
  dispatching: Parameters<DispatchingCallback>;
  'session-stop-requested': Parameters<SessionStopRequestedCallback>;
  'session-stopped': Parameters<SessionStoppedCallback>;
  'chat-idle': Parameters<ChatIdleCallback>;
  'turn-failed': Parameters<TurnFailedCallback>;
  'turn-settled': Parameters<TurnSettledCallback>;
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

  constructor(
    _workspaceDir: string,
    turnRunner: AgentTurnRunnerPort,
    pendingInputs: PendingInputsPort,
    chatMessages: ChatMessagesPort,
    getDrainOptions: QueueDrainOptionsResolver,
    chatExists: ChatExistsResolver,
    controls: ChatExecutionControlRepository = new InMemoryChatExecutionControlRepository(),
    unsettledQueueReceiptKeys: (chatId: string) => ReadonlySet<string> = () => new Set(),
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
      chatExists: (chatId) => this.#chatExists(chatId),
      unsettledQueueReceiptKeys,
      publish: (chatId, control) => {
        this.emit('execution-control-updated', chatId, control);
      },
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
        deliverActive: (chatId, content, options, beforeDelivery) => (
          this.deliverActiveInput(chatId, content, options, beforeDelivery)
        ),
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
    return this.#abortStop(chatId, 'stop');
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
    this.#onDirectTerminal(chatId, turn);
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

  // Resumes queued work after every turn, including initial turns that bypass
  // runReservedTurn's post-turn drain, unless a drain already owns the chat.
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
    const hasQueued = !queue.pause && queue.entries.some((e) => e.status === 'queued');
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

  async enqueueAccepted(input: AcceptedQueueCreate): Promise<QueueCommandMutationResult> {
    return this.#acceptedInputHandler.enqueue(input);
  }

  async replaceAccepted(input: AcceptedQueueReplace): Promise<QueueCommandMutationResult> {
    return this.#acceptedInputHandler.replace(input);
  }

  async deleteAccepted(input: AcceptedQueueDelete): Promise<QueueCommandMutationResult> {
    return this.#acceptedInputHandler.delete(input);
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
    ) return false;

    const activeOptions = {
      ...this.#getDrainOptions(chatId),
      ...options,
    };
    assertTurnIdentifiers(activeOptions);
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
    return this.#acceptedInputHandler.deliverActive(input);
  }

  async recoverAcceptedActiveInput(
    input: AcceptedActiveInput,
  ): Promise<AcceptedActiveInputOutcome> {
    return this.#acceptedInputHandler.recoverActive(input);
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
  ): Promise<void> {
    await this.#acceptedInputTranscript.register(chatId, command, options);
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
    if (this.#ownership.hasOwner(chatId) || this.#turnRunner.isChatRunning(chatId)) {
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

  async interruptActiveTurn(chatId: string): Promise<boolean> {
    return this.#interruptActiveTurn(chatId);
  }

  async abortForChatDeletion(chatId: string): Promise<boolean> {
    return this.#abortForDeletion(chatId);
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

  async triggerDrain(chatId: string): Promise<void> {
    if (this.#shuttingDown) return;
    if (
      this.#ownership.hasDirect(chatId)
      || this.#ownership.hasTranscriptSnapshot(chatId)
      || this.#ownership.isDraining(chatId)
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
    if (this.#ownership.hasOwner(chatId) || this.#turnRunner.isChatRunning(chatId)) {
      throw new DomainError('SESSION_BUSY', 'Another chat turn already owns execution', 409, true);
    }
    return this.#ownership.reserveDirect(chatId, turn);
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

  #onDirectTerminal(chatId: string, turn: TurnIdentity | undefined): void {
    const attempt = this.#ownership.attempt(chatId);
    if (!attempt?.matches(turn)) return;
    attempt.markTerminalObserved();
    this.#settleDirectAttempt(chatId, attempt);
  }

  #settleDirectAttempt(chatId: string, attempt: QueueExecutionAttempt): void {
    if (!attempt.isSettlementReady) return;
    if (!this.#ownership.isCurrentAttempt(chatId, attempt)) return;
    attempt.markSettled();
    this.#ownership.removeAttempt(chatId, attempt);
    this.emit('turn-settled', chatId, attempt.identity());
    this.#ownership.notifyOwnersChanged();
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
      if (outcome === 'released' || !this.#turnRunner.isChatRunning(reservation.chatId)) {
        attempt.markTerminalObserved();
      }
      this.#settleDirectAttempt(reservation.chatId, attempt);
    }
    const drainRequested = this.#ownership.hasDrainRequest(reservation.chatId);
    this.#ownership.notifyOwnersChanged();
    if (!this.#chatExists(reservation.chatId) || this.#shuttingDown) return;
    if (outcome === 'completed' || drainRequested) await this.triggerDrain(reservation.chatId);
  }

  async #abortStop(chatId: string, intent: ChatStopIntent): Promise<boolean> {
    const operation = this.#ownership.reserveStop(chatId, intent);
    this.#startStop(chatId, operation);
    try {
      return await operation.promise;
    } finally {
      this.#ownership.clearStop(chatId, operation);
    }
  }

  #drainStopBarrier(chatId: string): Promise<boolean> | null {
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
    const ownsStop = existingStop === undefined;
    try {
      await this.pauseChatQueue(chatId);
    } catch (error) {
      if (ownsStop && !operation.started) operation.resolve(false);
      if (ownsStop) this.#ownership.clearStop(chatId, operation);
      this.#ownership.clearAbortSuppression(chatId);
      this.#ownership.exitManualStop(chatId, { drainStillActive: false });
      throw error;
    }
    let stopped: boolean;
    try {
      this.#startStop(chatId, operation);
      stopped = await operation.promise;
    } finally {
      this.#ownership.clearStop(chatId, operation);
      this.#ownership.clearAbortSuppression(chatId);
      this.#ownership.exitManualStop(chatId, {
        drainStillActive: drainWasActive && this.#ownership.isDraining(chatId),
      });
    }
    return { stopped, control: await this.readChatExecutionControl(chatId) };
  }

  async #interruptActiveTurn(chatId: string): Promise<boolean> {
    try {
      const stopped = await this.#abortStop(chatId, 'interrupt-and-send');
      if (stopped) this.#ownership.clearAbortSuppression(chatId);
      return stopped;
    } finally {
      this.#requestDrain(chatId, 'interrupt');
    }
  }

  async #abortForDeletion(chatId: string): Promise<boolean> {
    this.#ownership.enterDeletionSuppression(chatId);
    try {
      const attempt = this.#ownership.attempt(chatId);
      if (!attempt && !this.#turnRunner.isChatRunning(chatId)) return true;
      const aborted = await this.#abortStop(chatId, 'chat-deletion');
      if (!aborted) {
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
    this.#performStop(chatId, operation.intent, operation.stopId).then(
      operation.resolve,
      operation.reject,
    );
  }

  async #performStop(chatId: string, intent: ChatStopIntent, stopId: string): Promise<boolean> {
    const attempt = this.#ownership.attempt(chatId);
    const registered = attempt?.entryId ? await attempt.waitUntilRegistered() : Boolean(attempt);
    const currentAttempt = attempt && this.#ownership.isCurrentAttempt(chatId, attempt)
      ? attempt
      : undefined;
    try {
      this.emit('session-stop-requested', chatId, stopId, currentAttempt?.identity());
    } catch (error) {
      currentAttempt?.allowLaunch();
      throw error;
    }
    if (currentAttempt && registered) {
      currentAttempt.allowLaunch();
      const abortable = await this.#waitUntilStopAbortable(chatId, currentAttempt);
      if (!abortable) {
        this.emit('session-stopped', chatId, false, intent, stopId);
        return false;
      }
      if (currentAttempt.entryId) currentAttempt.expectAbort(stopId);
    }
    try {
      const success = await this.#turnRunner.abortSession(chatId);
      if (!success) currentAttempt?.clearExpectedAbort(stopId);
      this.emit('session-stopped', chatId, success, intent, stopId);
      if (success && currentAttempt && !this.#turnRunner.isChatRunning(chatId)) {
        currentAttempt.markTerminalObserved();
        this.#settleDirectAttempt(chatId, currentAttempt);
      }
      return success;
    } catch (error) {
      currentAttempt?.clearExpectedAbort(stopId);
      this.emit('session-stopped', chatId, false, intent, stopId);
      throw error;
    }
  }

  async #waitUntilStopAbortable(chatId: string, attempt: QueueExecutionAttempt): Promise<boolean> {
    const controller = new AbortController();
    const runtimeAbortable = this.#turnRunner.waitUntilTurnAbortable(
      chatId,
      attempt.identity(),
      controller.signal,
    ).then(
      (isAbortable) => {
        if (isAbortable && this.#ownership.isCurrentAttempt(chatId, attempt)) attempt.markAbortable();
        return isAbortable;
      },
      () => false,
    );
    try {
      return await Promise.race([attempt.waitUntilAbortable(), runtimeAbortable]);
    } finally {
      controller.abort();
    }
  }

  #rollbackDeletion(chatId: string): void {
    this.#ownership.clearDeletionSuppression(chatId);
    this.#requestDrain(chatId, 'deletion rollback');
  }
}

function assertTurnIdentifiers(
  options: RunAgentTurnOptions,
): asserts options is RunAgentTurnOptions & Required<Pick<
  RunAgentTurnOptions,
  'clientRequestId' | 'clientMessageId' | 'turnId'
>> {
  if (!options.clientRequestId || !options.clientMessageId || !options.turnId) {
    throw new DomainError(
      'INTERNAL_ERROR',
      'Accepted input is missing command identifiers',
      500,
    );
  }
}
