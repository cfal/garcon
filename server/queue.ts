// Manages per-chat message queues and orchestrates turn execution.
// Extends EventEmitter to notify listeners of queue state changes,
// dispatching events, stop requests, and session stops.

import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { EventEmitter } from 'events';
import type { AutomaticQueuePauseKind, QueueEntry, QueuePause } from '../common/queue-state.ts';
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
import { writeJsonFileAtomic } from './lib/json-file-store.js';
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
  MAX_RECENTLY_DISPATCHED_QUEUE_ENTRIES,
  MAX_STORED_APPLIED_QUEUE_COMMANDS,
  bumpStoredQueue,
  cloneStoredQueue,
  emptyStoredQueue,
  normalizeStoredQueueState,
  parseStoredQueueState,
  storedQueueNeedsCanonicalization,
  type StoredAppliedQueueCommand,
  type StoredQueueEntry,
  type StoredQueueState,
} from './queue-state.ts';

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
  readonly queue: StoredQueueState;

  constructor(
    code: 'QUEUE_ENTRY_NOT_FOUND' | 'QUEUE_ENTRY_ALREADY_SENT' | 'QUEUE_ENTRY_REVISION_CONFLICT',
    message: string,
    queue: StoredQueueState,
  ) {
    super(code, message, code === 'QUEUE_ENTRY_NOT_FOUND' ? 404 : 409);
    this.name = 'QueueEntryMutationError';
    this.queue = cloneStoredQueue(queue);
  }
}

export class QueuePauseChangedError extends DomainError {
  readonly queue: StoredQueueState;

  constructor(queue: StoredQueueState) {
    super('QUEUE_PAUSE_CHANGED', 'The queue pause changed before it could be resumed', 409);
    this.name = 'QueuePauseChangedError';
    this.queue = cloneStoredQueue(queue);
  }
}

function queueEntry(entry: StoredQueueEntry): QueueEntry {
  const { status: _status, delivery: _delivery, ...clientEntry } = entry;
  return { ...clientEntry };
}

function installRecoveryPause(queue: StoredQueueState, pause: QueuePause): boolean {
  if (queue.pause?.kind === pause.kind) return false;
  if (queue.pause) {
    queue.resumePauses = [queue.pause, ...(queue.resumePauses ?? [])];
  }
  queue.pause = pause;
  return true;
}

function missingQueueEntryError(queue: StoredQueueState, entryId: string): QueueEntryMutationError {
  const wasDispatched = queue.recentlyDispatched.some((entry) => entry.entryId === entryId);
  return wasDispatched
    ? new QueueEntryMutationError('QUEUE_ENTRY_ALREADY_SENT', 'This queued message has already been sent', queue)
    : new QueueEntryMutationError('QUEUE_ENTRY_NOT_FOUND', 'This queued message is no longer available', queue);
}

export interface QueueCommandIdentity {
  key: string;
  entryId: string;
}

interface QueueCommandMutationResult {
  entryId: string;
  queue: StoredQueueState;
  duplicate: boolean;
}

