// Manages per-chat message queues and orchestrates turn execution.
// Extends EventEmitter to notify listeners of queue state changes,
// dispatching events, and session stops.

import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { EventEmitter } from 'events';
import { normalizeQueueState } from '../common/queue-state.ts';
import type { QueueState, QueueEntry } from '../common/queue-state.ts';
import { UserMessage, type ChatMessage, type UserMessageDeliveryStatus } from '../common/chat-types.ts';
import type { ChatMessageEvent } from '../common/chat-events.ts';
import { requireChatExecutionConfig, type RunAgentTurnOptions } from "./agents/session-types.js";
import type { IChatRegistry } from './chats/store.js';
import { writeJsonFileAtomic } from './lib/json-file-store.js';
import { KeyedPromiseLock } from './lib/keyed-lock.js';
import { createLogger } from './lib/log.js';

const logger = createLogger('queue');

function emptyQueue(): QueueState {
  return { entries: [], paused: false, version: 0 };
}

function cloneQueue(queue: QueueState): QueueState {
  return {
    ...queue,
    entries: queue.entries.map((entry) => ({ ...entry })),
  };
}

function bumpQueue(queue: QueueState): QueueState {
  return {
    ...queue,
    version: (queue.version ?? 0) + 1,
    updatedAt: new Date().toISOString(),
  };
}

function optionsForQueuedTurn(options: RunAgentTurnOptions): RunAgentTurnOptions {
  return {
    ...options,
    clientRequestId: crypto.randomUUID(),
    clientMessageId: crypto.randomUUID(),
    turnId: crypto.randomUUID(),
  };
}

type PendingUserInputRegistrationOptions = Pick<
  RunAgentTurnOptions,
  'clientRequestId' | 'clientMessageId' | 'turnId' | 'images'
> & {
  deliveryStatus?: UserMessageDeliveryStatus;
};

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
  abortSession(chatId: string): Promise<boolean>;
  isChatRunning(chatId: string): boolean;
}

interface PendingInputsDep {
  register(chatId: string, content: string, options?: {
    clientRequestId?: string;
    clientMessageId?: string;
    turnId?: string;
    images?: RunAgentTurnOptions['images'];
    deliveryStatus?: UserMessageDeliveryStatus;
  }): Promise<unknown>;
  updateDeliveryStatus(chatId: string, clientRequestId: string, deliveryStatus: UserMessageDeliveryStatus): unknown;
  discard(chatId: string, clientRequestId: string): boolean;
}

interface ChatEventsDep {
  appendMessages(
    chatId: string,
    messages: ChatMessage[],
    origin: 'submit',
  ): Promise<{ logId: string; events: ChatMessageEvent[] }>;
  reviseUserMessageDelivery(
    chatId: string,
    ids: { clientMessageId?: string; clientRequestId?: string; turnId?: string },
    deliveryStatus: 'delivered',
  ): Promise<{ logId: string; event: ChatMessageEvent } | null>;
}

type QueueUpdatedCallback = (chatId: string, state: QueueState) => void;
type DispatchingCallback = (chatId: string, entryId: string, content: string) => void;
type SessionStoppedCallback = (chatId: string, success: boolean) => void;
type ChatIdleCallback = (chatId: string) => void;
type TurnFailedCallback = (chatId: string, errorMessage: string, options: RunAgentTurnOptions) => void;
type ChatEventsCallback = (
  chatId: string,
  logId: string,
  events: ChatMessageEvent[],
  metadata?: { clientRequestId?: string; turnId?: string },
) => void;
type QueueDrainOptionsResolver = (chatId: string) => RunAgentTurnOptions;

export interface ChatQueueService {
  deleteChatQueueFile(chatId: string): Promise<void>;
  submit(chatId: string, command: string, options: RunAgentTurnOptions): Promise<void>;
  registerPendingUserInput(chatId: string, command: string, options: PendingUserInputRegistrationOptions): Promise<void>;
  discardPendingUserInput(chatId: string, clientRequestId: string): boolean;
  runAcceptedTurn(chatId: string, command: string, options: RunAgentTurnOptions): Promise<void>;
  abort(chatId: string): Promise<boolean>;
  triggerDrain(chatId: string): Promise<void>;
  readChatQueue(chatId: string): Promise<QueueState>;
  enqueueChat(chatId: string, content: string): Promise<{ entry: QueueEntry; queue: QueueState }>;
  dequeueChat(chatId: string, entryId: string): Promise<QueueState>;
  clearChatQueue(chatId: string): Promise<QueueState>;
  pauseChatQueue(chatId: string): Promise<QueueState>;
  resumeChatQueue(chatId: string): Promise<QueueState>;
}

