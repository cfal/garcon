// Manages per-chat message queues and orchestrates turn execution.
// Extends EventEmitter to notify listeners of queue state changes,
// dispatching events, stop requests, and session stops.

import crypto from 'crypto';
import { EventEmitter } from 'events';
import type { AutomaticQueuePauseKind, QueueEntry } from '../common/queue-state.ts';
import {
  UserMessage,
  type ChatImage,
  type ChatMessage,
  type ChatStopIntent,
  type UserMessageDeliveryStatus,
} from '../common/chat-types.ts';
import type { ChatViewMessage } from '../common/chat-view.ts';
import {
  requireChatExecutionConfig,
  type AgentExecutionAdmission,
  type RunAgentTurnOptions,
} from './agents/session-types.js';
import type { IChatRegistry } from './chats/store.js';
import { KeyedPromiseLock } from './lib/keyed-lock.js';
import { createLogger } from './lib/log.js';
import { ActiveInputDeliveryError, DomainError } from './lib/domain-error.js';
import type { TurnIdentity } from './lib/turn-identity.js';
import { QueueExecutionAttempt } from './queue/execution-attempt.js';
import {
  QueuedTurnFinalizationTracker,
  type QueuedTurnFinalizationHandle,
  type QueuedTurnFinalizationOutcome,
} from './queue/turn-finalization-tracker.js';
import {
  bumpStoredChatExecutionControl,
  cloneStoredChatExecutionControl,
  emptyStoredChatExecutionControl,
  normalizeStoredChatExecutionControlState,
  type StoredChatExecutionControlState,
  type StoredQueueEntry,
} from './chat-execution-control-state.ts';
import {
  JsonChatExecutionControlRepository,
  type ChatExecutionControlRepository,
} from './chat-execution/chat-execution-control-repository.ts';
import {
  clearQueue,
  consumeEmptyRecoveredInputContinuation,
  continueRecoveredInput,
  createQueueEntry,
  deleteQueueEntry,
  dropRecoveredInputContinuation,
  installRecoveryPause,
  pauseQueue,
  popNextQueueEntry,
  removeSentQueueEntry,
  replaceQueueEntry,
  requeueAndPause,
  restoreStoppedQueueEntry,
  resumeQueue,
  returnUnsentQueueEntry,
  type ControlTransition,
  type QueueCommandIdentity,
  type ReceiptRetention,
  type TransitionContext,
  type TransitionRejection,
} from './chat-execution/chat-execution-control-transitions.ts';

export type { QueueCommandIdentity } from './chat-execution/chat-execution-control-transitions.ts';

const logger = createLogger('queue');

function optionsForQueuedTurn(
  options: RunAgentTurnOptions,
  entry: StoredQueueEntry,
): RunAgentTurnOptions {
  const delivery = entry.delivery ?? {
    clientRequestId: crypto.randomUUID(),
    clientMessageId: crypto.randomUUID(),
    turnId: crypto.randomUUID(),
  };
  return {
    ...options,
    ...delivery,
  };
}

function normalizeChatImages(images: RunAgentTurnOptions['images']): ChatImage[] | undefined {
  if (!images?.length) return undefined;
  return images.map((image, index) => ({
    data: image.data,
    name: image.name || `image-${index + 1}`,
    ...(image.mimeType ? { mimeType: image.mimeType } : {}),
  }));
}

type PendingUserInputRegistrationOptions = Pick<
  RunAgentTurnOptions,
  'clientRequestId' | 'clientMessageId' | 'turnId' | 'images'
> & {
  deliveryStatus?: UserMessageDeliveryStatus;
};

export class QueueEntryMutationError extends DomainError {
  readonly control: StoredChatExecutionControlState;

  constructor(
    code: 'QUEUE_ENTRY_NOT_FOUND' | 'QUEUE_ENTRY_ALREADY_SENT' | 'QUEUE_ENTRY_REVISION_CONFLICT',
    message: string,
    control: StoredChatExecutionControlState,
  ) {
    super(code, message, code === 'QUEUE_ENTRY_NOT_FOUND' ? 404 : 409);
    this.name = 'QueueEntryMutationError';
    this.control = cloneStoredChatExecutionControl(control);
  }
}

export class QueuePauseChangedError extends DomainError {
  readonly control: StoredChatExecutionControlState;

  constructor(control: StoredChatExecutionControlState) {
    super('QUEUE_PAUSE_CHANGED', 'The queue pause changed before it could be resumed', 409);
    this.name = 'QueuePauseChangedError';
    this.control = cloneStoredChatExecutionControl(control);
  }
}

export class RecoveredInputContinuationChangedError extends DomainError {
  readonly control: StoredChatExecutionControlState;

  constructor(control: StoredChatExecutionControlState) {
    super(
      'RECOVERED_INPUT_CONTINUATION_CHANGED',
      'The recovered-input continuation changed before it could be applied',
      409,
      true,
    );
    this.name = 'RecoveredInputContinuationChangedError';
    this.control = cloneStoredChatExecutionControl(control);
  }
}

export class RecoveredInputContinuationRequiresQueueError extends DomainError {
  readonly control: StoredChatExecutionControlState;

