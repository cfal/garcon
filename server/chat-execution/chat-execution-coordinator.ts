// Manages per-chat message queues and orchestrates turn execution.
// Extends EventEmitter to notify listeners of queue state changes,
// dispatching events, stop requests, and session stops.

import crypto from 'crypto';
import { EventEmitter } from 'events';
import type { AutomaticQueuePauseKind, QueueEntry } from '../../common/queue-state.ts';
import {
  UserMessage,
  type ChatImage,
  type ChatMessage,
  type ChatStopIntent,
} from '../../common/chat-types.ts';
import type { ChatViewMessage } from '../../common/chat-view.ts';
import {
  requireChatExecutionConfig,
  type RunAgentTurnOptions,
} from '../agents/session-types.js';
import type { IChatRegistry } from '../chats/store.js';
import { KeyedPromiseLock } from '../lib/keyed-lock.js';
import { createLogger } from '../lib/log.js';
import { ActiveInputDeliveryError, DomainError } from '../lib/domain-error.js';
import type { TurnIdentity } from '../lib/turn-identity.js';
import { QueueExecutionAttempt } from './execution-attempt.js';
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
  executionTurnIdentity,
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
  type TurnFailedCallback,
  type TurnSettledCallback,
} from './types.ts';
import { QueueDispatchSaga } from './queue-dispatch-saga.ts';
import { ChatExecutionControlOperations } from './chat-execution-control-operations.ts';
import { ExecutionOwnership } from './execution-ownership.ts';

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

