// Manages per-chat message queues and orchestrates turn execution.
// Extends EventEmitter to notify listeners of queue state changes,
// dispatching events, stop requests, and session stops.

import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { EventEmitter } from 'events';
import type { AutomaticQueuePauseKind, QueueEntry } from '../common/queue-state.ts';
import { UserMessage, type ChatImage, type ChatMessage, type UserMessageDeliveryStatus } from '../common/chat-types.ts';
import type { ChatViewMessage } from '../common/chat-view.ts';
import { requireChatExecutionConfig, type RunAgentTurnOptions } from './agents/session-types.js';
import type { IChatRegistry } from './chats/store.js';
import { writeJsonFileAtomic } from './lib/json-file-store.js';
import { KeyedPromiseLock } from './lib/keyed-lock.js';
import { createLogger } from './lib/log.js';
import { ActiveInputDeliveryError, DomainError } from './lib/domain-error.js';
import {
  MAX_RECENTLY_DISPATCHED_QUEUE_ENTRIES,
  MAX_STORED_APPLIED_QUEUE_COMMANDS,
  bumpStoredQueue,
  cloneStoredQueue,
  emptyStoredQueue,
  normalizeStoredQueueState,
  storedQueueNeedsCanonicalization,
  type StoredAppliedQueueCommand,
  type StoredQueueEntry,
  type StoredQueueState,
} from './queue-state.ts';

const logger = createLogger('queue');