export interface StopActiveTurnResult {
  stopped: boolean;
  queue: StoredQueueState;
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

function appliedQueueCommand(queue: StoredQueueState, command: QueueCommandIdentity): StoredAppliedQueueCommand | null {
  return queue.appliedCommands.find((candidate) => candidate.key === command.key) ?? null;
}

function recordAppliedQueueCommand(
  queue: StoredQueueState,
  command: QueueCommandIdentity,
  operation: StoredAppliedQueueCommand['operation'],
): void {
  queue.appliedCommands = [
    ...queue.appliedCommands.filter((candidate) => candidate.key !== command.key),
    {
      key: command.key,
      operation,
      entryId: command.entryId,
      appliedAt: new Date().toISOString(),
    },
  ].slice(-MAX_STORED_APPLIED_QUEUE_COMMANDS);
}

export function queueDrainOptions(chatId: string, registry: IChatRegistry): RunAgentTurnOptions {
  const chat = registry.getChat(chatId);
  const entry = requireChatExecutionConfig(chatId, chat);
  return {
    permissionMode: entry.permissionMode,
    thinkingMode: entry.thinkingMode,
    claudeThinkingMode: entry.claudeThinkingMode,
    ampAgentMode: entry.ampAgentMode,
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
}

interface ChatMessagesDep {
  appendMessages(
    chatId: string,
    messages: ChatMessage[],
  ): Promise<{ generationId: string; messages: ChatViewMessage[] }>;
}

type QueueUpdatedCallback = (chatId: string, queue: StoredQueueState) => void;
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
  discardPendingUserInput(chatId: string, clientRequestId: string): boolean;
  reserveDirectTurn(chatId: string, turn?: TurnIdentity): DirectTurnReservation;
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
  triggerDrain(chatId: string): Promise<void>;
  readChatQueue(chatId: string): Promise<StoredQueueState>;
  createChatQueueEntry(
    chatId: string,
    content: string,
    command?: QueueCommandIdentity,
  ): Promise<QueueCommandMutationResult & { entry: QueueEntry | null }>;
  replaceChatQueueEntry(
    chatId: string,
    entryId: string,
    content: string,
    expectedRevision: number,
    command?: QueueCommandIdentity,
  ): Promise<QueueCommandMutationResult & { entry: QueueEntry | null }>;
  deleteChatQueueEntry(
    chatId: string,
    entryId: string,
    command?: QueueCommandIdentity,
  ): Promise<QueueCommandMutationResult>;
  deliverActiveInput(
    chatId: string,
    content: string,
    options?: RunAgentTurnOptions,
    afterPendingRegistered?: () => Promise<void>,
  ): Promise<boolean>;
  clearChatQueue(chatId: string): Promise<StoredQueueState>;
  pauseChatQueue(chatId: string): Promise<StoredQueueState>;
  resumeChatQueue(chatId: string, pauseId: string): Promise<StoredQueueState>;
  requeueAndPauseChat(
    chatId: string,
    entryId: string,
    kind: AutomaticQueuePauseKind,
  ): Promise<StoredQueueState>;
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
  #queuesByChatId = new Map<string, StoredQueueState>();
  #recoveryFailure: unknown = undefined;
  #workspaceDir: string;
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
    this.#workspaceDir = workspaceDir;
    this.#turnRunner = turnRunner;
    this.#pendingInputs = pendingInputs;
    this.#chatMessages = chatMessages;
    this.#getDrainOptions = getDrainOptions;
    this.#chatExists = chatExists;
  }

  onQueueUpdated(cb: QueueUpdatedCallback): void {
    this.on('queue-updated', cb);
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
    queue: StoredQueueState,
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
    queue: StoredQueueState,
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
    const queue = await this.readChatQueue(chatId);
    if (this.#isDrainSuppressed(chatId)) {
      const hasPending = queue.entries.some((e) => e.status === 'queued' || e.status === 'sending');
      if (!hasPending) {
        this.#pendingDrainRequests.delete(chatId);
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
      this.#pendingDrainRequests.delete(chatId);
      this.emit('chat-idle', chatId);
    }
  }

  #chatQueueFilePath(chatId: string): string {
    return path.join(this.#workspaceDir, 'queues', `${chatId}.queue.json`);
  }

  async #withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    return this.#locks.runExclusive(key, fn);
  }

  async #readChatQueueFromDisk(chatId: string): Promise<StoredQueueState> {
    try {
      const data = await fs.readFile(this.#chatQueueFilePath(chatId), 'utf8');
      return parseStoredQueueState(JSON.parse(data));
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyStoredQueue();
      throw error;
    }
  }

