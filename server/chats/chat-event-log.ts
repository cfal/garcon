// Append-only per-chat log of chat message events. Assigns per-chat
// monotonic sequence numbers and stable message IDs at the single point
// where messages enter the system.

import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';
import {
  parseChatMessage,
  UserMessage,
  type ChatMessage,
  type UserMessageDeliveryStatus,
} from '../../common/chat-types.js';
import type { ChatMessageEvent } from '../../common/chat-events.js';
import { KeyedPromiseLock } from '../lib/keyed-lock.js';

export type ChatEventOrigin = 'agent' | 'submit' | 'native' | 'system';

interface PersistedEventLine {
  appendSeq: number;
  seq: number;
  messageId: string;
  rev: number;
  origin: ChatEventOrigin;
  message: ChatMessage;
}

export interface ChatEventPage {
  logId: string;
  events: ChatMessageEvent[];
  lastAppendSeq: number;
  pageOldestSeq: number;
  hasMore: boolean;
}

export interface ChatEventReplay {
  logId: string;
  mode: 'delta' | 'snapshot-required';
  events: ChatMessageEvent[];
  lastAppendSeq: number;
}

export interface AppendMessagesOptions {
  guard?: () => boolean;
}

export interface AppendedChatEvents {
  logId: string;
  events: ChatMessageEvent[];
  skipped?: boolean;
}

export interface RevisedChatEvent {
  logId: string;
  event: ChatMessageEvent;
}

export interface ReplacedChatGeneration {
  logId: string;
  events: ChatMessageEvent[];
  lastAppendSeq: number;
  localNotice?: string;
}

interface LogEntry {
  chatId: string;
  logId: string;
  events: ChatMessageEvent[];
  byMessageId: Map<string, number>;
  lastAppendSeq: number;
  loaded: boolean;
  lastAccessAt: number;
}

export interface ChatEventLogOptions {
  replayLimit?: number;
  cacheLimit?: number;
  staleNonActiveMs?: number;
  maxPendingMutationsPerChat?: number;
  now?: () => number;
}

interface MutationOptions {
  bypassBackpressure?: boolean;
}

const REPLAY_LIMIT = 2048;
const CACHE_LIMIT = 100;
const STALE_NON_ACTIVE_MS = 10 * 60 * 1000;
const MAX_PENDING_MUTATIONS_PER_CHAT = 512;

export class ChatEventBackpressureError extends Error {
  constructor(chatId: string) {
    super(`Chat event log mutation queue is full for ${chatId}`);
  }
}

export class ChatEventLog {
  #dir: string;
  #entries = new Map<string, LogEntry>();
  #loads = new Map<string, Promise<LogEntry>>();
  #writeQueues = new Map<string, Promise<void>>();
  #pendingMutations = new Map<string, number>();
  #locks = new KeyedPromiseLock();
  #generations = new Map<string, string>();
  #replayLimit: number;
  #cacheLimit: number;
  #staleNonActiveMs: number;
  #maxPendingMutationsPerChat: number;
  #now: () => number;
  #isChatActive: (chatId: string) => boolean;

  constructor(
    workspaceDir: string,
    isChatActive: (chatId: string) => boolean,
    options: ChatEventLogOptions = {},
  ) {
    this.#dir = path.join(workspaceDir, 'chat-events');
    this.#isChatActive = isChatActive;
    this.#replayLimit = options.replayLimit ?? REPLAY_LIMIT;
    this.#cacheLimit = options.cacheLimit ?? CACHE_LIMIT;
    this.#staleNonActiveMs = options.staleNonActiveMs ?? STALE_NON_ACTIVE_MS;
    this.#maxPendingMutationsPerChat = options.maxPendingMutationsPerChat ?? MAX_PENDING_MUTATIONS_PER_CHAT;
    this.#now = options.now ?? (() => Date.now());
  }