export class QueueManager extends EventEmitter implements ChatQueueService {
  #locks = new KeyedPromiseLock();
  #draining = new Set<string>();
  #queuesByChatId = new Map<string, QueueState>();
  #workspaceDir: string;
  #turnRunner: AgentTurnRunnerDep;
  #pendingInputs: PendingInputsDep;
  #chatEvents: ChatEventsDep;
  #getDrainOptions: QueueDrainOptionsResolver;

  constructor(
    workspaceDir: string,
    turnRunner: AgentTurnRunnerDep,
    pendingInputs: PendingInputsDep,
    chatEvents: ChatEventsDep,
    getDrainOptions: QueueDrainOptionsResolver,
  ) {
    super();
    if (!turnRunner) throw new Error('QueueManager requires an agent turn runner');
    if (!pendingInputs) throw new Error('QueueManager requires a pending input service');
    if (!chatEvents) throw new Error('QueueManager requires a chat event log');
    if (!getDrainOptions) throw new Error('QueueManager requires a drain option resolver');
    this.#workspaceDir = workspaceDir;
    this.#turnRunner = turnRunner;
    this.#pendingInputs = pendingInputs;
    this.#chatEvents = chatEvents;
    this.#getDrainOptions = getDrainOptions;
  }

  onQueueUpdated(cb: QueueUpdatedCallback): void { this.on('queue-updated', cb); }
  onDispatching(cb: DispatchingCallback): void { this.on('dispatching', cb); }
  onSessionStopped(cb: SessionStoppedCallback): void { this.on('session-stopped', cb); }
  onChatIdle(cb: ChatIdleCallback): void { this.on('chat-idle', cb); }
  onTurnFailed(cb: TurnFailedCallback): void { this.on('turn-failed', cb); }
  onChatEvents(cb: ChatEventsCallback): void { this.on('chat-events', cb); }

  // Emits chat-idle if the chat has no queued items and the agent is not
  // running. Called after an agent turn finishes to cover the initial-session
  // path where #drain is never invoked. Skips when a drain loop is active
  // for this chat to avoid duplicate emissions.
  async checkChatIdle(chatId: string): Promise<void> {
    if (this.#draining.has(chatId)) return;
    if (this.#turnRunner.isChatRunning(chatId)) return;
    const queue = await this.readChatQueue(chatId);
    const hasPending = queue.entries.some(e => e.status === 'queued' || e.status === 'sending');
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

  async #readChatQueueFromDisk(chatId: string): Promise<QueueState> {
    try {
      const data = await fs.readFile(this.#chatQueueFilePath(chatId), 'utf8');
      return normalizeQueueState(JSON.parse(data));
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyQueue();
      throw error;
    }
  }

  async #loadChatQueue(chatId: string): Promise<QueueState> {
    const cached = this.#queuesByChatId.get(chatId);
    if (cached) return cached;
    const loaded = await this.#readChatQueueFromDisk(chatId);
    this.#queuesByChatId.set(chatId, loaded);
    return loaded;
  }

  async #commitChatQueue(chatId: string, queue: unknown): Promise<QueueState> {
    const filePath = this.#chatQueueFilePath(chatId);
    const normalized = normalizeQueueState(queue);
    await writeJsonFileAtomic(filePath, normalized);
    this.#queuesByChatId.set(chatId, normalized);
    return cloneQueue(normalized);
  }

  async readChatQueue(chatId: string): Promise<QueueState> {
    return this.#withLock(`chat:${chatId}`, async () => cloneQueue(await this.#loadChatQueue(chatId)));
  }

  async enqueueChat(chatId: string, content: string): Promise<{ entry: QueueEntry; queue: QueueState }> {
    return this.#withLock(`chat:${chatId}`, async () => {
      const queue = cloneQueue(await this.#loadChatQueue(chatId));
      const existing = queue.entries.find(e => e.status === 'queued');
      if (existing) {
        existing.content += '\n' + content;
        const bumped = bumpQueue(queue);
        const result = await this.#commitChatQueue(chatId, bumped);
        this.emit('queue-updated', chatId, result);
        return { entry: existing, queue: result };
      }
      const entry: QueueEntry = {
        id: crypto.randomUUID(),
        content,
        status: 'queued',
        createdAt: new Date().toISOString(),
      };
      queue.entries.push(entry);
      const bumped = bumpQueue(queue);
      const result = await this.#commitChatQueue(chatId, bumped);
      this.emit('queue-updated', chatId, result);
      return { entry, queue: result };
    });
  }