  constructor(control: StoredChatExecutionControlState) {
    super(
      'RECOVERED_INPUT_CONTINUATION_REQUIRES_QUEUE',
      'Continue queue requires at least one queued message',
      409,
      true,
    );
    this.name = 'RecoveredInputContinuationRequiresQueueError';
    this.control = cloneStoredChatExecutionControl(control);
  }
}

interface QueueCommandMutationResult {
  entryId: string;
  control: StoredChatExecutionControlState;
  duplicate: boolean;
}

export interface StopActiveTurnResult {
  stopped: boolean;
  control: StoredChatExecutionControlState;
}

export interface DirectTurnReservation {
  readonly chatId: string;
  readonly reservationId: string;
  readonly executionAdmission: AgentExecutionAdmission;
}

function executionTurnIdentity(turn: TurnIdentity): TurnIdentity | undefined {
  if (!turn.turnId && !turn.clientRequestId) return undefined;
  return {
    ...(turn.turnId ? { turnId: turn.turnId } : {}),
    ...(turn.clientRequestId ? { clientRequestId: turn.clientRequestId } : {}),
  };
}

const EMPTY_RECEIPT_RETENTION: ReceiptRetention = { protectedKeys: new Set() };

function transitionContext(): TransitionContext {
  return { now: new Date().toISOString(), newId: () => crypto.randomUUID() };
}