function optionsForQueuedTurn(options: RunAgentTurnOptions): RunAgentTurnOptions {
  return {
    ...options,
    clientRequestId: crypto.randomUUID(),
    clientMessageId: crypto.randomUUID(),
    turnId: crypto.randomUUID(),
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
  const { status: _status, ...clientEntry } = entry;
  return { ...clientEntry };
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
type SessionStopRequestedCallback = (chatId: string) => void;
type SessionStoppedCallback = (chatId: string, success: boolean) => void;
type ChatIdleCallback = (chatId: string) => void;
type TurnFailedCallback = (chatId: string, errorMessage: string, options: RunAgentTurnOptions) => void;
type ChatMessagesCallback = (
  chatId: string,
  generationId: string,
  messages: ChatViewMessage[],
  metadata?: { clientRequestId?: string; turnId?: string },
) => void;
type QueueDrainOptionsResolver = (chatId: string) => RunAgentTurnOptions;
type ChatExistsResolver = (chatId: string) => boolean;

export interface ChatQueueService {
  deleteChatQueueFile(chatId: string): Promise<void>;
  submit(chatId: string, command: string, options: RunAgentTurnOptions): Promise<void>;
  registerPendingUserInput(
    chatId: string,
    command: string,
    options: PendingUserInputRegistrationOptions,
  ): Promise<void>;
  discardPendingUserInput(chatId: string, clientRequestId: string): boolean;
  reserveDirectTurn(chatId: string): DirectTurnReservation;
  releaseDirectTurn(reservation: DirectTurnReservation): Promise<void>;
  runReservedTurn(
    reservation: DirectTurnReservation,
    command: string,
    options: RunAgentTurnOptions,
  ): Promise<void>;
  stopActiveTurn(chatId: string): Promise<StopActiveTurnResult>;
  interruptActiveTurn(chatId: string): Promise<boolean>;
  abortForChatDeletion(chatId: string): Promise<boolean>;
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
  #draining = new Set<string>();
  #directTurns = new Map<string, string>();
  #drainRequestedAfterDirectTurn = new Set<string>();
  #abortDrainSuppressed = new Set<string>();
  #activeDrainEntries = new Map<string, string>();
  #expectedDrainAborts = new Map<string, string>();
  #sessionStopByChatId = new Map<string, Promise<boolean>>();
  #queuesByChatId = new Map<string, StoredQueueState>();
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
    if (this.#draining.has(chatId)) return;
    if (this.#turnRunner.isChatRunning(chatId)) return;
    const queue = await this.readChatQueue(chatId);
    if (this.#abortDrainSuppressed.has(chatId)) {
      const hasPending = queue.entries.some((e) => e.status === 'queued' || e.status === 'sending');
      if (!hasPending) {
        this.emit('chat-idle', chatId);
      }
      return;
    }
    const hasQueued = !queue.pause && queue.entries.some((e) => e.status === 'queued');
    if (hasQueued) {
      await this.#drain(chatId);
      return;
    }
    const hasPending = queue.entries.some((e) => e.status === 'queued' || e.status === 'sending');
    if (!hasPending) {
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
      return normalizeStoredQueueState(JSON.parse(data));
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyStoredQueue();
      throw error;
    }
  }

  async #loadChatQueue(chatId: string): Promise<StoredQueueState> {
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
      if (!queue.entries.some((entry) => entry.status === 'queued')) queue.pause = null;
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
    if (!supportsActiveInput || currentQueue?.entries.length !== 0) return false;

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
      this.#abortDrainSuppressed.delete(chatId);
      queue.entries = queue.entries.filter((entry) => entry.status === 'sending');
      queue.pause = null;
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
      queue.pause = null;
      this.#abortDrainSuppressed.delete(chatId);
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
    const reservation = this.reserveDirectTurn(chatId);
    try {
      await this.registerPendingUserInput(chatId, command, turnOptions);
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
    try {
      this.emit('chat-messages', chatId, appended.generationId, appended.messages, {
        clientRequestId: registeredClientRequestId,
        turnId: options.turnId,
      });
    } catch (error) {
      logger.warn('queue: chat-messages listener failed after durable append:', (error as Error).message);
    }
  }

  discardPendingUserInput(chatId: string, clientRequestId: string): boolean {
    return this.#pendingInputs.discard(chatId, clientRequestId);
  }

  reserveDirectTurn(chatId: string): DirectTurnReservation {
    if (
      this.#directTurns.has(chatId)
      || this.#draining.has(chatId)
      || this.#turnRunner.isChatRunning(chatId)
    ) {
      throw new DomainError('SESSION_BUSY', 'Another chat turn already owns execution', 409, true);
    }
    const reservation = Object.freeze({
      chatId,
      reservationId: crypto.randomUUID(),
    });
    this.#directTurns.set(chatId, reservation.reservationId);
    return reservation;
  }

  async releaseDirectTurn(reservation: DirectTurnReservation): Promise<void> {
    await this.#finishDirectTurn(reservation, false);
  }

  async runReservedTurn(
    reservation: DirectTurnReservation,
    command: string,
    options: RunAgentTurnOptions,
  ): Promise<void> {
    this.#assertDirectTurnReservation(reservation);
    let completed = false;
    try {
      await this.#turnRunner.runAgentTurn(reservation.chatId, command, options);
      completed = true;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.emit('turn-failed', reservation.chatId, message, options);
      throw error;
    } finally {
      await this.#finishDirectTurn(reservation, completed);
    }
  }

  #assertDirectTurnReservation(reservation: DirectTurnReservation): void {
    if (this.#directTurns.get(reservation.chatId) !== reservation.reservationId) {
      throw new Error('Direct turn reservation is no longer active');
    }
  }

  async #finishDirectTurn(
    reservation: DirectTurnReservation,
    completed: boolean,
  ): Promise<void> {
    if (this.#directTurns.get(reservation.chatId) !== reservation.reservationId) {
      if (!this.#chatExists(reservation.chatId)) return;
      throw new Error('Direct turn reservation is no longer active');
    }
    this.#directTurns.delete(reservation.chatId);
    const drainRequested = this.#drainRequestedAfterDirectTurn.delete(reservation.chatId);
    if (!this.#chatExists(reservation.chatId)) return;
    if (completed || drainRequested) await this.#drain(reservation.chatId);
  }

  async #abortSession(chatId: string): Promise<boolean> {
    const inFlight = this.#sessionStopByChatId.get(chatId);
    if (inFlight) return inFlight;

    const stop = this.#performAbortSession(chatId);
    this.#sessionStopByChatId.set(chatId, stop);
    try {
      return await stop;
    } finally {
      if (this.#sessionStopByChatId.get(chatId) === stop) {
        this.#sessionStopByChatId.delete(chatId);
      }
    }
  }

  async #waitForSessionStop(chatId: string): Promise<void> {
    await this.#sessionStopByChatId.get(chatId)?.catch(() => undefined);
  }

  async #performAbortSession(chatId: string): Promise<boolean> {
    const activeDrainEntryId = this.#activeDrainEntries.get(chatId);
    if (activeDrainEntryId) this.#expectedDrainAborts.set(chatId, activeDrainEntryId);
    this.emit('session-stop-requested', chatId);
    try {
      const success = await this.#turnRunner.abortSession(chatId);
      if (!success && this.#expectedDrainAborts.get(chatId) === activeDrainEntryId) {
        this.#expectedDrainAborts.delete(chatId);
      }
      this.emit('session-stopped', chatId, success);
      return success;
    } catch (error) {
      if (this.#expectedDrainAborts.get(chatId) === activeDrainEntryId) {
        this.#expectedDrainAborts.delete(chatId);
      }
      this.emit('session-stopped', chatId, false);
      throw error;
    }
  }

  async stopActiveTurn(chatId: string): Promise<StopActiveTurnResult> {
    this.#abortDrainSuppressed.add(chatId);
    try {
      await this.pauseChatQueue(chatId);
    } catch (error) {
      this.#abortDrainSuppressed.delete(chatId);
      throw error;
    }

    let stopped: boolean;
    try {
      stopped = await this.#abortSession(chatId);
    } finally {
      // A durable pause now owns queued-work blocking. Clearing this temporary
      // gate also lets a later fresh queue entry run when Stop found no queue.
      this.#abortDrainSuppressed.delete(chatId);
    }
    return { stopped, queue: await this.readChatQueue(chatId) };
  }

  async interruptActiveTurn(chatId: string): Promise<boolean> {
    const directTurnReserved = this.#directTurns.has(chatId);
    if (directTurnReserved) this.#drainRequestedAfterDirectTurn.add(chatId);
    const stopped = await this.#abortSession(chatId);
    if (stopped) {
      this.#abortDrainSuppressed.delete(chatId);
      this.triggerDrain(chatId).catch((error: Error) => {
        logger.error('queue: interrupt drain error:', error.message);
      });
    } else if (directTurnReserved) {
      this.#drainRequestedAfterDirectTurn.delete(chatId);
    }
    return stopped;
  }

  async abortForChatDeletion(chatId: string): Promise<boolean> {
    this.#abortDrainSuppressed.add(chatId);
    return this.#abortSession(chatId);
  }

  isChatDraining(chatId: string): boolean {
    return this.#draining.has(chatId);
  }

  isChatExecutionReserved(chatId: string): boolean {
    return this.#draining.has(chatId) || this.#directTurns.has(chatId);
  }

  // Triggers drain if the agent is not currently running.
  async triggerDrain(chatId: string): Promise<void> {
    if (this.#directTurns.has(chatId)) {
      this.#drainRequestedAfterDirectTurn.add(chatId);
      return;
    }
    if (
      this.#abortDrainSuppressed.has(chatId)
      || this.#turnRunner.isChatRunning(chatId)
    ) return;
    await this.#drain(chatId);
  }

  // Pops queued entries one at a time, registers a pending overlay, and runs agent turns.
  // Re-entrant callers (runReservedTurn's post-turn drain racing onFinished's
  // checkChatIdle) are coalesced: a second drain while one is active is a no-op.
  async #drain(chatId: string): Promise<void> {
    if (
      this.#draining.has(chatId)
      || this.#directTurns.has(chatId)
      || this.#abortDrainSuppressed.has(chatId)
      || this.#sessionStopByChatId.has(chatId)
    ) return;
    this.#draining.add(chatId);
    try {
      while (true) {
        if (
          this.#abortDrainSuppressed.has(chatId)
          || this.#directTurns.has(chatId)
          || this.#turnRunner.isChatRunning(chatId)
        ) break;

        const result = await this.popNextChat(chatId);
        if (!result) {
          const queue = await this.readChatQueue(chatId);
          const hasPending = queue.entries.some((e) => e.status === 'queued' || e.status === 'sending');
          if (!hasPending) this.emit('chat-idle', chatId);
          break;
        }

        const { entry } = result;
        let queuedTurnOptions: RunAgentTurnOptions = {};
        let stage: 'preparing' | 'running' | 'finalizing' = 'preparing';

        try {
          queuedTurnOptions = optionsForQueuedTurn(this.#getDrainOptions(chatId));
          await this.registerPendingUserInput(chatId, entry.content, queuedTurnOptions);
          this.emit('dispatching', chatId, entry.id, entry.content);
          stage = 'running';
          this.#activeDrainEntries.set(chatId, entry.id);
          try {
            await this.#turnRunner.runAgentTurn(chatId, entry.content, queuedTurnOptions);
            if (this.#expectedDrainAborts.get(chatId) === entry.id) {
              this.#expectedDrainAborts.delete(chatId);
            }
          } finally {
            if (this.#activeDrainEntries.get(chatId) === entry.id) {
              this.#activeDrainEntries.delete(chatId);
            }
          }
          stage = 'finalizing';
          await this.removeSentChat(chatId, entry.id);
        } catch (error: unknown) {
          const expectedAbort = stage === 'running'
            && this.#expectedDrainAborts.get(chatId) === entry.id;
          if (expectedAbort) {
            this.#expectedDrainAborts.delete(chatId);
            try {
              await this.removeSentChat(chatId, entry.id);
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
            this.emit('turn-failed', chatId, message, queuedTurnOptions);
          } else {
            logger.error('queue: sent-entry finalization failed:', { chatId, entryId: entry.id, stage });
          }
          try {
            await this.requeueAndPauseChat(chatId, entry.id, kind);
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
          break;
        }
      }
    } finally {
      this.#draining.delete(chatId);
      this.#activeDrainEntries.delete(chatId);
      this.#expectedDrainAborts.delete(chatId);
    }
  }

  async deleteChatQueueFile(chatId: string): Promise<void> {
    await this.#withLock(`chat:${chatId}`, async () => {
      this.#abortDrainSuppressed.delete(chatId);
      this.#activeDrainEntries.delete(chatId);
      this.#expectedDrainAborts.delete(chatId);
      this.#drainRequestedAfterDirectTurn.delete(chatId);
      this.#directTurns.delete(chatId);
      this.#queuesByChatId.delete(chatId);
      try {
        await fs.unlink(this.#chatQueueFilePath(chatId));
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    });
  }

  async recoverStaleChatQueues(): Promise<void> {
    const queuesDir = path.join(this.#workspaceDir, 'queues');
    let files: string[];
    try {
      files = await fs.readdir(queuesDir);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }

    const queueFiles = files.filter((f) => f.endsWith('.queue.json'));
    const queuesToDrain = new Set<string>();
    for (const qf of queueFiles) {
      const filePath = path.join(queuesDir, qf);
      const chatId = qf.slice(0, -'.queue.json'.length);
      try {
        if (!this.#chatExists(chatId)) {
          await fs.unlink(filePath);
          this.#queuesByChatId.delete(chatId);
          logger.warn('queue: removed state for a deleted chat', { chatId });
          continue;
        }
        const raw = JSON.parse(await fs.readFile(filePath, 'utf8'));
        const data = normalizeStoredQueueState(raw);
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
          data.pause = {
            id: crypto.randomUUID(),
            kind: 'recovered-inflight',
            entryId: data.entries.find((entry) => recoveredIds.has(entry.id))!.id,
            pausedAt: new Date().toISOString(),
          };
        }
        if (modified) {
          const normalized = normalizeStoredQueueState(bumpStoredQueue(data));
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
      }
    }

    for (const chatId of queuesToDrain) {
      void this.triggerDrain(chatId).catch((error: Error) => {
        logger.warn(`queue: could not resume recovered chat queue ${chatId}:`, error.message);
      });
    }
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