  async dequeueChat(chatId: string, entryId: string): Promise<QueueState> {
    return this.#withLock(`chat:${chatId}`, async () => {
      const queue = cloneQueue(await this.#loadChatQueue(chatId));
      queue.entries = queue.entries.filter(e => e.id !== entryId);
      const bumped = bumpQueue(queue);
      const result = await this.#commitChatQueue(chatId, bumped);
      this.emit('queue-updated', chatId, result);
      return result;
    });
  }

  async clearChatQueue(chatId: string): Promise<QueueState> {
    return this.#withLock(`chat:${chatId}`, async () => {
      const queue = cloneQueue(await this.#loadChatQueue(chatId));
      queue.entries = [];
      queue.paused = false;
      const bumped = bumpQueue(queue);
      const result = await this.#commitChatQueue(chatId, bumped);
      this.emit('queue-updated', chatId, result);
      return result;
    });
  }

  async pauseChatQueue(chatId: string): Promise<QueueState> {
    return this.#withLock(`chat:${chatId}`, async () => {
      const queue = cloneQueue(await this.#loadChatQueue(chatId));
      queue.paused = queue.entries.length > 0;
      const bumped = bumpQueue(queue);
      const result = await this.#commitChatQueue(chatId, bumped);
      this.emit('queue-updated', chatId, result);
      return result;
    });
  }

  async resumeChatQueue(chatId: string): Promise<QueueState> {
    return this.#withLock(`chat:${chatId}`, async () => {
      const queue = cloneQueue(await this.#loadChatQueue(chatId));
      queue.paused = false;
      const bumped = bumpQueue(queue);
      const result = await this.#commitChatQueue(chatId, bumped);
      this.emit('queue-updated', chatId, result);
      return result;
    });
  }

  async popNextChat(chatId: string): Promise<{ entry: QueueEntry; queue: QueueState } | null> {
    return this.#withLock(`chat:${chatId}`, async () => {
      const queue = cloneQueue(await this.#loadChatQueue(chatId));
      if (queue.paused && queue.entries.length === 0) {
        queue.paused = false;
        const bumped = bumpQueue(queue);
        const result = await this.#commitChatQueue(chatId, bumped);
        this.emit('queue-updated', chatId, result);
        return null;
      }
      if (queue.paused) return null;
      const next = queue.entries.find(e => e.status === 'queued');
      if (!next) return null;
      next.status = 'sending';
      const bumped = bumpQueue(queue);
      const result = await this.#commitChatQueue(chatId, bumped);
      this.emit('queue-updated', chatId, result);
      return { entry: next, queue: result };
    });
  }

  async removeSentChat(chatId: string, entryId: string): Promise<QueueState> {
    return this.#withLock(`chat:${chatId}`, async () => {
      const queue = cloneQueue(await this.#loadChatQueue(chatId));
      queue.entries = queue.entries.filter(e => e.id !== entryId);
      const bumped = bumpQueue(queue);
      const result = await this.#commitChatQueue(chatId, bumped);
      this.emit('queue-updated', chatId, result);
      return result;
    });
  }

  async resetAndPauseChat(chatId: string, entryId: string): Promise<QueueState> {
    return this.#withLock(`chat:${chatId}`, async () => {
      const queue = cloneQueue(await this.#loadChatQueue(chatId));
      const entry = queue.entries.find(e => e.id === entryId);
      if (entry) entry.status = 'queued';
      queue.paused = true;
      const bumped = bumpQueue(queue);
      const result = await this.#commitChatQueue(chatId, bumped);
      this.emit('queue-updated', chatId, result);
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

  async registerPendingUserInput(chatId: string, command: string, options: PendingUserInputRegistrationOptions): Promise<void> {
    if (!command) return;
    const deliveryStatus = options.deliveryStatus ?? 'accepted';
    await this.#pendingInputs.register(chatId, command, {
      clientRequestId: options.clientRequestId,
      clientMessageId: options.clientMessageId,
      turnId: options.turnId,
      images: options.images,
      deliveryStatus,
    });
    const userMessage = new UserMessage(
      new Date().toISOString(),
      command,
      options.images,
      {
        clientRequestId: options.clientRequestId,
        messageId: options.clientMessageId,
        turnId: options.turnId,
        deliveryStatus,
      },
    );
    const { logId, events } = await this.#chatEvents.appendMessages(chatId, [userMessage], 'submit');
    this.emit('chat-events', chatId, logId, events, {
      clientRequestId: options.clientRequestId,
      turnId: options.turnId,
    });
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
    await this.#reviseDeliveryStatus(chatId, options);
    await this.#drain(chatId);
  }

  async #reviseDeliveryStatus(chatId: string, options: RunAgentTurnOptions): Promise<void> {
    const revised = await this.#chatEvents.reviseUserMessageDelivery(
      chatId,
      {
        clientMessageId: options.clientMessageId,
        clientRequestId: options.clientRequestId,
        turnId: options.turnId,
      },
      'delivered',
    );
    if (!revised) return;
    this.emit('chat-events', chatId, revised.logId, [revised.event], {
      clientRequestId: options.clientRequestId,
      turnId: options.turnId,
    });
  }

  // Aborts the running agent session and pauses the queue if entries remain.
  async abort(chatId: string): Promise<boolean> {
    const success = await this.#turnRunner.abortSession(chatId);
    if (success) {
      try {
        const current = await this.readChatQueue(chatId);
        if (current.entries.length > 0) {
          await this.pauseChatQueue(chatId);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(`queue: failed to pause queue after abort for ${chatId}:`, message);
      }
    }
    this.emit('session-stopped', chatId, success);
    return success;
  }

  // Triggers drain if the agent is not currently running.
  async triggerDrain(chatId: string): Promise<void> {
    if (this.#turnRunner.isChatRunning(chatId)) return;
    await this.#drain(chatId);
  }

  // Pops queued entries one at a time, registers a pending overlay, and runs agent turns.
  async #drain(chatId: string): Promise<void> {
    this.#draining.add(chatId);
    try {
      while (true) {
        if (this.#turnRunner.isChatRunning(chatId)) break;

        const result = await this.popNextChat(chatId);
        if (!result) {
          this.emit('chat-idle', chatId);
          break;
        }

        const { entry } = result;
        const queuedTurnOptions = optionsForQueuedTurn(this.#getDrainOptions(chatId));
        await this.registerPendingUserInput(chatId, entry.content, queuedTurnOptions);
        this.emit('dispatching', chatId, entry.id, entry.content);

        try {
          await this.#turnRunner.runAgentTurn(chatId, entry.content, queuedTurnOptions);
          await this.#reviseDeliveryStatus(chatId, queuedTurnOptions);
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

    const queueFiles = files.filter(f => f.endsWith('.queue.json'));
    for (const qf of queueFiles) {
      const filePath = path.join(queuesDir, qf);
      const chatId = qf.slice(0, -'.queue.json'.length);
      try {
        const data = normalizeQueueState(JSON.parse(await fs.readFile(filePath, 'utf8')));
        let modified = false;
        for (const entry of data.entries) {
          if (entry.status === 'sending') {
            entry.status = 'queued';
            modified = true;
          }
        }
        if (modified) {
          data.paused = true;
          const normalized = normalizeQueueState(data);
          await writeJsonFileAtomic(filePath, normalized);
          this.#queuesByChatId.set(chatId, normalized);
          logger.info(`queue: recovered stale chat queue: ${qf}`);
        } else {
          this.#queuesByChatId.set(chatId, data);
        }
      } catch (error: unknown) {
        logger.warn(`queue: could not recover chat queue ${qf}:`, (error as Error).message);
      }
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