function transitionError(
  rejection: TransitionRejection,
  control: StoredChatExecutionControlState,
): DomainError {
  switch (rejection.code) {
    case 'QUEUE_ENTRY_NOT_FOUND':
      return new QueueEntryMutationError(
        rejection.code,
        'This queued message is no longer available',
        control,
      );
    case 'QUEUE_ENTRY_ALREADY_SENT':
      return new QueueEntryMutationError(
        rejection.code,
        'This queued message has already been sent',
        control,
      );
    case 'QUEUE_ENTRY_REVISION_CONFLICT':
      return new QueueEntryMutationError(
        rejection.code,
        'This queued message changed before it could be saved',
        control,
      );
    case 'QUEUE_PAUSE_CHANGED':
      return new QueuePauseChangedError(control);
    case 'RECOVERED_INPUT_CONTINUATION_CHANGED':
      return new RecoveredInputContinuationChangedError(control);
    case 'RECOVERED_INPUT_CONTINUATION_REQUIRES_QUEUE':
      return new RecoveredInputContinuationRequiresQueueError(control);
  }
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

interface AgentTurnRunnerDep {
  runAgentTurn(chatId: string, command: string, options: RunAgentTurnOptions): Promise<void>;
  submitActiveInput?(
    chatId: string,
    command: string,
    options: RunAgentTurnOptions,
    beforeDelivery: () => Promise<void>,
  ): Promise<boolean>;
  abortSession(chatId: string): Promise<boolean>;
  isChatRunning(chatId: string): boolean;
  waitUntilTurnAbortable(
    chatId: string,
    turn: TurnIdentity,
    signal?: AbortSignal,
  ): Promise<boolean>;
}

interface PendingInputsDep {
  register(
    chatId: string,
    content: string,
    options?: {
      clientRequestId?: string;
      clientMessageId?: string;
      turnId?: string;
      images?: ChatImage[];
      deliveryStatus?: UserMessageDeliveryStatus;
    },
  ): Promise<unknown>;
  discard(chatId: string, clientRequestId: string): boolean;
  markFailed(chatId: string, clientRequestId: string): boolean;
  markUnconfirmed(chatId: string, clientRequestId: string): boolean;
}

interface ChatMessagesDep {
  appendMessages(
    chatId: string,
    messages: ChatMessage[],
  ): Promise<{ generationId: string; messages: ChatViewMessage[] }>;
}

type ExecutionControlUpdatedCallback = (chatId: string, control: StoredChatExecutionControlState) => void;
type DispatchingCallback = (chatId: string, entryId: string, content: string) => void;
type SessionStopRequestedCallback = (
  chatId: string,
  stopId: string,
  turn: TurnIdentity | undefined,
) => void;
type SessionStoppedCallback = (
  chatId: string,
  success: boolean,
  intent: ChatStopIntent,
  stopId: string,
) => void;
type ChatIdleCallback = (chatId: string) => void;
type TurnFailedCallback = (chatId: string, errorMessage: string, options: RunAgentTurnOptions) => void;
type TurnSettledCallback = (chatId: string, turn: TurnIdentity | undefined) => void;
type ChatMessagesCallback = (
  chatId: string,
  generationId: string,
  messages: ChatViewMessage[],
  metadata?: { clientRequestId?: string; turnId?: string },
) => void;
type QueueDrainOptionsResolver = (chatId: string) => RunAgentTurnOptions;
type ChatExistsResolver = (chatId: string) => boolean;

interface SessionStopInFlight {
  intent: ChatStopIntent;
  stopId: string;
  promise: Promise<boolean>;
  resolve(success: boolean): void;
  reject(error: unknown): void;
  started: boolean;
}

type DrainSuppressionReason = 'abort' | 'manual-stop' | 'deletion';

export interface ChatQueueService {
  deleteChatQueueFile(chatId: string): Promise<void>;
  submit(chatId: string, command: string, options: RunAgentTurnOptions): Promise<void>;
  registerPendingUserInput(
    chatId: string,
    command: string,
    options: PendingUserInputRegistrationOptions,
  ): Promise<void>;
  reserveDirectTurn(chatId: string, turn?: TurnIdentity): DirectTurnReservation;
  assertDirectTurnReservationActive(reservation: DirectTurnReservation): void;
  consumeRecoveredInputContinuationForDirectTurn(
    reservation: DirectTurnReservation,
  ): Promise<StoredChatExecutionControlState>;
  releaseDirectTurn(reservation: DirectTurnReservation): Promise<void>;
  completeDirectTurn(reservation: DirectTurnReservation): Promise<void>;
  failDirectTurn(reservation: DirectTurnReservation): Promise<void>;
  runReservedTurn(
    reservation: DirectTurnReservation,
    command: string,
    options: RunAgentTurnOptions,
  ): Promise<void>;
  stopActiveTurn(chatId: string): Promise<StopActiveTurnResult>;
  interruptActiveTurn(chatId: string): Promise<boolean>;
  abortForChatDeletion(chatId: string): Promise<boolean>;
  beginShutdown(): string[];
  abortForShutdown(chatId: string): Promise<boolean>;
  waitForExecutionOwners(): Promise<void>;
  getQueuedTurnFinalization(
    chatId: string,
    turnId: string | undefined,
  ): Promise<QueuedTurnFinalizationOutcome> | null;
  isChatDraining(chatId: string): boolean;
  isChatExecutionReserved(chatId: string): boolean;
  hasChatExecutionOwner(chatId: string): boolean;
  triggerDrain(chatId: string): Promise<void>;
  readChatExecutionControl(chatId: string): Promise<StoredChatExecutionControlState>;
  hasAppliedQueueCreateCommand(chatId: string, commandKey: string, entryId: string): Promise<boolean>;
  createChatQueueEntry(
    chatId: string,
    content: string,
    command?: QueueCommandIdentity,
    receipts?: ReceiptRetention,
  ): Promise<QueueCommandMutationResult & { entry: QueueEntry | null }>;
  replaceChatQueueEntry(
    chatId: string,
    entryId: string,
    content: string,
    expectedRevision: number,
    command?: QueueCommandIdentity,
    receipts?: ReceiptRetention,
  ): Promise<QueueCommandMutationResult & { entry: QueueEntry | null }>;
  deleteChatQueueEntry(
    chatId: string,
    entryId: string,
    command?: QueueCommandIdentity,
    receipts?: ReceiptRetention,
  ): Promise<QueueCommandMutationResult>;
  deliverActiveInput(
    chatId: string,
    content: string,
    options?: RunAgentTurnOptions,
    afterPendingRegistered?: () => Promise<void>,
  ): Promise<boolean>;
  clearChatQueue(chatId: string): Promise<StoredChatExecutionControlState>;
  pauseChatQueue(chatId: string): Promise<StoredChatExecutionControlState>;
  resumeChatQueue(chatId: string, pauseId: string): Promise<StoredChatExecutionControlState>;
  continuePastRecoveredInput(
    chatId: string,
    continuationId: string,
  ): Promise<StoredChatExecutionControlState>;
  dropRecoveredInputContinuation(chatId: string): Promise<StoredChatExecutionControlState>;
  requeueAndPauseChat(
    chatId: string,
    entryId: string,
    kind: AutomaticQueuePauseKind,
  ): Promise<StoredChatExecutionControlState>;
}

export class QueueManager extends EventEmitter implements ChatQueueService {
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
  #controls: ChatExecutionControlRepository;
  #turnRunner: AgentTurnRunnerDep;
  #pendingInputs: PendingInputsDep;
  #chatMessages: ChatMessagesDep;
  #getDrainOptions: QueueDrainOptionsResolver;
  #chatExists: ChatExistsResolver;

  constructor(
    workspaceDir: string,
    turnRunner: AgentTurnRunnerDep,
    pendingInputs: PendingInputsDep,
    chatMessages: ChatMessagesDep,
    getDrainOptions: QueueDrainOptionsResolver,
    chatExists: ChatExistsResolver,
    controls: ChatExecutionControlRepository = new JsonChatExecutionControlRepository(workspaceDir),
  ) {
    super();
    if (!turnRunner) throw new Error('QueueManager requires an agent turn runner');
    if (typeof turnRunner.waitUntilTurnAbortable !== 'function') {
      throw new Error('QueueManager requires an abortable turn-start boundary');
    }
    if (!pendingInputs) throw new Error('QueueManager requires a pending input service');
    if (!chatMessages) throw new Error('QueueManager requires chat message storage');
    if (!getDrainOptions) throw new Error('QueueManager requires a drain option resolver');
    if (!chatExists) throw new Error('QueueManager requires a chat existence resolver');
    this.#controls = controls;
    this.#turnRunner = turnRunner;
    this.#pendingInputs = pendingInputs;
    this.#chatMessages = chatMessages;
    this.#getDrainOptions = getDrainOptions;
    this.#chatExists = chatExists;
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

  #logMutation(
    operation: 'create' | 'replace' | 'delete' | 'pop' | 'requeue' | 'sent',
    chatId: string,
    entryId: string,
    queue: StoredChatExecutionControlState,
    revision?: number,
    errorCode?: string,
  ): void {
    logger.debug('queue mutation', {
      chatId,
      operation,
      entryId,
      ...(revision === undefined ? {} : { revision }),
      queueVersion: queue.version,
      queuedCount: queue.entries.filter((entry) => entry.status === 'queued').length,
      ...(errorCode ? { errorCode } : {}),
    });
  }

  #logPauseMutation(
    operation: 'pause' | 'resume' | 'recover',
    chatId: string,
    queue: StoredChatExecutionControlState,
    entryId?: string,
  ): void {
    logger.debug('queue pause mutation', {
      chatId,
      operation,
      ...(entryId ? { entryId } : {}),
      ...(queue.pause ? { pauseId: queue.pause.id, pauseKind: queue.pause.kind } : {}),
      queueVersion: queue.version,
      queuedCount: queue.entries.filter((entry) => entry.status === 'queued').length,
    });
  }

  #logRecoveredInputContinuation(
    operation: 'startup-install'
      | 'interactive-continue'
      | 'explicit-continue'
      | 'native-settlement'
      | 'stale-reject'
      | 'empty-queue-reject',
    chatId: string,
    control: StoredChatExecutionControlState,
  ): void {
    logger.debug('recovered-input continuation', {
      chatId,
      operation,
      ...(control.recoveredInputContinuation
        ? { continuationId: control.recoveredInputContinuation.id }
        : {}),
      controlVersion: control.version,
      queuedCount: control.entries.filter((entry) => entry.status === 'queued').length,
    });
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

  async #withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    return this.#locks.runExclusive(key, fn);
  }

  async #loadChatExecutionControl(chatId: string): Promise<StoredChatExecutionControlState> {
    this.#assertRecoveryReady();
    return this.#controls.load(chatId);
  }

  async #commitChatExecutionControl(
    chatId: string,
    control: unknown,
  ): Promise<StoredChatExecutionControlState> {
    if (!this.#chatExists(chatId)) {
      throw new DomainError('SESSION_NOT_FOUND', 'Chat queue owner no longer exists', 404);
    }
    return this.#controls.save(chatId, normalizeStoredChatExecutionControlState(control));
  }

  async #commitAndPublish(
    chatId: string,
    control: StoredChatExecutionControlState,
  ): Promise<StoredChatExecutionControlState> {
    const result = await this.#commitChatExecutionControl(chatId, control);
    this.emit('execution-control-updated', chatId, result);
    return result;
  }

  async #commitTransition<T>(
    chatId: string,
    current: StoredChatExecutionControlState,
    transition: ControlTransition<T>,
  ): Promise<{ value: T; control: StoredChatExecutionControlState; changed: boolean }> {
    if (transition.outcome.status === 'rejected') {
      throw transitionError(transition.outcome.rejection, current);
    }
    if (!transition.changed) {
      return {
        value: transition.outcome.value,
        control: cloneStoredChatExecutionControl(current),
        changed: false,
      };
    }
    return {
      value: transition.outcome.value,
      control: await this.#commitAndPublish(chatId, transition.next),
      changed: true,
    };
  }

  async readChatExecutionControl(chatId: string): Promise<StoredChatExecutionControlState> {
    return this.#withLock(`chat:${chatId}`, async () => (
      cloneStoredChatExecutionControl(await this.#loadChatExecutionControl(chatId))
    ));
  }

  async createChatQueueEntry(
    chatId: string,
    content: string,
    command?: QueueCommandIdentity,
    receipts: ReceiptRetention = EMPTY_RECEIPT_RETENTION,
  ): Promise<QueueCommandMutationResult & { entry: QueueEntry | null }> {
    return this.#withLock(`chat:${chatId}`, async () => {
      const current = await this.#loadChatExecutionControl(chatId);
      const committed = await this.#commitTransition(
        chatId,
        current,
        createQueueEntry(current, { content, command }, transitionContext(), receipts),
      );
      const result = committed.value;
      if (!result.duplicate) {
        this.#logMutation('create', chatId, result.entryId, committed.control, result.entry?.revision);
      }
      return { ...result, control: committed.control };
    });
  }

  async replaceChatQueueEntry(
    chatId: string,
    entryId: string,
    content: string,
    expectedRevision: number,
    command?: QueueCommandIdentity,
    receipts: ReceiptRetention = EMPTY_RECEIPT_RETENTION,
  ): Promise<QueueCommandMutationResult & { entry: QueueEntry | null }> {
    return this.#withLock(`chat:${chatId}`, async () => {
      const current = await this.#loadChatExecutionControl(chatId);
      const transition = replaceQueueEntry(current, {
        entryId,
        content,
        expectedRevision,
        command,
      }, transitionContext(), receipts);
      if (transition.outcome.status === 'rejected') {
        this.#logMutation(
          'replace',
          chatId,
          entryId,
          current,
          current.entries.find((entry) => entry.id === entryId)?.revision,
          transition.outcome.rejection.code,
        );
      }
      const committed = await this.#commitTransition(chatId, current, transition);
      const result = committed.value;
      if (!result.duplicate) {
        this.#logMutation('replace', chatId, entryId, committed.control, result.entry?.revision);
      }
      return { ...result, control: committed.control };
    });
  }

  async deleteChatQueueEntry(
    chatId: string,
    entryId: string,
    command?: QueueCommandIdentity,
    receipts: ReceiptRetention = EMPTY_RECEIPT_RETENTION,
  ): Promise<QueueCommandMutationResult> {
    return this.#withLock(`chat:${chatId}`, async () => {
      const current = await this.#loadChatExecutionControl(chatId);
      const transition = deleteQueueEntry(
        current,
        { entryId, command },
        transitionContext(),
        receipts,
      );
      if (transition.outcome.status === 'rejected') {
        this.#logMutation(
          'delete',
          chatId,
          entryId,
          current,
          current.entries.find((entry) => entry.id === entryId)?.revision,
          transition.outcome.rejection.code,
        );
      }
      const committed = await this.#commitTransition(chatId, current, transition);
      if (!committed.value.duplicate) this.#logMutation('delete', chatId, entryId, committed.control);
      return {
        entryId: committed.value.entryId,
        control: committed.control,
        duplicate: committed.value.duplicate,
      };
    });
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
    return this.#withLock(`chat:${chatId}`, async () => {
      const current = await this.#loadChatExecutionControl(chatId);
      this.#removeDrainSuppression(chatId, 'abort');
      this.#pendingDrainRequests.delete(chatId);
      return (await this.#commitTransition(
        chatId,
        current,
        clearQueue(current, transitionContext()),
      )).control;
    });
  }

  async pauseChatQueue(chatId: string): Promise<StoredChatExecutionControlState> {
    return this.#withLock(`chat:${chatId}`, async () => {
      const current = await this.#loadChatExecutionControl(chatId);
      const committed = await this.#commitTransition(
        chatId,
        current,
        pauseQueue(current, transitionContext()),
      );
      if (committed.changed) this.#logPauseMutation('pause', chatId, committed.control);
      return committed.control;
    });
  }

  async resumeChatQueue(chatId: string, pauseId: string): Promise<StoredChatExecutionControlState> {
    return this.#withLock(`chat:${chatId}`, async () => {
      const current = await this.#loadChatExecutionControl(chatId);
      const committed = await this.#commitTransition(
        chatId,
        current,
        resumeQueue(current, pauseId, transitionContext()),
      );
      if (committed.changed) {
        this.#removeDrainSuppression(chatId, 'abort');
        this.#logPauseMutation('resume', chatId, committed.control);
      }
      return committed.control;
    });
  }

  async continuePastRecoveredInput(
    chatId: string,
    continuationId: string,
  ): Promise<StoredChatExecutionControlState> {
    const result = await this.#withLock(`chat:${chatId}`, async () => {
      const current = await this.#loadChatExecutionControl(chatId);
      const transition = continueRecoveredInput(current, continuationId, transitionContext());
      if (transition.outcome.status === 'rejected') {
        this.#logRecoveredInputContinuation(
          transition.outcome.rejection.code === 'RECOVERED_INPUT_CONTINUATION_CHANGED'
            ? 'stale-reject'
            : 'empty-queue-reject',
          chatId,
          current,
        );
      }
      const committed = (await this.#commitTransition(chatId, current, transition)).control;
      this.#continuedRecoveredInputChats.add(chatId);
      this.#logRecoveredInputContinuation('explicit-continue', chatId, committed);
      return committed;
    });
    this.#requestDrain(chatId, 'recovered-input continuation');
    return result;
  }

  async hasAppliedQueueCreateCommand(
    chatId: string,
    commandKey: string,
    entryId: string,
  ): Promise<boolean> {
    return this.#withLock(`chat:${chatId}`, async () => {
      const control = await this.#loadChatExecutionControl(chatId);
      return control.appliedCommands.some((command) => (
        command.key === commandKey
        && command.operation === 'create'
        && command.entryId === entryId
      ));
    });
  }

  async dropRecoveredInputContinuation(chatId: string): Promise<StoredChatExecutionControlState> {
    const result = await this.#withLock(`chat:${chatId}`, async () => {
      const current = await this.#loadChatExecutionControl(chatId);
      this.#continuedRecoveredInputChats.delete(chatId);
      const result = await this.#commitTransition(
        chatId,
        current,
        dropRecoveredInputContinuation(current, transitionContext()),
      );
      if (result.changed) {
        this.#logRecoveredInputContinuation('native-settlement', chatId, result.control);
      }
      return result.control;
    });
    this.#requestDrain(chatId, 'recovered-input settlement');
    return result;
  }

  async popNextChat(
    chatId: string,
  ): Promise<{ entry: StoredQueueEntry; control: StoredChatExecutionControlState } | null> {
    return this.#withLock(`chat:${chatId}`, async () => {
      const current = await this.#loadChatExecutionControl(chatId);
      const committed = await this.#commitTransition(
        chatId,
        current,
        popNextQueueEntry(current, transitionContext()),
      );
      if (!committed.value) return null;
      const entry = committed.control.entries.find(
        (candidate) => candidate.id === committed.value!.entry.id,
      )!;
      this.#logMutation('pop', chatId, entry.id, committed.control, entry.revision);
      return { entry, control: committed.control };
    });
  }

  async removeSentChat(chatId: string, entryId: string): Promise<StoredChatExecutionControlState> {
    return this.#withLock(`chat:${chatId}`, async () => {
      const current = await this.#loadChatExecutionControl(chatId);
      const committed = await this.#commitTransition(
        chatId,
        current,
        removeSentQueueEntry(current, entryId, transitionContext()),
      );
      this.#logMutation('sent', chatId, entryId, committed.control);
      return committed.control;
    });
  }

  async requeueAndPauseChat(
    chatId: string,
    entryId: string,
    kind: AutomaticQueuePauseKind,
  ): Promise<StoredChatExecutionControlState> {
    return this.#withLock(`chat:${chatId}`, async () => {
      const current = await this.#loadChatExecutionControl(chatId);
      const priorEntry = current.entries.find((entry) => entry.id === entryId);
      const committed = await this.#commitTransition(
        chatId,
        current,
        requeueAndPause(current, { entryId, kind }, transitionContext()),
      );
      if (priorEntry) {
        this.#logMutation('requeue', chatId, entryId, committed.control, priorEntry.revision);
      }
      this.#logPauseMutation('pause', chatId, committed.control, entryId);
      return committed.control;
    });
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
    this.assertDirectTurnReservationActive(reservation);
    reservation.executionAdmission.signal.throwIfAborted();

    return this.#withLock(`chat:${reservation.chatId}`, async () => {
      this.assertDirectTurnReservationActive(reservation);
      reservation.executionAdmission.signal.throwIfAborted();
      const control = await this.#loadChatExecutionControl(reservation.chatId);
      this.assertDirectTurnReservationActive(reservation);
      reservation.executionAdmission.signal.throwIfAborted();
      const committed = await this.#commitTransition(
        reservation.chatId,
        control,
        consumeEmptyRecoveredInputContinuation(control, transitionContext()),
      );
      if (committed.changed) {
        this.#continuedRecoveredInputChats.add(reservation.chatId);
        this.#logRecoveredInputContinuation(
          'interactive-continue',
          reservation.chatId,
          committed.control,
        );
      }
      this.assertDirectTurnReservationActive(reservation);
      reservation.executionAdmission.signal.throwIfAborted();
      return committed.control;
    });
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

  // Pops queued entries one at a time, registers a pending overlay, and runs agent turns.
  // Re-entrant callers (runReservedTurn's post-turn drain racing onFinished's
  // checkChatIdle) are coalesced: a second drain while one is active is a no-op.
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
      while (true) {
        if (
          this.#shuttingDown
          || this.#isDrainSuppressed(chatId)
          || this.#hasDrainSuppression(chatId, 'manual-stop')
          || this.#directTurns.has(chatId)
          || this.#sessionStopByChatId.has(chatId)
          || this.#turnRunner.isChatRunning(chatId)
        ) break;

        this.#pendingDrainRequests.delete(chatId);
        const result = await this.popNextChat(chatId);
        if (!result) {
          const queue = await this.readChatExecutionControl(chatId);
          const hasPending = queue.entries.some((e) => e.status === 'queued' || e.status === 'sending');
          if (!hasPending) this.emit('chat-idle', chatId);
          break;
        }

        const { entry } = result;
        this.#activeDrainEntries.set(chatId, entry.id);
        if (this.#shuttingDown) {
          await this.#returnUnsentEntry(chatId, entry.id);
          break;
        }
        if (this.#hasDrainSuppression(chatId, 'manual-stop')) {
          await this.#restorePoppedEntryAfterStop(chatId, entry.id);
          break;
        }
        const inFlightStop = this.#sessionStopByChatId.get(chatId);
        if (inFlightStop?.intent === 'interrupt-and-send') {
          await inFlightStop.promise.catch(() => undefined);
          if (this.#hasDrainSuppression(chatId, 'manual-stop')) {
            await this.#restorePoppedEntryAfterStop(chatId, entry.id);
            break;
          }
        }
        let queuedTurnOptions: RunAgentTurnOptions = {};
        let stage: 'preparing' | 'running' | 'finalizing' = 'preparing';
        let attempt: QueueExecutionAttempt | undefined;
        let finalization: QueuedTurnFinalizationHandle | undefined;
        let executionStarted = false;
        const admissionController = new AbortController();
        this.#drainAdmissionControllers.set(chatId, admissionController);

        try {
          queuedTurnOptions = optionsForQueuedTurn(this.#getDrainOptions(chatId), entry);
          if (this.#continuedRecoveredInputChats.has(chatId)) {
            queuedTurnOptions.directHistoryRecovery = 'allow-empty';
          }
          queuedTurnOptions.executionAdmission = Object.freeze({
            signal: admissionController.signal,
            markStarted: () => { executionStarted = true; },
          });
          if (this.#shuttingDown) {
            admissionController.abort(new Error('Turn interrupted because the server is shutting down'));
          }
          const turn = executionTurnIdentity(queuedTurnOptions)!;
          finalization = this.#turnFinalizations.begin(chatId, turn.turnId!);
          attempt = new QueueExecutionAttempt(turn, entry.id);
          if (this.#executionAttempts.has(chatId)) {
            throw new Error('Another chat turn already owns execution');
          }
          this.#executionAttempts.set(chatId, attempt);
          await this.registerPendingUserInput(chatId, entry.content, queuedTurnOptions);
          attempt.markRegistered();
          if (
            this.#sessionStopByChatId.has(chatId)
            || this.#hasDrainSuppression(chatId, 'manual-stop')
            || this.#hasDrainSuppression(chatId, 'deletion')
          ) {
            stage = 'running';
            const shouldStart = await attempt.waitForLaunchDecision();
            if (!shouldStart) throw new Error('Queued turn stopped before runtime start');
          }
          this.emit('dispatching', chatId, entry.id, entry.content);
          stage = 'running';
          attempt.markLaunching();
          const abortableWaitController = new AbortController();
          const abortable = this.#turnRunner.waitUntilTurnAbortable(
            chatId,
            turn,
            abortableWaitController.signal,
          ).then(
            (isAbortable) => {
              if (isAbortable) attempt?.markAbortable();
              return isAbortable;
            },
            () => false,
          );
          try {
            const run = this.#turnRunner.runAgentTurn(chatId, entry.content, queuedTurnOptions);
            void Promise.race([
              abortable,
              run.then(() => false, () => false),
            ]).finally(() => abortableWaitController.abort());
            await run;
          } finally {
            abortableWaitController.abort();
            if (attempt) {
              attempt.markRunSettled();
              if (!this.#turnRunner.isChatRunning(chatId)) attempt.markTerminalObserved();
              this.#settleExecutionAttempt(chatId, attempt);
            }
          }
          if (this.#shutdownDrainAborts.get(chatId) === entry.id) {
            if (executionStarted) {
              await this.requeueAndPauseChat(chatId, entry.id, 'completion-uncertain');
            } else {
              if (queuedTurnOptions.clientRequestId) {
                this.#pendingInputs.discard(chatId, queuedTurnOptions.clientRequestId);
              }
              await this.#returnUnsentEntry(chatId, entry.id);
            }
            finalization.settle('not-committed');
            break;
          }
          stage = 'finalizing';
          await this.removeSentChat(chatId, entry.id);
          finalization.settle('committed');
        } catch (error: unknown) {
          if (this.#shutdownDrainAborts.get(chatId) === entry.id) {
            attempt?.clearExpectedAbort();
            try {
              if (executionStarted) {
                await this.requeueAndPauseChat(chatId, entry.id, 'completion-uncertain');
              } else {
                if (queuedTurnOptions.clientRequestId) {
                  this.#pendingInputs.discard(chatId, queuedTurnOptions.clientRequestId);
                }
                await this.#returnUnsentEntry(chatId, entry.id);
              }
            } catch (compensationError: unknown) {
              logger.error('queue: failed to preserve shutdown-aborted entry:', {
                chatId,
                entryId: entry.id,
                message: compensationError instanceof Error
                  ? compensationError.message
                  : String(compensationError),
              });
            }
            finalization?.settle('not-committed');
            break;
          }
          if (stage === 'running' && attempt?.isExpectedAbort === true) {
            attempt.clearExpectedAbort();
            try {
              await this.removeSentChat(chatId, entry.id);
              finalization?.settle('committed');
              await this.#waitForSessionStop(chatId);
              continue;
            } catch (finalizeError: unknown) {
              logger.error('queue: aborted entry finalization failed:', {
                chatId,
                entryId: entry.id,
                message: finalizeError instanceof Error
                  ? finalizeError.message
                  : String(finalizeError),
            });
              try {
                await this.requeueAndPauseChat(chatId, entry.id, 'completion-uncertain');
              } catch (compensationError: unknown) {
                logger.error('queue: failed to record aborted-entry pause:', {
                  chatId,
                  entryId: entry.id,
                  message: compensationError instanceof Error
                    ? compensationError.message
                    : String(compensationError),
                });
              }
              break;
            }
          }
          const message = error instanceof Error ? error.message : String(error);
          const kind: AutomaticQueuePauseKind = stage === 'finalizing'
            ? 'completion-uncertain'
            : 'queued-turn-failed';
          if (kind === 'queued-turn-failed') {
            logger.error('queue: queued turn failed:', { chatId, entryId: entry.id, stage, message });
          } else {
            logger.error('queue: sent-entry finalization failed:', { chatId, entryId: entry.id, stage });
          }
          let compensated = false;
          try {
            await this.requeueAndPauseChat(chatId, entry.id, kind);
            compensated = true;
          } catch (compensationError: unknown) {
            logger.error('queue: failed to record automatic pause:', {
              chatId,
              entryId: entry.id,
              stage,
              message: compensationError instanceof Error
                ? compensationError.message
                : String(compensationError),
              });
          }
          finalization?.settle('not-committed');
          if (kind === 'queued-turn-failed' && compensated) {
            this.emit('turn-failed', chatId, message, queuedTurnOptions);
          }
          break;
        } finally {
          finalization?.settle('not-committed');
          if (attempt && !attempt.isRunSettled) {
            attempt.markRunSettled();
            if (!this.#turnRunner.isChatRunning(chatId)) attempt.markTerminalObserved();
            this.#settleExecutionAttempt(chatId, attempt);
          }
        }
      }
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
    await this.#withLock(`chat:${chatId}`, async () => {
      const current = await this.#loadChatExecutionControl(chatId);
      const entry = current.entries.find((candidate) => candidate.id === entryId);
      const committed = await this.#commitTransition(
        chatId,
        current,
        returnUnsentQueueEntry(current, entryId, transitionContext()),
      );
      if (committed.changed) {
        this.#logMutation('requeue', chatId, entryId, committed.control, entry?.revision);
      }
    });
  }

  async #restorePoppedEntryAfterStop(chatId: string, entryId: string): Promise<void> {
    await this.#withLock(`chat:${chatId}`, async () => {
      const current = await this.#loadChatExecutionControl(chatId);
      const entry = current.entries.find((candidate) => candidate.id === entryId);
      const committed = await this.#commitTransition(
        chatId,
        current,
        restoreStoppedQueueEntry(current, entryId, transitionContext()),
      );
      if (committed.changed) {
        this.#logMutation('requeue', chatId, entryId, committed.control, entry?.revision);
        this.#logPauseMutation('pause', chatId, committed.control, entryId);
      }
    });
  }

  async deleteChatQueueFile(chatId: string): Promise<void> {
    await this.#withLock(`chat:${chatId}`, async () => {
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
      await this.#controls.delete(chatId);
    });
  }

  async recoverChatExecutionControls(
    chatsWithRecoveredInput: ReadonlySet<string> = new Set(),
  ): Promise<void> {
    this.#recoveryFailure = undefined;
    let storedChatIds: readonly string[];
    try {
      storedChatIds = await this.#controls.listStoredChatIds();
    } catch (error: unknown) {
      this.#recoveryFailure = error;
      throw error;
    }

    const queuesToDrain = new Set<string>();
    const queueFileChatIds = new Set(storedChatIds);
    for (const chatId of storedChatIds) {
      try {
        if (!this.#chatExists(chatId)) {
          await this.#controls.delete(chatId);
          logger.warn('queue: removed state for a deleted chat', { chatId });
          continue;
        }
        const snapshot = await this.#controls.loadFresh(chatId);
        const data = snapshot.control;
        let modified = snapshot.needsCanonicalization;
        const recoveredIds = new Set<string>();
        for (const entry of data.entries) {
          if (entry.status === 'sending') {
            entry.status = 'queued';
            recoveredIds.add(entry.id);
            modified = true;
          }
        }
        if (recoveredIds.size > 0) {
          data.recentlyDispatched = data.recentlyDispatched.filter((entry) => !recoveredIds.has(entry.entryId));
          installRecoveryPause(data, {
            id: crypto.randomUUID(),
            kind: 'recovered-inflight',
            entryId: data.entries.find((entry) => recoveredIds.has(entry.id))!.id,
            pausedAt: new Date().toISOString(),
          });
        }
        const shouldInstallContinuation = chatsWithRecoveredInput.has(chatId);
        if (shouldInstallContinuation) {
          data.recoveredInputContinuation = {
            id: crypto.randomUUID(),
            installedAt: new Date().toISOString(),
          };
          modified = true;
        } else if (data.recoveredInputContinuation) {
          data.recoveredInputContinuation = null;
          modified = true;
        }
        if (modified) {
          const normalized = normalizeStoredChatExecutionControlState(
            bumpStoredChatExecutionControl(data),
          );
          await this.#controls.save(chatId, normalized);
          if (shouldInstallContinuation) {
            this.#logRecoveredInputContinuation('startup-install', chatId, normalized);
          }
          if (recoveredIds.size > 0) {
            logger.info('queue: recovered stale chat queue', { chatId, recoveredCount: recoveredIds.size });
            this.#logPauseMutation(
              'recover',
              chatId,
              normalized,
              normalized.pause && 'entryId' in normalized.pause ? normalized.pause.entryId : undefined,
            );
          }
          if (
            !normalized.pause
            && !normalized.recoveredInputContinuation
            && normalized.entries.some((entry) => entry.status === 'queued')
          ) {
            queuesToDrain.add(chatId);
          }
        } else {
          if (
            !data.pause
            && !data.recoveredInputContinuation
            && data.entries.some((entry) => entry.status === 'queued')
          ) {
            queuesToDrain.add(chatId);
          }
        }
      } catch (error: unknown) {
        logger.warn(`queue: could not recover chat queue ${chatId}.queue.json:`, (error as Error).message);
        const recoveryError = new Error(
          `Could not recover chat queue ${chatId}: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
        this.#recoveryFailure = recoveryError;
        throw recoveryError;
      }
    }

    for (const chatId of chatsWithRecoveredInput) {
      if (queueFileChatIds.has(chatId) || !this.#chatExists(chatId)) continue;
      try {
        const control = bumpStoredChatExecutionControl(emptyStoredChatExecutionControl());
        control.recoveredInputContinuation = {
          id: crypto.randomUUID(),
          installedAt: new Date().toISOString(),
        };
        const normalized = normalizeStoredChatExecutionControlState(control);
        const committed = await this.#controls.save(chatId, normalized);
        this.#logRecoveredInputContinuation('startup-install', chatId, committed);
      } catch (error: unknown) {
        const recoveryError = new Error(
          `Could not persist recovered-input continuation for ${chatId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
          { cause: error },
        );
        this.#recoveryFailure = recoveryError;
        throw recoveryError;
      }
    }

    for (const chatId of queuesToDrain) {
      void this.triggerDrain(chatId).catch((error: Error) => {
        logger.warn(`queue: could not resume recovered chat queue ${chatId}:`, error.message);
      });
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
