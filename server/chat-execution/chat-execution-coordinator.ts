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
  QueuedTurnFinalizationTracker,
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
  #draining = new Set<string>();
  #directTurns = new Map<string, string>();
  #directTurnAdmissionControllers = new Map<string, AbortController>();
  #drainAdmissionControllers = new Map<string, AbortController>();
  #activeDrainEntries = new Map<string, string>();
  #shutdownDrainAborts = new Map<string, string>();
  #executionOwnerWaiters = new Set<() => void>();
  #pendingDrainRequests = new Set<string>();
  #drainSuppressions = new Map<string, Set<DrainSuppressionReason>>();
  #executionAttempts = new Map<string, QueueExecutionAttempt>();
  #turnFinalizations = new QueuedTurnFinalizationTracker();
  #sessionStopByChatId = new Map<string, SessionStopInFlight>();
  #continuedRecoveredInputChats = new Set<string>();
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
        || this.#directTurns.has(chatId)
        || this.#sessionStopByChatId.has(chatId)
        || this.#turnRunner.isChatRunning(chatId)
      ),
      isShuttingDown: () => this.#shuttingDown,
      hasManualStop: (chatId) => this.#hasDrainSuppression(chatId, 'manual-stop'),
      interruptInFlight: (chatId) => {
        const stop = this.#sessionStopByChatId.get(chatId);
        return stop?.intent === 'interrupt-and-send' ? stop.promise : null;
      },
      popNext: (chatId) => this.popNextChat(chatId),
      readControl: (chatId) => this.readChatExecutionControl(chatId),
      setActiveEntry: (chatId, entryId) => { this.#activeDrainEntries.set(chatId, entryId); },
      setAdmissionController: (chatId, controller) => {
        this.#drainAdmissionControllers.set(chatId, controller);
      },
      shutdownTargetsEntry: (chatId, entryId) => this.#shutdownDrainAborts.get(chatId) === entryId,
      resolveOptions: (chatId) => this.#getDrainOptions(chatId),
      usesRecoveredHistory: (chatId) => this.#continuedRecoveredInputChats.has(chatId),
      beginFinalization: (chatId, turnId) => this.#turnFinalizations.begin(chatId, turnId),
      installAttempt: (chatId, attempt) => {
        if (this.#executionAttempts.has(chatId)) {
          throw new Error('Another chat turn already owns execution');
        }
        this.#executionAttempts.set(chatId, attempt);
      },
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
    for (const controller of this.#directTurnAdmissionControllers.values()) {
      controller.abort(reason);
    }
    for (const [chatId, entryId] of this.#activeDrainEntries) {
      this.#shutdownDrainAborts.set(chatId, entryId);
    }
    for (const controller of this.#drainAdmissionControllers.values()) {
      controller.abort(reason);
    }
    return [...new Set([
      ...this.#directTurns.keys(),
      ...this.#draining,
      ...this.#executionAttempts.keys(),
    ])];
  }

  async abortForShutdown(chatId: string): Promise<boolean> {
    const entryId = this.#activeDrainEntries.get(chatId);
    if (entryId) this.#shutdownDrainAborts.set(chatId, entryId);
    this.#directTurnAdmissionControllers.get(chatId)?.abort(
      new Error('Turn interrupted because the server is shutting down'),
    );
    this.#drainAdmissionControllers.get(chatId)?.abort(
      new Error('Turn interrupted because the server is shutting down'),
    );
    if (!this.#executionAttempts.has(chatId) && !this.#turnRunner.isChatRunning(chatId)) {
      return true;
    }
    return this.#abortSession(chatId, 'stop');
  }

  async waitForExecutionOwners(): Promise<void> {
    while (this.#hasExecutionOwner()) {
      await new Promise<void>((resolve) => {
        this.#executionOwnerWaiters.add(resolve);
        if (!this.#hasExecutionOwner()) {
          this.#executionOwnerWaiters.delete(resolve);
          resolve();
        }
      });
    }
  }

  onAgentTurnTerminal(chatId: string, turn: TurnIdentity | undefined): void {
    const attempt = this.#executionAttempts.get(chatId);
    if (!attempt?.matches(turn)) return;
    attempt.markTerminalObserved();
    this.#settleExecutionAttempt(chatId, attempt);
  }

  #hasExecutionOwner(): boolean {
    return this.#draining.size > 0
      || this.#directTurns.size > 0
      || this.#executionAttempts.size > 0;
  }

  #notifyExecutionOwnersChanged(): void {
    for (const resolve of this.#executionOwnerWaiters) resolve();
    this.#executionOwnerWaiters.clear();
  }

  getQueuedTurnFinalization(
    chatId: string,
    turnId: string | undefined,
  ): Promise<QueuedTurnFinalizationOutcome> | null {
    return this.#turnFinalizations.get(chatId, turnId);
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
    if (this.#draining.has(chatId)) return;
    if (this.#turnRunner.isChatRunning(chatId)) return;
    const queue = await this.readChatExecutionControl(chatId);
    if (this.#isDrainSuppressed(chatId)) {
      const hasPending = queue.entries.some((e) => e.status === 'queued' || e.status === 'sending');
      if (!hasPending) {
        this.#pendingDrainRequests.delete(chatId);
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
      this.#pendingDrainRequests.delete(chatId);
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
    this.#pendingDrainRequests.delete(chatId);
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
    this.#continuedRecoveredInputChats.add(chatId);
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
    this.#continuedRecoveredInputChats.delete(chatId);
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
      this.#directTurns.has(chatId)
      || this.#draining.has(chatId)
      || this.#executionAttempts.has(chatId)
      || this.#turnRunner.isChatRunning(chatId)
    ) {
      throw new DomainError('SESSION_BUSY', 'Another chat turn already owns execution', 409, true);
    }
    const admissionController = new AbortController();
    const reservation = Object.freeze({
      chatId,
      reservationId: crypto.randomUUID(),
      executionAdmission: Object.freeze({
        signal: admissionController.signal,
        markStarted: () => undefined,
      }),
    });
    this.#directTurns.set(chatId, reservation.reservationId);
    this.#directTurnAdmissionControllers.set(chatId, admissionController);
    const identity = executionTurnIdentity(turn) ?? { turnId: crypto.randomUUID() };
    this.#executionAttempts.set(chatId, new QueueExecutionAttempt(identity));
    return reservation;
  }

  assertDirectTurnReservationActive(reservation: DirectTurnReservation): void {
    this.#assertRecoveryReady();
    if (this.#directTurns.get(reservation.chatId) !== reservation.reservationId) {
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
    if (result.changed) this.#continuedRecoveredInputChats.add(reservation.chatId);
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
    const attempt = this.#executionAttempts.get(reservation.chatId);
    if (!attempt) throw new Error('Direct turn execution attempt is missing');
    if (identity && !attempt.matches(identity)) attempt.replaceReservedTurn(identity);
    attempt.markLaunching();
    let outcome: 'completed' | 'failed' = 'failed';
    try {
      reservation.executionAdmission.signal.throwIfAborted();
      await this.#turnRunner.runAgentTurn(reservation.chatId, command, {
        ...options,
        ...(this.#continuedRecoveredInputChats.has(reservation.chatId)
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
    if (this.#directTurns.get(reservation.chatId) !== reservation.reservationId) {
      if (!this.#chatExists(reservation.chatId)) return;
      throw new Error('Direct turn reservation is no longer active');
    }
    this.#directTurns.delete(reservation.chatId);
    const attempt = this.#executionAttempts.get(reservation.chatId);
    if (attempt) {
      attempt.markRunSettled();
      if (outcome === 'released' || !this.#turnRunner.isChatRunning(reservation.chatId)) {
        attempt.markTerminalObserved();
      }
      this.#settleExecutionAttempt(reservation.chatId, attempt);
    }
    const drainRequested = this.#pendingDrainRequests.has(reservation.chatId);
    this.#notifyExecutionOwnersChanged();
    if (!this.#chatExists(reservation.chatId)) return;
    if (this.#shuttingDown) return;
    if (outcome === 'completed' || drainRequested) await this.triggerDrain(reservation.chatId);
  }

  #settleExecutionAttempt(chatId: string, attempt: QueueExecutionAttempt): void {
    if (!attempt.isSettlementReady) return;
    if (this.#executionAttempts.get(chatId) !== attempt) return;
    attempt.markSettled();
    this.#executionAttempts.delete(chatId);
    this.#directTurnAdmissionControllers.delete(chatId);
    this.emit('turn-settled', chatId, attempt.identity());
    this.#notifyExecutionOwnersChanged();
  }

  #isExecutionAttemptRetired(
    chatId: string,
    attempt: QueueExecutionAttempt | undefined,
  ): boolean {
    return !attempt
      || (attempt.isSettled && this.#executionAttempts.get(chatId) !== attempt);
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
        if (isAbortable && this.#executionAttempts.get(chatId) === attempt) {
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
      if (this.#sessionStopByChatId.get(chatId) === operation) {
        this.#sessionStopByChatId.delete(chatId);
      }
    }
  }

  #reserveSessionStop(chatId: string, intent: ChatStopIntent): SessionStopInFlight {
    const inFlight = this.#sessionStopByChatId.get(chatId);
    if (inFlight) return inFlight;
    const stopId = crypto.randomUUID();
    let resolveStop!: (success: boolean) => void;
    let rejectStop!: (error: unknown) => void;
    const stop = new Promise<boolean>((resolve, reject) => {
      resolveStop = resolve;
      rejectStop = reject;
    });
    const operation: SessionStopInFlight = {
      intent,
      stopId,
      promise: stop,
      resolve: resolveStop,
      reject: rejectStop,
      started: false,
    };
    this.#sessionStopByChatId.set(chatId, operation);
    return operation;
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
    await this.#sessionStopByChatId.get(chatId)?.promise.catch(() => undefined);
  }

  async #performAbortSession(
    chatId: string,
    intent: ChatStopIntent,
    stopId: string,
  ): Promise<boolean> {
    const attempt = this.#executionAttempts.get(chatId);
    const registered = attempt?.entryId ? await attempt.waitUntilRegistered() : Boolean(attempt);
    const currentAttempt = this.#executionAttempts.get(chatId) === attempt ? attempt : undefined;
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
    const drainWasActive = this.#draining.has(chatId);
    this.#addDrainSuppression(chatId, 'abort');
    this.#addDrainSuppression(chatId, 'manual-stop');
    const existingStop = this.#sessionStopByChatId.get(chatId);
    const stop = this.#reserveSessionStop(chatId, 'stop');
    const ownsStop = existingStop === undefined;
    try {
      await this.pauseChatQueue(chatId);
    } catch (error) {
      if (ownsStop && !stop.started) stop.resolve(false);
      if (ownsStop && this.#sessionStopByChatId.get(chatId) === stop) {
        this.#sessionStopByChatId.delete(chatId);
      }
      this.#removeDrainSuppression(chatId, 'abort');
      this.#removeDrainSuppression(chatId, 'manual-stop');
      throw error;
    }

    let stopped: boolean;
    try {
      this.#startSessionStop(chatId, stop);
      stopped = await stop.promise;
    } finally {
      if (this.#sessionStopByChatId.get(chatId) === stop) {
        this.#sessionStopByChatId.delete(chatId);
      }
      // A durable pause now owns queued-work blocking. Clearing this temporary
      // gate also lets a later fresh queue entry run when Stop found no queue.
      this.#removeDrainSuppression(chatId, 'abort');
      if (!drainWasActive || !this.#draining.has(chatId)) {
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
      const attempt = this.#executionAttempts.get(chatId);
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
    this.#pendingDrainRequests.add(chatId);
    void this.triggerDrain(chatId).catch((error: Error) => {
      logger.error(`queue: ${context} drain error:`, error.message);
    });
  }

  isChatDraining(chatId: string): boolean {
    return this.#draining.has(chatId);
  }

  isChatExecutionReserved(chatId: string): boolean {
    return this.#draining.has(chatId) || this.#directTurns.has(chatId);
  }

  // Includes retained nonblocking attempts across the reservation-to-runtime handoff.
  hasChatExecutionOwner(chatId: string): boolean {
    return this.#draining.has(chatId)
      || this.#directTurns.has(chatId)
      || this.#executionAttempts.has(chatId);
  }

  // Triggers drain if the agent is not currently running.
  async triggerDrain(chatId: string): Promise<void> {
    if (this.#shuttingDown) return;
    if (this.#directTurns.has(chatId) || this.#draining.has(chatId)) {
      this.#pendingDrainRequests.add(chatId);
      return;
    }
    if (
      this.#isDrainSuppressed(chatId)
      || this.#sessionStopByChatId.has(chatId)
      || this.#turnRunner.isChatRunning(chatId)
    ) return;
    this.#pendingDrainRequests.delete(chatId);
    await this.#drain(chatId);
  }

  async #drain(chatId: string): Promise<void> {
    if (
      this.#shuttingDown
      || this.#draining.has(chatId)
      || this.#directTurns.has(chatId)
      || this.#isDrainSuppressed(chatId)
      || this.#sessionStopByChatId.has(chatId)
    ) return;
    this.#draining.add(chatId);
    try {
      this.#pendingDrainRequests.delete(chatId);
      await this.#dispatchSaga.run(chatId);
    } finally {
      this.#draining.delete(chatId);
      this.#drainAdmissionControllers.delete(chatId);
      this.#activeDrainEntries.delete(chatId);
      this.#shutdownDrainAborts.delete(chatId);
      this.#removeDrainSuppression(chatId, 'manual-stop');
      this.#notifyExecutionOwnersChanged();
    }
    if (!this.#shuttingDown && this.#pendingDrainRequests.has(chatId)) await this.triggerDrain(chatId);
  }

  async #returnUnsentEntry(chatId: string, entryId: string): Promise<void> {
    await this.#controlOperations.returnUnsent(chatId, entryId);
  }

  async #restorePoppedEntryAfterStop(chatId: string, entryId: string): Promise<void> {
    await this.#controlOperations.restoreStopped(chatId, entryId);
  }

  async deleteChatQueueFile(chatId: string): Promise<void> {
    await this.#locks.runExclusive(`chat:${chatId}`, async () => {
      this.#drainSuppressions.delete(chatId);
      this.#pendingDrainRequests.delete(chatId);
      this.#directTurns.delete(chatId);
      this.#directTurnAdmissionControllers.get(chatId)?.abort(
        new Error('Turn interrupted because the chat was deleted'),
      );
      this.#directTurnAdmissionControllers.delete(chatId);
      this.#drainAdmissionControllers.get(chatId)?.abort(
        new Error('Turn interrupted because the chat was deleted'),
      );
      this.#drainAdmissionControllers.delete(chatId);
      this.#activeDrainEntries.delete(chatId);
      this.#shutdownDrainAborts.delete(chatId);
      this.#turnFinalizations.clearChat(chatId);
      this.#executionAttempts.get(chatId)?.markSettled();
      this.#executionAttempts.delete(chatId);
      this.#notifyExecutionOwnersChanged();
      this.#continuedRecoveredInputChats.delete(chatId);
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
    const reasons = this.#drainSuppressions.get(chatId) ?? new Set();
    reasons.add(reason);
    this.#drainSuppressions.set(chatId, reasons);
  }

  #removeDrainSuppression(chatId: string, reason: DrainSuppressionReason): void {
    const reasons = this.#drainSuppressions.get(chatId);
    if (!reasons) return;
    reasons.delete(reason);
    if (reasons.size === 0) this.#drainSuppressions.delete(chatId);
  }

  #hasDrainSuppression(chatId: string, reason: DrainSuppressionReason): boolean {
    return this.#drainSuppressions.get(chatId)?.has(reason) === true;
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