  async appendMessages(
    chatId: string,
    messages: ChatMessage[],
    origin: ChatEventOrigin,
    options: AppendMessagesOptions = {},
  ): Promise<AppendedChatEvents> {
    return this.#runMutation(chatId, async () => {
      const entry = await this.#ensureLoaded(chatId);
      if (options.guard && !options.guard()) {
        return { logId: entry.logId, events: [], skipped: true };
      }
      if (messages.length === 0) return { logId: entry.logId, events: [] };
      const lines: PersistedEventLine[] = [];
      const events: ChatMessageEvent[] = [];
      const baseAppendSeq = entry.lastAppendSeq;
      for (const message of messages) {
        const appendSeq = baseAppendSeq + events.length + 1;
        const event: ChatMessageEvent = {
          appendSeq,
          seq: appendSeq,
          messageId: crypto.randomUUID(),
          rev: 1,
          message,
        };
        assertValidChatMessageEvent(event);
        events.push(event);
        lines.push({ ...event, origin });
      }

      if (options.guard && !options.guard()) {
        return { logId: entry.logId, events: [], skipped: true };
      }

      await this.#persistLines(chatId, lines);
      for (const event of events) {
        entry.byMessageId.set(event.messageId, entry.events.length);
        entry.events.push(event);
      }
      entry.lastAppendSeq = events[events.length - 1].appendSeq;
      entry.lastAccessAt = this.#now();
      this.#pruneIfNeeded();
      return { logId: entry.logId, events };
    });
  }

  async replaceGenerationFromNative(
    chatId: string,
    messages: ChatMessage[],
    options: { localNotice?: string } = {},
  ): Promise<ReplacedChatGeneration> {
    return this.#runMutation(chatId, async () => {
      const entry: LogEntry = {
        chatId,
        logId: crypto.randomUUID(),
        events: [],
        byMessageId: new Map(),
        lastAppendSeq: 0,
        loaded: true,
        lastAccessAt: this.#now(),
      };
      for (const message of messages) {
        const appendSeq = entry.lastAppendSeq + 1;
        const event: ChatMessageEvent = {
          appendSeq,
          seq: appendSeq,
          messageId: crypto.randomUUID(),
          rev: 1,
          message,
        };
        assertValidChatMessageEvent(event);
        entry.byMessageId.set(event.messageId, entry.events.length);
        entry.events.push(event);
        entry.lastAppendSeq = appendSeq;
      }

      await this.#persistReplacement(
        chatId,
        entry.events.map((event) => ({ ...event, origin: 'native' })),
      );
      this.#generations.set(chatId, entry.logId);
      this.#entries.set(chatId, entry);
      this.#pruneIfNeeded();
      return {
        logId: entry.logId,
        events: [...entry.events],
        lastAppendSeq: entry.lastAppendSeq,
        localNotice: options.localNotice,
      };
    }, { bypassBackpressure: true });
  }

  async reviseMessage(
    chatId: string,
    messageId: string,
    message: ChatMessage,
    options: { origin?: ChatEventOrigin } = {},
  ): Promise<RevisedChatEvent | null> {
    return this.#runMutation(chatId, async () => {
      const entry = await this.#ensureLoaded(chatId);
      const event = await this.#reviseLoadedMessage(entry, chatId, messageId, message, options.origin ?? 'system');
      return event ? { logId: entry.logId, event } : null;
    });
  }

  async reviseUserMessageDelivery(
    chatId: string,
    ids: { clientMessageId?: string; clientRequestId?: string; turnId?: string },
    deliveryStatus: Extract<UserMessageDeliveryStatus, 'delivered'>,
  ): Promise<RevisedChatEvent | null> {
    return this.#runMutation(chatId, async () => {
      const entry = await this.#ensureLoaded(chatId);
      const target = this.#findUserMessageEvent(entry, ids);
      if (!target) return null;
      const current = entry.events[target.index].message;
      if (!(current instanceof UserMessage)) return null;
      if (current.metadata?.deliveryStatus === deliveryStatus) return null;
      const revised = new UserMessage(
        current.timestamp,
        current.content,
        current.images,
        { ...(current.metadata ?? {}), deliveryStatus },
      );
      const event = await this.#reviseLoadedMessage(entry, chatId, target.event.messageId, revised, 'submit');
      return event ? { logId: entry.logId, event } : null;
    });
  }

  async readPage(chatId: string, limit: number, beforeSeq?: number): Promise<ChatEventPage> {
    const entry = await this.#ensureLoaded(chatId);
    entry.lastAccessAt = this.#now();
    const events = entry.events;
    const end = beforeSeq && beforeSeq > 0
      ? lowerBound(events, beforeSeq)
      : events.length;
    const start = Math.max(0, end - Math.max(0, limit));
    const page = events.slice(start, end);
    return {
      logId: entry.logId,
      events: page,
      lastAppendSeq: entry.lastAppendSeq,
      pageOldestSeq: page.length > 0 ? page[0].seq : 0,
      hasMore: start > 0,
    };
  }

  async readReplay(chatId: string, logId: string, afterAppendSeq: number): Promise<ChatEventReplay> {
    const entry = await this.#ensureLoaded(chatId);
    entry.lastAccessAt = this.#now();
    const snapshotRequired =
      logId !== entry.logId ||
      afterAppendSeq <= 0 ||
      afterAppendSeq > entry.lastAppendSeq ||
      entry.lastAppendSeq - afterAppendSeq > this.#replayLimit;
    if (snapshotRequired) {
      return { logId: entry.logId, mode: 'snapshot-required', events: [], lastAppendSeq: entry.lastAppendSeq };
    }
    const events = entry.events
      .filter((event) => event.appendSeq > afterAppendSeq)
      .sort((left, right) => left.appendSeq - right.appendSeq);
    return { logId: entry.logId, mode: 'delta', events, lastAppendSeq: entry.lastAppendSeq };
  }

  async getMessages(chatId: string): Promise<ChatMessage[]> {
    const entry = await this.#ensureLoaded(chatId);
    return entry.events.map((event) => event.message);
  }

  getLoadedMessages(chatId: string): ChatMessage[] | null {
    const entry = this.#entries.get(chatId);
    if (!entry?.loaded) return null;
    entry.lastAccessAt = this.#now();
    return entry.events.map((event) => event.message);
  }

  async hasPersistedLog(chatId: string): Promise<boolean> {
    if (this.#entries.has(chatId)) return true;
    try {
      await fs.stat(this.#filePath(chatId));
      return true;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  async deleteChatLog(chatId: string): Promise<void> {
    await this.#runMutation(chatId, async () => {
      this.#entries.delete(chatId);
      this.#generations.delete(chatId);
      try {
        await fs.unlink(this.#filePath(chatId));
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    });
  }

  evict(chatId: string): void {
    this.#entries.delete(chatId);
  }

  prune(): void {
    const now = this.#now();
    const entries = [...this.#entries.values()].sort((a, b) => a.lastAccessAt - b.lastAccessAt);
    for (const entry of entries) {
      if (this.#isChatActive(entry.chatId)) continue;
      const isStale = now - entry.lastAccessAt > this.#staleNonActiveMs;
      const isOverLimit = this.#entries.size > this.#cacheLimit;
      if (isStale || isOverLimit) this.#entries.delete(entry.chatId);
    }
  }

  #findUserMessageEvent(
    entry: LogEntry,
    ids: { clientMessageId?: string; clientRequestId?: string; turnId?: string },
  ): { event: ChatMessageEvent; index: number } | null {
    for (let i = entry.events.length - 1; i >= 0; i--) {
      const event = entry.events[i];
      const message = event.message;
      if (!(message instanceof UserMessage)) continue;
      const metadata = message.metadata ?? {};
      if (ids.clientMessageId && metadata.messageId === ids.clientMessageId) {
        return { event, index: i };
      }
      if (ids.clientRequestId && metadata.clientRequestId === ids.clientRequestId) {
        return { event, index: i };
      }
      if (ids.turnId && metadata.turnId === ids.turnId) {
        return { event, index: i };
      }
    }
    return null;
  }

  async #reviseLoadedMessage(
    entry: LogEntry,
    chatId: string,
    messageId: string,
    message: ChatMessage,
    origin: ChatEventOrigin,
  ): Promise<ChatMessageEvent | null> {
    const index = entry.byMessageId.get(messageId);
    if (index === undefined) return null;
    const prior = entry.events[index];
    const event: ChatMessageEvent = {
      appendSeq: entry.lastAppendSeq + 1,
      seq: prior.seq,
      messageId,
      rev: prior.rev + 1,
      message,
    };
    assertValidChatMessageEvent(event);
    await this.#persistLines(chatId, [{ ...event, origin }]);
    entry.lastAppendSeq = event.appendSeq;
    entry.events[index] = event;
    entry.lastAccessAt = this.#now();
    return event;
  }

  async #runMutation<T>(
    chatId: string,
    fn: () => Promise<T>,
    options: MutationOptions = {},
  ): Promise<T> {
    let counted = false;
    if (!options.bypassBackpressure) {
      const pending = this.#pendingMutations.get(chatId) ?? 0;
      if (pending >= this.#maxPendingMutationsPerChat) {
        throw new ChatEventBackpressureError(chatId);
      }
      this.#pendingMutations.set(chatId, pending + 1);
      counted = true;
    }
    try {
      return await this.#locks.runExclusive(`chat:${chatId}`, fn);
    } finally {
      if (counted) {
        const next = (this.#pendingMutations.get(chatId) ?? 1) - 1;
        if (next <= 0) this.#pendingMutations.delete(chatId);
        else this.#pendingMutations.set(chatId, next);
      }
    }
  }

  #filePath(chatId: string): string {
    return path.join(this.#dir, `${chatId}.events.jsonl`);
  }

  async #ensureLoaded(chatId: string): Promise<LogEntry> {
    const existing = this.#entries.get(chatId);
    if (existing?.loaded) return existing;
    const pending = this.#loads.get(chatId);
    if (pending) return pending;

    const load = (async (): Promise<LogEntry> => {
      const entry: LogEntry = {
        chatId,
        logId: '',
        events: [],
        byMessageId: new Map(),
        lastAppendSeq: 0,
        loaded: true,
        lastAccessAt: this.#now(),
      };
      const generation = this.#generations.get(chatId) ?? crypto.randomUUID();
      this.#generations.set(chatId, generation);
      entry.logId = generation;

      let raw = '';
      try {
        raw = await fs.readFile(this.#filePath(chatId), 'utf8');
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }

      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        const parsed = parsePersistedLine(line);
        if (!parsed) {
          console.warn(`chat-events: dropping corrupt tail for ${chatId}`);
          break;
        }
        applyLoadedLine(entry, parsed);
      }
      this.#entries.set(chatId, entry);
      this.#pruneIfNeeded();
      return entry;
    })();

    this.#loads.set(chatId, load);
    try {
      return await load;
    } finally {
      this.#loads.delete(chatId);
    }
  }

  #pruneIfNeeded(): void {
    if (this.#entries.size > this.#cacheLimit) this.prune();
  }

  async #persistReplacement(chatId: string, lines: PersistedEventLine[]): Promise<void> {
    const payload = lines.length > 0
      ? lines.map((line) => JSON.stringify(line)).join('\n') + '\n'
      : '';
    const prior = this.#writeQueues.get(chatId) ?? Promise.resolve();
    const write = prior.then(async () => {
      const filePath = this.#filePath(chatId);
      const tempPath = `${filePath}.${crypto.randomUUID()}.tmp`;
      await fs.mkdir(this.#dir, { recursive: true });
      await fs.writeFile(tempPath, payload, 'utf8');
      await fs.rename(tempPath, filePath);
    });
    this.#writeQueues.set(chatId, write.catch(() => {}));
    await write;
  }

  async #persistLines(chatId: string, lines: PersistedEventLine[]): Promise<void> {
    if (lines.length === 0) return;
    const payload = lines.map((line) => JSON.stringify(line)).join('\n') + '\n';
    const prior = this.#writeQueues.get(chatId) ?? Promise.resolve();
    const write = prior.then(async () => {
      await fs.mkdir(this.#dir, { recursive: true });
      await fs.appendFile(this.#filePath(chatId), payload, 'utf8');
    });
    this.#writeQueues.set(chatId, write.catch(() => {}));
    await write;
  }
}

function lowerBound(events: ChatMessageEvent[], seq: number): number {
  let lo = 0;
  let hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (events[mid].seq < seq) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function parsePersistedLine(line: string): PersistedEventLine | null {
  try {
    const raw = JSON.parse(line) as Record<string, unknown>;
    const isSeq = (value: unknown): value is number =>
      typeof value === 'number' && Number.isInteger(value) && value > 0;
    const appendSeq = isSeq(raw.appendSeq) ? raw.appendSeq : null;
    const seq = isSeq(raw.seq) ? raw.seq : null;
    const rev = isSeq(raw.rev) ? raw.rev : null;
    const messageId = typeof raw.messageId === 'string' && raw.messageId ? raw.messageId : null;
    const origin = raw.origin === 'agent' || raw.origin === 'submit' || raw.origin === 'native' || raw.origin === 'system'
      ? raw.origin
      : 'agent';
    if (!appendSeq || !seq || !rev || !messageId || appendSeq < seq) return null;
    const message = parseChatMessage((raw.message ?? {}) as Record<string, unknown>);
    if (!message) return null;
    return { appendSeq, seq, messageId, rev, origin, message };
  } catch {
    return null;
  }
}

function assertValidChatMessageEvent(event: ChatMessageEvent): void {
  const valid =
    Number.isInteger(event.appendSeq) &&
    Number.isInteger(event.seq) &&
    Number.isInteger(event.rev) &&
    event.appendSeq > 0 &&
    event.seq > 0 &&
    event.rev > 0 &&
    event.appendSeq >= event.seq &&
    event.messageId.length > 0;
  if (!valid) throw new Error('Invalid chat event envelope');
}

function applyLoadedLine(entry: LogEntry, line: PersistedEventLine): void {
  entry.lastAppendSeq = Math.max(entry.lastAppendSeq, line.appendSeq);
  const event: ChatMessageEvent = {
    appendSeq: line.appendSeq,
    seq: line.seq,
    messageId: line.messageId,
    rev: line.rev,
    message: line.message,
  };
  assertValidChatMessageEvent(event);
  const index = entry.byMessageId.get(line.messageId);
  if (index !== undefined) {
    if (entry.events[index].rev < line.rev) {
      entry.events[index] = { ...event, seq: entry.events[index].seq };
    }
    return;
  }
  entry.byMessageId.set(line.messageId, entry.events.length);
  entry.events.push(event);
}
