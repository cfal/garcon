// Manages per-chat message queues and orchestrates turn execution.
// Extends EventEmitter to notify listeners of queue state changes,
// dispatching events, stop requests, and session stops.

import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { EventEmitter } from 'events';
import type { QueueEntry } from '../common/queue-state.ts';
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

export interface ChatQueueService {
  deleteChatQueueFile(chatId: string): Promise<void>;
  submit(chatId: string, command: string, options: RunAgentTurnOptions): Promise<void>;
  registerPendingUserInput(
    chatId: string,
    command: string,
    options: PendingUserInputRegistrationOptions,
  ): Promise<void>;
  discardPendingUserInput(chatId: string, clientRequestId: string): boolean;
  runAcceptedTurn(chatId: string, command: string, options: RunAgentTurnOptions): Promise<void>;
  abort(chatId: string, options?: { drainAfterAbort?: boolean }): Promise<boolean>;
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
  deliverActiveInput(chatId: string, content: string, options?: RunAgentTurnOptions): Promise<boolean>;
  clearChatQueue(chatId: string): Promise<StoredQueueState>;
  pauseChatQueue(chatId: string): Promise<StoredQueueState>;
  resumeChatQueue(chatId: string): Promise<StoredQueueState>;
}

export class QueueManager extends EventEmitter implements ChatQueueService {
  #locks = new KeyedPromiseLock();
  #draining = new Set<string>();
  #abortDrainSuppressed = new Set<string>();
  #queuesByChatId = new Map<string, StoredQueueState>();
  #workspaceDir: string;
  #turnRunner: AgentTurnRunnerDep;
  #pendingInputs: PendingInputsDep;
  #chatMessages: ChatMessagesDep;
  #getDrainOptions: QueueDrainOptionsResolver;