  async #loadChatQueue(chatId: string): Promise<StoredQueueState> {
    this.#assertRecoveryReady();
    const cached = this.#queuesByChatId.get(chatId);
    if (cached) return cached;
    const loaded = await this.#readChatQueueFromDisk(chatId);
    this.#queuesByChatId.set(chatId, loaded);
    return loaded;
  }

  async #commitChatQueue(chatId: string, queue: unknown): Promise<StoredQueueState> {
    if (!this.#chatExists(chatId)) {
      throw new DomainError('SESSION_NOT_FOUND', 'Chat queue owner no longer exists', 404);
    }
    const filePath = this.#chatQueueFilePath(chatId);
    const normalized = normalizeStoredQueueState(queue);
    await writeJsonFileAtomic(filePath, normalized);
    this.#queuesByChatId.set(chatId, normalized);
    return cloneStoredQueue(normalized);
  }

  async #commitAndPublish(chatId: string, queue: StoredQueueState): Promise<StoredQueueState> {
    const result = await this.#commitChatQueue(chatId, queue);
    this.emit('queue-updated', chatId, result);
    return result;
  }

  async readChatQueue(chatId: string): Promise<StoredQueueState> {
    return this.#withLock(`chat:${chatId}`, async () => cloneStoredQueue(await this.#loadChatQueue(chatId)));
  }

  async createChatQueueEntry(
    chatId: string,
    content: string,
    command?: QueueCommandIdentity,
  ): Promise<QueueCommandMutationResult & { entry: QueueEntry | null }> {
    return this.#withLock(`chat:${chatId}`, async () => {
      const queue = cloneStoredQueue(await this.#loadChatQueue(chatId));
      if (command) {
        const applied = appliedQueueCommand(queue, command);
        if (applied) {
          const current = queue.entries.find((entry) => entry.id === applied.entryId);
          return {
            entry: current ? queueEntry(current) : null,
            entryId: applied.entryId,
            queue,
            duplicate: true,
          };
        }
      }
      const now = new Date().toISOString();
      const entry: StoredQueueEntry = {
        id: command?.entryId ?? crypto.randomUUID(),
        content,
        revision: 1,
        status: 'queued',
        createdAt: now,
        updatedAt: now,
      };
      queue.entries.push(entry);
      if (command) recordAppliedQueueCommand(queue, command, 'create');
      const result = await this.#commitAndPublish(chatId, bumpStoredQueue(queue));
      this.#logMutation('create', chatId, entry.id, result, entry.revision);
      return {
        entry: queueEntry(entry),
        entryId: entry.id,
        queue: result,
        duplicate: false,
      };
    });
  }

  async replaceChatQueueEntry(
    chatId: string,
    entryId: string,
    content: string,
    expectedRevision: number,
    command?: QueueCommandIdentity,
  ): Promise<QueueCommandMutationResult & { entry: QueueEntry | null }> {
    return this.#withLock(`chat:${chatId}`, async () => {
      const queue = cloneStoredQueue(await this.#loadChatQueue(chatId));
      if (command) {
        const applied = appliedQueueCommand(queue, command);
        if (applied) {
          const current = queue.entries.find((candidate) => candidate.id === applied.entryId);
          return {
            entry: current ? queueEntry(current) : null,
            entryId: applied.entryId,
            queue,
            duplicate: true,
          };
        }
      }
      const entry = queue.entries.find((candidate) => candidate.id === entryId);
      if (!entry) {
        const error = missingQueueEntryError(queue, entryId);
        this.#logMutation('replace', chatId, entryId, queue, undefined, error.code);
        throw error;
      }
      if (entry.status !== 'queued') {
        const error = new QueueEntryMutationError(
          'QUEUE_ENTRY_ALREADY_SENT',
          'This queued message has already been sent',
          queue,
        );
        this.#logMutation('replace', chatId, entryId, queue, entry.revision, error.code);
        throw error;
      }
      if (entry.revision !== expectedRevision) {
        const error = new QueueEntryMutationError(
          'QUEUE_ENTRY_REVISION_CONFLICT',
          'This queued message changed before it could be saved',
          queue,
        );
        this.#logMutation('replace', chatId, entryId, queue, entry.revision, error.code);
        throw error;
      }

      entry.content = content;
      entry.revision += 1;
      entry.updatedAt = new Date().toISOString();
      delete entry.delivery;
      if (command) recordAppliedQueueCommand(queue, command, 'replace');
      const result = await this.#commitAndPublish(chatId, bumpStoredQueue(queue));
      const updated = result.entries.find((candidate) => candidate.id === entryId)!;
      this.#logMutation('replace', chatId, entryId, result, updated.revision);
      return {
        entry: queueEntry(updated),
        entryId,
        queue: result,
        duplicate: false,
      };
    });
  }

  async deleteChatQueueEntry(
    chatId: string,
    entryId: string,
    command?: QueueCommandIdentity,
  ): Promise<QueueCommandMutationResult> {
    return this.#withLock(`chat:${chatId}`, async () => {
      const queue = cloneStoredQueue(await this.#loadChatQueue(chatId));
      if (command) {
        const applied = appliedQueueCommand(queue, command);
        if (applied) {
          return { entryId: applied.entryId, queue, duplicate: true };
        }
      }
      const index = queue.entries.findIndex((entry) => entry.id === entryId);
      if (index < 0) {
        const error = missingQueueEntryError(queue, entryId);
        this.#logMutation('delete', chatId, entryId, queue, undefined, error.code);
        throw error;
      }
      if (queue.entries[index].status !== 'queued') {
        const error = new QueueEntryMutationError(
          'QUEUE_ENTRY_ALREADY_SENT',
          'This queued message has already been sent',
          queue,
        );
        this.#logMutation('delete', chatId, entryId, queue, queue.entries[index].revision, error.code);
        throw error;
      }

      queue.entries.splice(index, 1);
      if (
        !queue.entries.some((entry) => entry.status === 'queued')
        && queue.pause?.kind !== 'recovered-unconfirmed-input'
      ) {
        queue.pause = null;
        delete queue.resumePauses;
      } else if (!queue.entries.some((entry) => entry.status === 'queued')) {
        delete queue.resumePauses;
      }
      if (command) recordAppliedQueueCommand(queue, command, 'delete');
      const result = await this.#commitAndPublish(chatId, bumpStoredQueue(queue));
      this.#logMutation('delete', chatId, entryId, result);
      return { entryId, queue: result, duplicate: false };
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
    const currentQueue = supportsActiveInput ? await this.readChatQueue(chatId) : null;
    if (
      !supportsActiveInput
      || currentQueue?.entries.length !== 0
      || currentQueue.pause !== null
    ) return false;

    const activeOptions = ensureTurnIdentifiers({
      ...this.#getDrainOptions(chatId),
      ...options,
    });
    let accepted = false;
    try {
      const handled = await this.#turnRunner.submitActiveInput!(chatId, content, activeOptions, async () => {
        await this.registerPendingUserInput(chatId, content, activeOptions);
        accepted = true;
        await afterPendingRegistered?.();
      });
      if (!handled && accepted) {
        throw new Error('Agent accepted active input without handling it');
      }
      return handled;
    } catch (error) {
      if (accepted) this.#pendingInputs.markFailed(chatId, activeOptions.clientRequestId!);
      throw new ActiveInputDeliveryError(error, accepted);
    }
  }

  async clearChatQueue(chatId: string): Promise<StoredQueueState> {
    return this.#withLock(`chat:${chatId}`, async () => {
      const queue = cloneStoredQueue(await this.#loadChatQueue(chatId));
      this.#removeDrainSuppression(chatId, 'abort');
      this.#pendingDrainRequests.delete(chatId);
      queue.entries = queue.entries.filter((entry) => entry.status === 'sending');
      queue.pause = null;
      delete queue.resumePauses;
      return this.#commitAndPublish(chatId, bumpStoredQueue(queue));
    });
  }

  async pauseChatQueue(chatId: string): Promise<StoredQueueState> {
    return this.#withLock(`chat:${chatId}`, async () => {
      const queue = cloneStoredQueue(await this.#loadChatQueue(chatId));
      const hasQueuedEntries = queue.entries.some((entry) => entry.status === 'queued');
      if (!hasQueuedEntries || queue.pause) return queue;
      queue.pause = {
        id: crypto.randomUUID(),
        kind: 'manual',
        pausedAt: new Date().toISOString(),
      };
      const result = await this.#commitAndPublish(chatId, bumpStoredQueue(queue));
      this.#logPauseMutation('pause', chatId, result);
      return result;
    });
  }

  async resumeChatQueue(chatId: string, pauseId: string): Promise<StoredQueueState> {
    return this.#withLock(`chat:${chatId}`, async () => {
      const queue = cloneStoredQueue(await this.#loadChatQueue(chatId));
      if (!queue.pause) return queue;
      if (queue.pause.id !== pauseId) throw new QueuePauseChangedError(queue);
      const [resumePause, ...remainingPauses] = queue.resumePauses ?? [];
      queue.pause = resumePause ?? null;
      if (remainingPauses.length > 0) queue.resumePauses = remainingPauses;
      else delete queue.resumePauses;
      this.#removeDrainSuppression(chatId, 'abort');
      const result = await this.#commitAndPublish(chatId, bumpStoredQueue(queue));
      this.#logPauseMutation('resume', chatId, result);
      return result;
    });
  }

  async popNextChat(chatId: string): Promise<{ entry: StoredQueueEntry; queue: StoredQueueState } | null> {
    return this.#withLock(`chat:${chatId}`, async () => {
      const queue = cloneStoredQueue(await this.#loadChatQueue(chatId));
      if (queue.pause) return null;
      if (queue.entries.some((entry) => entry.status === 'sending')) return null;
      const next = queue.entries.find((e) => e.status === 'queued');
      if (!next) return null;
      next.status = 'sending';
      next.delivery ??= {
        clientRequestId: crypto.randomUUID(),
        clientMessageId: crypto.randomUUID(),
        turnId: crypto.randomUUID(),
      };
      queue.recentlyDispatched = [
        ...queue.recentlyDispatched.filter((entry) => entry.entryId !== next.id),
        { entryId: next.id, dispatchedAt: new Date().toISOString() },
      ].slice(-MAX_RECENTLY_DISPATCHED_QUEUE_ENTRIES);
      const result = await this.#commitAndPublish(chatId, bumpStoredQueue(queue));
      const sentEntry = result.entries.find((entry) => entry.id === next.id)!;
      this.#logMutation('pop', chatId, sentEntry.id, result, sentEntry.revision);
      return { entry: sentEntry, queue: result };
    });
  }

  async removeSentChat(chatId: string, entryId: string): Promise<StoredQueueState> {
    return this.#withLock(`chat:${chatId}`, async () => {
      const queue = cloneStoredQueue(await this.#loadChatQueue(chatId));
      queue.entries = queue.entries.filter((e) => e.id !== entryId);
      const result = await this.#commitAndPublish(chatId, bumpStoredQueue(queue));
      this.#logMutation('sent', chatId, entryId, result);
      return result;
    });
  }

  async requeueAndPauseChat(
    chatId: string,
    entryId: string,
    kind: AutomaticQueuePauseKind,
  ): Promise<StoredQueueState> {
    return this.#withLock(`chat:${chatId}`, async () => {
      const queue = cloneStoredQueue(await this.#loadChatQueue(chatId));
      const entry = queue.entries.find((e) => e.id === entryId);
      if (entry) {
        entry.status = 'queued';
        queue.recentlyDispatched = queue.recentlyDispatched.filter(
          (dispatched) => dispatched.entryId !== entryId,
        );
      }
      queue.pause = queue.entries.some((candidate) => candidate.status === 'queued')
        ? {
            id: crypto.randomUUID(),
            kind,
            entryId,
            pausedAt: new Date().toISOString(),
          }
        : null;
      const result = await this.#commitAndPublish(chatId, bumpStoredQueue(queue));
      if (entry) this.#logMutation('requeue', chatId, entryId, result, entry.revision);
      this.#logPauseMutation('pause', chatId, result, entryId);
      return result;
    });
  }

  // Submits a command to a chat session. Appends the user message to
  // history, runs the agent turn, then drains any queued entries.
  async submit(chatId: string, command: string, options: RunAgentTurnOptions): Promise<void> {
    const turnOptions = ensureTurnIdentifiers(options);
    const reservation = this.reserveDirectTurn(chatId, turnOptions);
    try {
      reservation.executionAdmission.signal.throwIfAborted();
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

  discardPendingUserInput(chatId: string, clientRequestId: string): boolean {
    return this.#pendingInputs.discard(chatId, clientRequestId);
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
    this.#assertDirectTurnReservation(reservation);
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

  #assertDirectTurnReservation(reservation: DirectTurnReservation): void {
    if (this.#directTurns.get(reservation.chatId) !== reservation.reservationId) {
      throw new Error('Direct turn reservation is no longer active');
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
    this.#directTurnAdmissionControllers.delete(reservation.chatId);
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
    const inFlight = this.#sessionStopByChatId.get(chatId);
    if (inFlight) return inFlight.promise;

    const stopId = crypto.randomUUID();
    let resolveStop!: (success: boolean) => void;
    let rejectStop!: (error: unknown) => void;
    const stop = new Promise<boolean>((resolve, reject) => {
      resolveStop = resolve;
      rejectStop = reject;
    });
    const operation = { intent, stopId, promise: stop };
    this.#sessionStopByChatId.set(chatId, operation);
    this.#performAbortSession(chatId, intent, stopId).then(resolveStop, rejectStop);
    try {
      return await stop;
    } finally {
      if (this.#sessionStopByChatId.get(chatId) === operation) {
        this.#sessionStopByChatId.delete(chatId);
      }
    }
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
    try {
      await this.pauseChatQueue(chatId);
    } catch (error) {
      this.#removeDrainSuppression(chatId, 'abort');
      this.#removeDrainSuppression(chatId, 'manual-stop');
      throw error;
    }

    let stopped: boolean;
    try {
      stopped = await this.#abortSession(chatId, 'stop');
    } finally {
      // A durable pause now owns queued-work blocking. Clearing this temporary
      // gate also lets a later fresh queue entry run when Stop found no queue.
      this.#removeDrainSuppression(chatId, 'abort');
      if (!drainWasActive || !this.#draining.has(chatId)) {
        this.#removeDrainSuppression(chatId, 'manual-stop');
      }
    }
    return { stopped, queue: await this.readChatQueue(chatId) };
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
          const queue = await this.readChatQueue(chatId);
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
      const queue = cloneStoredQueue(await this.#loadChatQueue(chatId));
      const entry = queue.entries.find((candidate) => candidate.id === entryId);
      if (!entry || entry.status !== 'sending') return;
      entry.status = 'queued';
      queue.recentlyDispatched = queue.recentlyDispatched.filter(
        (candidate) => candidate.entryId !== entryId,
      );
      const result = await this.#commitAndPublish(chatId, bumpStoredQueue(queue));
      this.#logMutation('requeue', chatId, entryId, result, entry.revision);
    });
  }

  async #restorePoppedEntryAfterStop(chatId: string, entryId: string): Promise<void> {
    await this.#withLock(`chat:${chatId}`, async () => {
      const queue = cloneStoredQueue(await this.#loadChatQueue(chatId));
      const entry = queue.entries.find((candidate) => candidate.id === entryId);
      if (!entry || entry.status !== 'sending') return;

      entry.status = 'queued';
      queue.recentlyDispatched = queue.recentlyDispatched.filter(
        (dispatched) => dispatched.entryId !== entryId,
      );
      if (!queue.pause) {
        queue.pause = {
          id: crypto.randomUUID(),
          kind: 'manual',
          pausedAt: new Date().toISOString(),
        };
      }
      const result = await this.#commitAndPublish(chatId, bumpStoredQueue(queue));
      this.#logMutation('requeue', chatId, entryId, result, entry.revision);
      this.#logPauseMutation('pause', chatId, result, entryId);
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
      this.#queuesByChatId.delete(chatId);
      try {
        await fs.unlink(this.#chatQueueFilePath(chatId));
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    });
  }

  async recoverStaleChatQueues(
    chatsWithUnconfirmedRecoveredInput: ReadonlySet<string> = new Set(),
  ): Promise<void> {
    this.#recoveryFailure = undefined;
    const queuesDir = path.join(this.#workspaceDir, 'queues');
    let files: string[];
    try {
      files = await fs.readdir(queuesDir);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') files = [];
      else {
        this.#recoveryFailure = error;
        throw error;
      }
    }

    const queueFiles = files.filter((f) => f.endsWith('.queue.json'));
    const queuesToDrain = new Set<string>();
    const queueFileChatIds = new Set<string>();
    for (const qf of queueFiles) {
      const filePath = path.join(queuesDir, qf);
      const chatId = qf.slice(0, -'.queue.json'.length);
      queueFileChatIds.add(chatId);
      try {
        if (!this.#chatExists(chatId)) {
          await fs.unlink(filePath);
          this.#queuesByChatId.delete(chatId);
          logger.warn('queue: removed state for a deleted chat', { chatId });
          continue;
        }
        const raw = JSON.parse(await fs.readFile(filePath, 'utf8'));
        const data = parseStoredQueueState(raw);
        let modified = storedQueueNeedsCanonicalization(raw, data);
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
        if (chatsWithUnconfirmedRecoveredInput.has(chatId)) {
          const installed = installRecoveryPause(data, {
            id: crypto.randomUUID(),
            kind: 'recovered-unconfirmed-input',
            pausedAt: new Date().toISOString(),
          });
          modified ||= installed;
        }
        if (modified) {
          const normalized = normalizeStoredQueueState(bumpStoredQueue(data));
          // Recovery pauses gate admission even when the durable repair cannot
          // be written. The owning recovery source reconstructs them on restart.
          if (normalized.pause) this.#queuesByChatId.set(chatId, normalized);
          await writeJsonFileAtomic(filePath, normalized);
          this.#queuesByChatId.set(chatId, normalized);
          if (recoveredIds.size > 0) {
            logger.info('queue: recovered stale chat queue', { chatId, recoveredCount: recoveredIds.size });
            this.#logPauseMutation(
              'recover',
              chatId,
              normalized,
              normalized.pause && 'entryId' in normalized.pause ? normalized.pause.entryId : undefined,
            );
          }
          if (!normalized.pause && normalized.entries.some((entry) => entry.status === 'queued')) {
            queuesToDrain.add(chatId);
          }
        } else {
          this.#queuesByChatId.set(chatId, data);
          if (!data.pause && data.entries.some((entry) => entry.status === 'queued')) {
            queuesToDrain.add(chatId);
          }
        }
      } catch (error: unknown) {
        logger.warn(`queue: could not recover chat queue ${qf}:`, (error as Error).message);
        const recoveryError = new Error(
          `Could not recover chat queue ${chatId}: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
        this.#recoveryFailure = recoveryError;
        throw recoveryError;
      }
    }

    for (const chatId of chatsWithUnconfirmedRecoveredInput) {
      if (queueFileChatIds.has(chatId) || !this.#chatExists(chatId)) continue;
      try {
        const queue = this.#cacheEmptyRecoveredInputPause(chatId);
        await writeJsonFileAtomic(this.#chatQueueFilePath(chatId), queue);
      } catch (error: unknown) {
        logger.warn(
          `queue: could not persist recovered-input pause for ${chatId}:`,
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    for (const chatId of queuesToDrain) {
      void this.triggerDrain(chatId).catch((error: Error) => {
        logger.warn(`queue: could not resume recovered chat queue ${chatId}:`, error.message);
      });
    }
  }

  #cacheEmptyRecoveredInputPause(chatId: string): StoredQueueState {
    const queue = emptyStoredQueue();
    queue.pause = {
      id: crypto.randomUUID(),
      kind: 'recovered-unconfirmed-input',
      pausedAt: new Date().toISOString(),
    };
    const normalized = normalizeStoredQueueState(bumpStoredQueue(queue));
    this.#queuesByChatId.set(chatId, normalized);
    return normalized;
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
