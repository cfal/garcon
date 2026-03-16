// Manages per-chat message queues and orchestrates turn execution.
// Extends EventEmitter to notify listeners of queue state changes,
// dispatching events, and session stops.

import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { EventEmitter } from 'events';
import { normalizeQueueState } from '../common/queue-state.ts';
import type { QueueState, QueueEntry } from '../common/queue-state.ts';
import { UserMessage } from '../common/chat-types.ts';
import type { RunProviderTurnOptions } from './providers/types.js';

function emptyQueue(): QueueState {
  return { entries: [], paused: false };
}

function normalizeForPersist(queue: unknown): QueueState {
  return normalizeQueueState(queue);
}

interface ProvidersDep {
  runProviderTurn(chatId: string, command: string, options: RunProviderTurnOptions): Promise<void>;
  abortSession(chatId: string): Promise<boolean>;
  isChatRunning(chatId: string): boolean;
}

interface HistoryCacheDep {
  appendMessages(chatId: string, messages: unknown[]): Promise<void>;
}

type QueueUpdatedCallback = (chatId: string, state: QueueState) => void;
type DispatchingCallback = (chatId: string, entryId: string, content: string) => void;
type SessionStoppedCallback = (chatId: string, success: boolean) => void;
type ChatIdleCallback = (chatId: string) => void;

export class QueueManager extends EventEmitter {
  #busy = new Map<string, boolean>();
  #draining = new Set<string>();
  #workspaceDir: string;
  #providers: ProvidersDep | null;
  #historyCache: HistoryCacheDep | null;

  // providers and historyCache are optional for backward compat in tests
  // that only exercise state management methods.
  constructor(workspaceDir: string, providers?: ProvidersDep | null, historyCache?: HistoryCacheDep | null) {
    super();
    this.#workspaceDir = workspaceDir;
    this.#providers = providers || null;
    this.#historyCache = historyCache || null;
  }

  onQueueUpdated(cb: QueueUpdatedCallback): void { this.on('queue-updated', cb); }
  onDispatching(cb: DispatchingCallback): void { this.on('dispatching', cb); }
  onSessionStopped(cb: SessionStoppedCallback): void { this.on('session-stopped', cb); }
  onChatIdle(cb: ChatIdleCallback): void { this.on('chat-idle', cb); }

  // Emits chat-idle if the chat has no queued items and the provider is not
  // running. Call after a provider turn finishes to cover the initial-session
  // path where #drain is never invoked. Skips when a drain loop is active
  // for this chat to avoid duplicate emissions.
  async checkChatIdle(chatId: string): Promise<void> {
    if (this.#draining.has(chatId)) return;
    if (this.#providers?.isChatRunning(chatId)) return;
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
    while (this.#busy.get(key)) {
      await new Promise(r => setImmediate(r));
    }
    this.#busy.set(key, true);
    try {
      return await fn();
    } finally {
      this.#busy.delete(key);
    }
  }

  async #writeChatQueue(chatId: string, queue: unknown): Promise<void> {
    const filePath = this.#chatQueueFilePath(chatId);
    const normalized = normalizeForPersist(queue);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(normalized, null, 2), 'utf8');
  }

  async readChatQueue(chatId: string): Promise<QueueState> {
    try {
      const data = await fs.readFile(this.#chatQueueFilePath(chatId), 'utf8');
      return normalizeQueueState(JSON.parse(data));
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyQueue();
      throw error;
    }
  }

  async enqueueChat(chatId: string, content: string): Promise<{ entry: QueueEntry; queue: QueueState }> {
    return this.#withLock(`chat:${chatId}`, async () => {
      const queue = await this.readChatQueue(chatId);
      const existing = queue.entries.find(e => e.status === 'queued');
      if (existing) {
        existing.content += '\n' + content;
        await this.#writeChatQueue(chatId, queue);
        const result = normalizeForPersist(queue);
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
      await this.#writeChatQueue(chatId, queue);
      const result = normalizeForPersist(queue);
      this.emit('queue-updated', chatId, result);
      return { entry, queue: result };
    });
  }