  constructor(
    workspaceDir: string,
    turnRunner: AgentTurnRunnerDep,
    pendingInputs: PendingInputsDep,
    chatMessages: ChatMessagesDep,
    getDrainOptions: QueueDrainOptionsResolver,
  ) {
    super();
    if (!turnRunner) throw new Error('QueueManager requires an agent turn runner');
    if (!pendingInputs) throw new Error('QueueManager requires a pending input service');
    if (!chatMessages) throw new Error('QueueManager requires chat message storage');
    if (!getDrainOptions) throw new Error('QueueManager requires a drain option resolver');
    this.#workspaceDir = workspaceDir;
    this.#turnRunner = turnRunner;
    this.#pendingInputs = pendingInputs;
    this.#chatMessages = chatMessages;
    this.#getDrainOptions = getDrainOptions;
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

  // Settles the queue after an agent turn finishes. Called for every turn,
  // including the initial chat-start turn that runs via startSession and never
  // goes through runAcceptedTurn's post-turn #drain. If a queued entry is
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
    const hasQueued = !queue.paused && queue.entries.some((e) => e.status === 'queued');
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
      if (command) recordAppliedQueueCommand(queue, command, 'delete');
      const result = await this.#commitAndPublish(chatId, bumpStoredQueue(queue));
      this.#logMutation('delete', chatId, entryId, result);
      return { entryId, queue: result, duplicate: false };
    });
  }

  async deliverActiveInput(chatId: string, content: string, options: RunAgentTurnOptions = {}): Promise<boolean> {
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
      queue.paused = false;
      return this.#commitAndPublish(chatId, bumpStoredQueue(queue));
    });
  }

  async pauseChatQueue(chatId: string): Promise<StoredQueueState> {
    return this.#withLock(`chat:${chatId}`, async () => {
      const queue = cloneStoredQueue(await this.#loadChatQueue(chatId));
      const hasQueuedEntries = queue.entries.some((entry) => entry.status === 'queued');
      if (!hasQueuedEntries || queue.paused) return queue;
      queue.paused = true;
      return this.#commitAndPublish(chatId, bumpStoredQueue(queue));
    });
  }

  async resumeChatQueue(chatId: string): Promise<StoredQueueState> {
    return this.#withLock(`chat:${chatId}`, async () => {
      const queue = cloneStoredQueue(await this.#loadChatQueue(chatId));
      this.#abortDrainSuppressed.delete(chatId);
      if (!queue.paused) return queue;
      queue.paused = false;
      return this.#commitAndPublish(chatId, bumpStoredQueue(queue));
    });
  }

  async popNextChat(chatId: string): Promise<{ entry: StoredQueueEntry; queue: StoredQueueState } | null> {
    return this.#withLock(`chat:${chatId}`, async () => {
      const queue = cloneStoredQueue(await this.#loadChatQueue(chatId));
      if (queue.paused) return null;
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

  async resetAndPauseChat(chatId: string, entryId: string): Promise<StoredQueueState> {
    return this.#withLock(`chat:${chatId}`, async () => {
      const queue = cloneStoredQueue(await this.#loadChatQueue(chatId));
      const entry = queue.entries.find((e) => e.id === entryId);
      if (entry) entry.status = 'queued';
      queue.recentlyDispatched = queue.recentlyDispatched.filter((dispatched) => dispatched.entryId !== entryId);
      queue.paused = queue.entries.some((candidate) => candidate.status === 'queued');
      const result = await this.#commitAndPublish(chatId, bumpStoredQueue(queue));
      if (entry) this.#logMutation('requeue', chatId, entryId, result, entry.revision);
      return result;
    });
  }

  // Submits a command to a chat session. Appends the user message to
  // history, runs the agent turn, then drains any queued entries.
  async submit(chatId: string, command: string, options: RunAgentTurnOptions): Promise<void> {
    const turnOptions = ensureTurnIdentifiers(options);
    await this.registerPendingUserInput(chatId, command, turnOptions);
    await this.runAcceptedTurn(chatId, command, turnOptions);
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

  async runAcceptedTurn(chatId: string, command: string, options: RunAgentTurnOptions): Promise<void> {
    try {
      await this.#turnRunner.runAgentTurn(chatId, command, options);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.emit('turn-failed', chatId, message, options);
      throw error;
    }
    await this.#drain(chatId);
  }

  // Aborts the running agent session and lets queued input drain afterward.
  async abort(chatId: string, options: { drainAfterAbort?: boolean } = {}): Promise<boolean> {
    this.emit('session-stop-requested', chatId);
    if (options.drainAfterAbort === false) {
      this.#abortDrainSuppressed.add(chatId);
    }
    let success: boolean;
    try {
      success = await this.#turnRunner.abortSession(chatId);
    } catch (error) {
      this.#abortDrainSuppressed.delete(chatId);
      throw error;
    }
    this.emit('session-stopped', chatId, success);
    if (!success) {
      this.#abortDrainSuppressed.delete(chatId);
    }
    if (success && options.drainAfterAbort !== false) {
      this.triggerDrain(chatId).catch((error: Error) => {
        logger.error('queue: abort drain error:', error.message);
      });
    }
    return success;
  }

  // Triggers drain if the agent is not currently running.
  async triggerDrain(chatId: string): Promise<void> {
    if (this.#turnRunner.isChatRunning(chatId)) return;
    await this.#drain(chatId);
  }

  // Pops queued entries one at a time, registers a pending overlay, and runs agent turns.
  // Re-entrant callers (runAcceptedTurn's post-turn drain racing onFinished's
  // checkChatIdle) are coalesced: a second drain while one is active is a no-op.
  async #drain(chatId: string): Promise<void> {
    if (this.#draining.has(chatId)) return;
    this.#draining.add(chatId);
    try {
      while (true) {
        if (this.#turnRunner.isChatRunning(chatId)) break;

        const result = await this.popNextChat(chatId);
        if (!result) {
          const queue = await this.readChatQueue(chatId);
          const hasPending = queue.entries.some((e) => e.status === 'queued' || e.status === 'sending');
          if (!hasPending) this.emit('chat-idle', chatId);
          break;
        }

        const { entry } = result;
        let queuedTurnOptions: RunAgentTurnOptions = {};

        try {
          queuedTurnOptions = optionsForQueuedTurn(this.#getDrainOptions(chatId));
          await this.registerPendingUserInput(chatId, entry.content, queuedTurnOptions);
          this.emit('dispatching', chatId, entry.id, entry.content);
          await this.#turnRunner.runAgentTurn(chatId, entry.content, queuedTurnOptions);
          await this.removeSentChat(chatId, entry.id);
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          logger.error('queue: error processing queued message:', message);
          this.emit('turn-failed', chatId, message, queuedTurnOptions);
          await this.resetAndPauseChat(chatId, entry.id);
          break;
        }
      }
    } finally {
      this.#draining.delete(chatId);
    }
  }

  async deleteChatQueueFile(chatId: string): Promise<void> {
    await this.#withLock(`chat:${chatId}`, async () => {
      this.#abortDrainSuppressed.delete(chatId);
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
        const data = normalizeStoredQueueState(JSON.parse(await fs.readFile(filePath, 'utf8')));
        let modified = false;
        const recoveredIds = new Set<string>();
        for (const entry of data.entries) {
          if (entry.status === 'sending') {
            entry.status = 'queued';
            recoveredIds.add(entry.id);
            modified = true;
          }
        }
        if (modified) {
          data.paused = true;
          data.recentlyDispatched = data.recentlyDispatched.filter((entry) => !recoveredIds.has(entry.entryId));
          const normalized = normalizeStoredQueueState(bumpStoredQueue(data));
          await writeJsonFileAtomic(filePath, normalized);
          this.#queuesByChatId.set(chatId, normalized);
          logger.info(`queue: recovered stale chat queue: ${qf}`);
        } else {
          this.#queuesByChatId.set(chatId, data);
          if (!data.paused && data.entries.some((entry) => entry.status === 'queued')) {
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