function normalizeChatImages(images: RunAgentTurnOptions['images']): ChatImage[] | undefined {
  if (!images?.length) return undefined;
  return images.map((image, index) => ({
    data: image.data,
    name: image.name || `image-${index + 1}`,
    ...(image.mimeType ? { mimeType: image.mimeType } : {}),
  }));
}

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
  #recoveryFailure: unknown = undefined;
  #turnRunner: AgentTurnRunnerPort;
  #pendingInputs: PendingInputsPort;
  #chatMessages: ChatMessagesPort;
  #getDrainOptions: QueueDrainOptionsResolver;
  #chatExists: ChatExistsResolver;
  #dispatchSaga: QueueDispatchSaga;
  #controlOperations: ChatExecutionControlOperations;

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
    this.#chatMessages = chatMessages;
    this.#getDrainOptions = getDrainOptions;
    this.#chatExists = chatExists;
    this.#controlOperations = new ChatExecutionControlOperations(controls, {
      runExclusive: (chatId, operation) => this.#locks.runExclusive(`chat:${chatId}`, operation),
      assertRecoveryReady: () => this.#assertRecoveryReady(),
      chatExists: (chatId) => this.#chatExists(chatId),
      publish: (chatId, control) => {
        this.emit('execution-control-updated', chatId, control);
      },
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
      settleAttempt: (chatId, attempt) => this.#settleExecutionAttempt(chatId, attempt),
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
      waitForSessionStop: (chatId) => this.#waitForSessionStop(chatId),
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
    return this.#abortSession(chatId, 'stop');
  }

  async waitForExecutionOwners(): Promise<void> {
    await this.#ownership.waitForOwners();
  }

  onAgentTurnTerminal(chatId: string, turn: TurnIdentity | undefined): void {
    const attempt = this.#ownership.attempt(chatId);
    if (!attempt?.matches(turn)) return;
    attempt.markTerminalObserved();
    this.#settleExecutionAttempt(chatId, attempt);
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
    if (!command && !options.images?.length) return;
    const deliveryStatus = options.deliveryStatus ?? 'accepted';
    const images = normalizeChatImages(options.images);
    let registeredClientRequestId: string | undefined;
    let appended: { generationId: string; messages: ChatViewMessage[] };
    try {
      const registered = await this.#pendingInputs.register(chatId, command, {
        clientRequestId: options.clientRequestId,
        clientMessageId: options.clientMessageId,
        turnId: options.turnId,
        images,
        deliveryStatus,
      });
      const registeredRecord =
        registered && typeof registered === 'object' ? (registered as { clientRequestId?: unknown }) : null;
      registeredClientRequestId =
        typeof registeredRecord?.clientRequestId === 'string'
          ? registeredRecord.clientRequestId
          : options.clientRequestId;
      const userMessage = new UserMessage(new Date().toISOString(), command, images, {
        clientRequestId: registeredClientRequestId,
        turnId: options.turnId,
        deliveryStatus,
      });
      appended = await this.#chatMessages.appendMessages(chatId, [userMessage]);
    } catch (error) {
      if (registeredClientRequestId) {
        this.#pendingInputs.discard(chatId, registeredClientRequestId);
      }
      throw error;
    }
    if (appended.messages.length > 0) {
      try {
        this.emit('chat-messages', chatId, appended.generationId, appended.messages, {
          clientRequestId: registeredClientRequestId,
          turnId: options.turnId,
        });
      } catch (error) {
        logger.warn('queue: chat-messages listener failed after durable append:', (error as Error).message);
      }
    }
  }

  reserveDirectTurn(chatId: string, turn: TurnIdentity = {}): DirectTurnReservation {
    this.#assertRecoveryReady();
    if (this.#shuttingDown) {
      throw new DomainError('SERVER_SHUTTING_DOWN', 'The server is shutting down', 503, true);
    }
    if (
      this.#ownership.hasOwner(chatId)
      || this.#turnRunner.isChatRunning(chatId)
    ) {
      throw new DomainError('SESSION_BUSY', 'Another chat turn already owns execution', 409, true);
    }
    return this.#ownership.reserveDirect(chatId, turn);
  }

  assertDirectTurnReservationActive(reservation: DirectTurnReservation): void {
    this.#assertRecoveryReady();
    if (!this.#ownership.isDirectCurrent(reservation)) {
      throw new DomainError('SESSION_BUSY', 'Direct turn reservation is no longer active', 409, true);
    }
  }

  async consumeRecoveredInputContinuationForDirectTurn(
    reservation: DirectTurnReservation,
  ): Promise<StoredChatExecutionControlState> {
    const checkpoint = () => {
      this.assertDirectTurnReservationActive(reservation);
      reservation.executionAdmission.signal.throwIfAborted();
    };
    checkpoint();
    const result = await this.#controlOperations.consumeEmptyContinuation(
      reservation.chatId,
      checkpoint,
    );
    if (result.changed) this.#ownership.continueRecoveredInput(reservation.chatId);
    return result.control;
  }

  async releaseDirectTurn(reservation: DirectTurnReservation): Promise<void> {
    await this.#finishDirectTurn(reservation, 'released');
  }

  async completeDirectTurn(reservation: DirectTurnReservation): Promise<void> {
    await this.#finishDirectTurn(reservation, 'completed');
  }

  async failDirectTurn(reservation: DirectTurnReservation): Promise<void> {
    await this.#finishDirectTurn(reservation, 'failed');
  }

  async runReservedTurn(
    reservation: DirectTurnReservation,
    command: string,
    options: RunAgentTurnOptions,
  ): Promise<void> {
    this.#assertRecoveryReady();
    this.assertDirectTurnReservationActive(reservation);
    const identity = executionTurnIdentity(options);
    const attempt = this.#ownership.attempt(reservation.chatId);
    if (!attempt) throw new Error('Direct turn execution attempt is missing');
    if (identity && !attempt.matches(identity)) attempt.replaceReservedTurn(identity);
    attempt.markLaunching();
    let outcome: 'completed' | 'failed' = 'failed';
    try {
      reservation.executionAdmission.signal.throwIfAborted();
      await this.#turnRunner.runAgentTurn(reservation.chatId, command, {
        ...options,
        ...(this.#ownership.usesRecoveredHistory(reservation.chatId)
          ? { directHistoryRecovery: 'allow-empty' as const }
          : {}),
        executionAdmission: reservation.executionAdmission,
      });
      outcome = 'completed';
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      if (!reservation.executionAdmission.signal.aborted) {
        this.emit('turn-failed', reservation.chatId, message, options);
      }
      throw error;
    } finally {
      await this.#finishDirectTurn(reservation, outcome);
    }
  }

  async #finishDirectTurn(
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
      this.#settleExecutionAttempt(reservation.chatId, attempt);
    }
    const drainRequested = this.#ownership.hasDrainRequest(reservation.chatId);
    this.#ownership.notifyOwnersChanged();
    if (!this.#chatExists(reservation.chatId)) return;
    if (this.#shuttingDown) return;
    if (outcome === 'completed' || drainRequested) await this.triggerDrain(reservation.chatId);
  }

  #settleExecutionAttempt(chatId: string, attempt: QueueExecutionAttempt): void {
    if (!attempt.isSettlementReady) return;
    if (!this.#ownership.isCurrentAttempt(chatId, attempt)) return;
    attempt.markSettled();
    this.#ownership.removeAttempt(chatId, attempt);
    this.emit('turn-settled', chatId, attempt.identity());
    this.#ownership.notifyOwnersChanged();
  }

  #isExecutionAttemptRetired(
    chatId: string,
    attempt: QueueExecutionAttempt | undefined,
  ): boolean {
    return !attempt
      || (attempt.isSettled && !this.#ownership.isCurrentAttempt(chatId, attempt));
  }

  async #waitUntilAttemptAbortable(
    chatId: string,
    attempt: QueueExecutionAttempt,
  ): Promise<boolean> {
    const controller = new AbortController();
    const runtimeAbortable = this.#turnRunner.waitUntilTurnAbortable(
      chatId,
      attempt.identity(),
      controller.signal,
    ).then(
      (isAbortable) => {
        if (isAbortable && this.#ownership.isCurrentAttempt(chatId, attempt)) {
          attempt.markAbortable();
        }
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

  async #abortSession(chatId: string, intent: ChatStopIntent): Promise<boolean> {
    const operation = this.#reserveSessionStop(chatId, intent);
    this.#startSessionStop(chatId, operation);
    try {
      return await operation.promise;
    } finally {
      this.#ownership.clearStop(chatId, operation);
    }
  }

  #reserveSessionStop(chatId: string, intent: ChatStopIntent): SessionStopInFlight {
    return this.#ownership.reserveStop(chatId, intent);
  }

  #startSessionStop(chatId: string, operation: SessionStopInFlight): void {
    if (operation.started) return;
    operation.started = true;
    this.#performAbortSession(chatId, operation.intent, operation.stopId).then(
      operation.resolve,
      operation.reject,
    );
  }

  async #waitForSessionStop(chatId: string): Promise<void> {
    await this.#ownership.stop(chatId)?.promise.catch(() => undefined);
  }

  async #performAbortSession(
    chatId: string,
    intent: ChatStopIntent,
    stopId: string,
  ): Promise<boolean> {
    const attempt = this.#ownership.attempt(chatId);
    const registered = attempt?.entryId ? await attempt.waitUntilRegistered() : Boolean(attempt);
    const currentAttempt = attempt && this.#ownership.isCurrentAttempt(chatId, attempt)
      ? attempt
      : undefined;
    this.emit(
      'session-stop-requested',
      chatId,
      stopId,
      currentAttempt?.identity(),
    );

    if (currentAttempt && registered) {
      currentAttempt.allowLaunch();
      const abortable = await this.#waitUntilAttemptAbortable(chatId, currentAttempt);
      if (!abortable) {
        this.emit('session-stopped', chatId, false, intent, stopId);
        return false;
      }
      if (currentAttempt.entryId) currentAttempt.expectAbort();
    }

    try {
      const success = await this.#turnRunner.abortSession(chatId);
      if (!success) currentAttempt?.clearExpectedAbort();
      this.emit('session-stopped', chatId, success, intent, stopId);
      if (success && currentAttempt && !this.#turnRunner.isChatRunning(chatId)) {
        currentAttempt.markTerminalObserved();
        this.#settleExecutionAttempt(chatId, currentAttempt);
      }
      return success;
    } catch (error) {
      currentAttempt?.clearExpectedAbort();
      this.emit('session-stopped', chatId, false, intent, stopId);
      throw error;
    }
  }

  async stopActiveTurn(chatId: string): Promise<StopActiveTurnResult> {
    const drainWasActive = this.#ownership.isDraining(chatId);
    this.#addDrainSuppression(chatId, 'abort');
    this.#addDrainSuppression(chatId, 'manual-stop');
    const existingStop = this.#ownership.stop(chatId);
    const stop = this.#reserveSessionStop(chatId, 'stop');
    const ownsStop = existingStop === undefined;
    try {
      await this.pauseChatQueue(chatId);
    } catch (error) {
      if (ownsStop && !stop.started) stop.resolve(false);
      if (ownsStop) this.#ownership.clearStop(chatId, stop);
      this.#removeDrainSuppression(chatId, 'abort');
      this.#removeDrainSuppression(chatId, 'manual-stop');
      throw error;
    }

    let stopped: boolean;
    try {
      this.#startSessionStop(chatId, stop);
      stopped = await stop.promise;
    } finally {
      this.#ownership.clearStop(chatId, stop);
      // A durable pause now owns queued-work blocking. Clearing this temporary
      // gate also lets a later fresh queue entry run when Stop found no queue.
      this.#removeDrainSuppression(chatId, 'abort');
      if (!drainWasActive || !this.#ownership.isDraining(chatId)) {
        this.#removeDrainSuppression(chatId, 'manual-stop');
      }
    }
    return { stopped, control: await this.readChatExecutionControl(chatId) };
  }

  async interruptActiveTurn(chatId: string): Promise<boolean> {
    try {
      const stopped = await this.#abortSession(chatId, 'interrupt-and-send');
      if (stopped) this.#removeDrainSuppression(chatId, 'abort');
      return stopped;
    } finally {
      this.#requestDrain(chatId, 'interrupt');
    }
  }

  async abortForChatDeletion(chatId: string): Promise<boolean> {
    this.#addDrainSuppression(chatId, 'deletion');
    try {
      const attempt = this.#ownership.attempt(chatId);
      if (!attempt && !this.#turnRunner.isChatRunning(chatId)) return true;

      const aborted = await this.#abortSession(chatId, 'chat-deletion');
      if (!aborted) {
        const alreadyRetired = !this.#turnRunner.isChatRunning(chatId)
          && this.#isExecutionAttemptRetired(chatId, attempt);
        if (!alreadyRetired) this.#rollbackDeletionSuppression(chatId);
        return alreadyRetired;
      }

      if (attempt) await attempt.waitUntilSettled();
      const retired = !this.#turnRunner.isChatRunning(chatId)
        && this.#isExecutionAttemptRetired(chatId, attempt);
      if (!retired) this.#rollbackDeletionSuppression(chatId);
      return retired;
    } catch (error) {
      this.#rollbackDeletionSuppression(chatId);
      throw error;
    }
  }

  #rollbackDeletionSuppression(chatId: string): void {
    this.#removeDrainSuppression(chatId, 'deletion');
    this.#requestDrain(chatId, 'deletion rollback');
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