  async dequeueChat(chatId: string, entryId: string): Promise<QueueState> {
    return this.#withLock(`chat:${chatId}`, async () => {
      const queue = await this.readChatQueue(chatId);
      queue.entries = queue.entries.filter(e => e.id !== entryId);
      await this.#writeChatQueue(chatId, queue);
      const result = normalizeForPersist(queue);
      this.emit('queue-updated', chatId, result);
      return result;
    });
  }

  async clearChatQueue(chatId: string): Promise<QueueState> {
    return this.#withLock(`chat:${chatId}`, async () => {
      const queue = await this.readChatQueue(chatId);
      queue.entries = [];
      queue.paused = false;
      await this.#writeChatQueue(chatId, queue);
      const result = normalizeForPersist(queue);
      this.emit('queue-updated', chatId, result);
      return result;
    });
  }

  async pauseChatQueue(chatId: string): Promise<QueueState> {
    return this.#withLock(`chat:${chatId}`, async () => {
      const queue = await this.readChatQueue(chatId);
      queue.paused = queue.entries.length > 0;
      await this.#writeChatQueue(chatId, queue);
      const result = normalizeForPersist(queue);
      this.emit('queue-updated', chatId, result);
      return result;
    });
  }

  async resumeChatQueue(chatId: string): Promise<QueueState> {
    return this.#withLock(`chat:${chatId}`, async () => {
      const queue = await this.readChatQueue(chatId);
      queue.paused = false;
      await this.#writeChatQueue(chatId, queue);
      const result = normalizeForPersist(queue);
      this.emit('queue-updated', chatId, result);
      return result;
    });
  }

  async popNextChat(chatId: string): Promise<{ entry: QueueEntry; queue: QueueState } | null> {
    return this.#withLock(`chat:${chatId}`, async () => {
      const queue = await this.readChatQueue(chatId);
      if (queue.paused && queue.entries.length === 0) {
        queue.paused = false;
        await this.#writeChatQueue(chatId, queue);
        this.emit('queue-updated', chatId, normalizeForPersist(queue));
        return null;
      }
      if (queue.paused) return null;
      const next = queue.entries.find(e => e.status === 'queued');
      if (!next) return null;
      next.status = 'sending';
      await this.#writeChatQueue(chatId, queue);
      const result = normalizeForPersist(queue);
      this.emit('queue-updated', chatId, result);
      return { entry: next, queue: result };
    });
  }

  async removeSentChat(chatId: string, entryId: string): Promise<QueueState> {
    return this.#withLock(`chat:${chatId}`, async () => {
      const queue = await this.readChatQueue(chatId);
      queue.entries = queue.entries.filter(e => e.id !== entryId);
      await this.#writeChatQueue(chatId, queue);
      const result = normalizeForPersist(queue);
      this.emit('queue-updated', chatId, result);
      return result;
    });
  }

  async resetAndPauseChat(chatId: string, entryId: string): Promise<QueueState> {
    return this.#withLock(`chat:${chatId}`, async () => {
      const queue = await this.readChatQueue(chatId);
      const entry = queue.entries.find(e => e.id === entryId);
      if (entry) entry.status = 'queued';
      queue.paused = true;
      await this.#writeChatQueue(chatId, queue);
      const result = normalizeForPersist(queue);
      this.emit('queue-updated', chatId, result);
      return result;
    });
  }

  // Submits a command to a chat session. Appends the user message to
  // history, runs the provider turn, then drains any queued entries.
  async submit(chatId: string, command: string, options: RunProviderTurnOptions): Promise<void> {
    if (command && this.#historyCache) {
      const userMsg = new UserMessage(new Date().toISOString(), String(command));
      this.#historyCache.appendMessages(chatId, [userMsg]).catch((err: Error) => {
        console.warn(`queue: failed to append user message for ${chatId}:`, err.message);
      });
    }

    await this.#providers!.runProviderTurn(chatId, command, options);
    await this.#drain(chatId, options);
  }

  // Aborts the running provider session and pauses the queue if entries remain.
  async abort(chatId: string): Promise<boolean> {
    const success = await this.#providers!.abortSession(chatId);
    if (success) {
      try {
        const current = await this.readChatQueue(chatId);
        if (current.entries.length > 0) {
          await this.pauseChatQueue(chatId);
        }
      } catch { /* ignore */ }
    }
    this.emit('session-stopped', chatId, success);
    return success;
  }

  // Triggers drain if the provider is not currently running.
  async triggerDrain(chatId: string, options: RunProviderTurnOptions): Promise<void> {
    if (this.#providers!.isChatRunning(chatId)) return;
    await this.#drain(chatId, options);
  }

  // Pops queued entries one at a time, appends to history, and runs provider turns.
  async #drain(chatId: string, options: RunProviderTurnOptions): Promise<void> {
    this.#draining.add(chatId);
    try {
      while (true) {
        if (this.#providers!.isChatRunning(chatId)) break;

        const result = await this.popNextChat(chatId);
        if (!result) {
          this.emit('chat-idle', chatId);
          break;
        }

        const { entry } = result;
        this.emit('dispatching', chatId, entry.id, entry.content);

        if (this.#historyCache) {
          const userMsg = new UserMessage(new Date().toISOString(), String(entry.content));
          this.#historyCache.appendMessages(chatId, [userMsg]).catch((err: Error) => {
            console.warn(`queue: failed to append queued message for ${chatId}:`, err.message);
          });
        }

        try {
          await this.#providers!.runProviderTurn(chatId, entry.content, options);
          await this.removeSentChat(chatId, entry.id);
        } catch (error: unknown) {
          console.error('queue: error processing queued message:', (error as Error).message);
          await this.resetAndPauseChat(chatId, entry.id);
          break;
        }
      }
    } finally {
      this.#draining.delete(chatId);
    }
  }

  async deleteChatQueueFile(chatId: string): Promise<void> {
    try {
      await fs.unlink(this.#chatQueueFilePath(chatId));
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
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
          await fs.writeFile(filePath, JSON.stringify(normalizeForPersist(data), null, 2), 'utf8');
          console.log(`queue: recovered stale chat queue: ${qf}`);
        }
      } catch (error: unknown) {
        console.warn(`queue: could not recover chat queue ${qf}:`, (error as Error).message);
      }
    }
  }
}
