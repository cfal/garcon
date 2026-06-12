// Bounded in-memory cache of ChatMessage[] arrays by chatId. Entries may be
// full history loads or live tails captured before the user opens a chat.

import { mergeChatMessagesByIdentity, chatMessageIdentityTokens } from '../../common/chat-message-identity.js';
import { parseChatMessages, type ChatMessage } from '../../common/chat-types.js';
import type { ChatRegistryEntry, IChatRegistry } from './store.js';
import type { PaginatedChatMessages } from './history-cache-contract.js';
import { createLogger } from '../lib/log.js';

const logger = createLogger('chats:history-cache');

const CACHE_LIMIT = 100;
const STALE_NON_ACTIVE_MS = 10 * 60 * 1000;
const PRUNE_INTERVAL_MS = 5 * 60 * 1000;

type CacheCompleteness = 'tail' | 'full';

interface HistoryCacheEntry {
  chatId: string;
  messages: ChatMessage[];
  completeness: CacheCompleteness;
  lastAccessAt: number;
  identityTokens: Set<string>;
}

interface HistoryCacheInitialEntry {
  chatId: string;
  messages?: ChatMessage[];
  completeness?: CacheCompleteness;
  lastAccessAt?: number;
}

interface HistoryCacheOptions {
  cacheLimit?: number;
  staleNonActiveMs?: number;
  now?: () => number;
  initialEntries?: HistoryCacheInitialEntry[];
}

interface HistoryCacheMetadata {
  updateFromAppendedMessages(chatId: string, appendedMessages: ChatMessage[]): void;
}

interface HistoryCacheAgents {
  onMessages(cb: (chatId: string, messages: unknown[]) => void): void;
  isChatRunning(chatId: string): boolean;
  loadMessages(session: ChatRegistryEntry, chatId: string): Promise<unknown[]>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function historyCacheIdentityTokens(message: ChatMessage): string[] {
  const tokens = chatMessageIdentityTokens(message, { includeContentToken: true });
  if (tokens.length > 0) return tokens;

  const rawMessage = message as unknown as Record<string, unknown>;
  const type = message.type || '';
  const content = typeof rawMessage.content === 'string' ? rawMessage.content.trim() : '';
  const ts = message.timestamp || '';
  return [`${type}:fallback:${content}:${ts}`];
}

function buildIdentityTokenSet(messages: ChatMessage[]): Set<string> {
  const identityTokens = new Set<string>();
  for (const message of messages) {
    for (const token of historyCacheIdentityTokens(message)) {
      identityTokens.add(token);
    }
  }
  return identityTokens;
}

function createHistoryCacheEntry(args: {
  chatId: string;
  messages?: ChatMessage[];
  completeness?: CacheCompleteness;
  lastAccessAt: number;
}): HistoryCacheEntry {
  const messages = [...(args.messages ?? [])];
  return {
    chatId: args.chatId,
    messages,
    completeness: args.completeness ?? 'tail',
    lastAccessAt: args.lastAccessAt,
    identityTokens: buildIdentityTokenSet(messages),
  };
}

export class HistoryCache {
  #cacheByChatId = new Map<string, HistoryCacheEntry>();
  #inFlightLoads = new Map<string, Promise<ChatMessage[]>>();
  #pruneTimer: ReturnType<typeof setInterval> | null = null;
  #initialized = false;
  #registry: IChatRegistry;
  #metadata: HistoryCacheMetadata;
  #agents: HistoryCacheAgents;
  #cacheLimit: number;
  #staleNonActiveMs: number;
  #now: () => number;

  constructor(
    registry: IChatRegistry,
    metadata: HistoryCacheMetadata,
    agents: HistoryCacheAgents,
    options: HistoryCacheOptions = {},
  ) {
    this.#registry = registry;
    this.#metadata = metadata;
    this.#agents = agents;
    this.#cacheLimit = options.cacheLimit ?? CACHE_LIMIT;
    this.#staleNonActiveMs = options.staleNonActiveMs ?? STALE_NON_ACTIVE_MS;
    this.#now = options.now ?? (() => Date.now());

    for (const entry of options.initialEntries ?? []) {
      const chatId = String(entry.chatId);
      this.#cacheByChatId.set(chatId, createHistoryCacheEntry({
        chatId,
        messages: Array.isArray(entry.messages) ? [...entry.messages] : [],
        completeness: entry.completeness ?? 'tail',
        lastAccessAt: typeof entry.lastAccessAt === 'number' ? entry.lastAccessAt : this.#now(),
      }));
    }
  }

  init(): void {
    if (!this.#initialized) {
      this.#initialized = true;

      // Evict cache entry when a chat is removed from registry.
      this.#registry.onChatRemoved((chatId) => this.evictChat(chatId));

      // Self-wire: append agent messages to cache as they arrive.
      this.#agents.onMessages((chatId, messages) => {
        if (!this.#registry.getChat(chatId)) return;
        this.appendMessages(chatId, parseChatMessages(messages)).catch((err) => {
          logger.warn('history-cache: appendMessages failed:', errorMessage(err));
        });
      });
    }

    if (this.#pruneTimer) clearInterval(this.#pruneTimer);
    this.#pruneTimer = setInterval(() => {
      try {
        this.prune();
      } catch (err) {
        logger.warn('history-cache: prune failed:', errorMessage(err));
      }
    }, PRUNE_INTERVAL_MS);
  }

  destroy(): void {
    if (this.#pruneTimer) clearInterval(this.#pruneTimer);
    this.#pruneTimer = null;
    this.#cacheByChatId.clear();
    this.#inFlightLoads.clear();
  }

  getMessages(chatId: string): ChatMessage[] | null {
    const key = String(chatId);
    const entry = this.#cacheByChatId.get(key);
    if (!entry) return null;
    entry.lastAccessAt = this.#now();
    return entry.messages;
  }

  async ensureLoaded(chatId: string): Promise<ChatMessage[]> {
    const key = String(chatId);
    const existing = this.#cacheByChatId.get(key);
    if (existing?.completeness === 'full') {
      existing.lastAccessAt = this.#now();
      return existing.messages;
    }

    const pending = this.#inFlightLoads.get(key);
    if (pending) return pending;

    const loadPromise = (async () => {
      const loaded = await this.#loadFromAgent(key);
      const current = this.#cacheByChatId.get(key);
      const liveTail = current?.completeness === 'tail' ? current.messages : [];
      const messages = mergeChatMessages(loaded, liveTail, { includeContentToken: true });
      // Sort chronologically after merge. mergeChatMessagesByIdentity
      // preserves base-then-incoming order, which scrambles timestamps
      // when the live tail (agent-only) is used as the base and the full
      // history (user + agent) is merged as incoming.
      messages.sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));
      const deduped = deduplicateMessages(messages);
      this.#cacheByChatId.set(key, createHistoryCacheEntry({
        chatId: key,
        messages: deduped,
        completeness: 'full',
        lastAccessAt: this.#now(),
      }));
      return deduped;
    })();

    this.#inFlightLoads.set(key, loadPromise);

    try {
      return await loadPromise;
    } finally {
      this.#inFlightLoads.delete(key);
    }
  }

  async appendMessages(chatId: string, appendedMessages: ChatMessage[]): Promise<void> {
    const key = String(chatId);
    let entry = this.#cacheByChatId.get(key);

    if (!entry) {
      entry = createHistoryCacheEntry({
        chatId: key,
        messages: [],
        completeness: 'tail',
        lastAccessAt: this.#now(),
      });
      this.#cacheByChatId.set(key, entry);
    }

    const newMessages = takeNewMessages(entry.identityTokens, appendedMessages);
    if (newMessages.length > 0) {
      entry.messages.push(...newMessages);
    }
    entry.lastAccessAt = this.#now();

    try {
      this.#metadata.updateFromAppendedMessages(key, appendedMessages);
    } catch (err) {
      logger.warn(`history-cache: metadata update failed for ${key}:`, errorMessage(err));
    }

    if (this.#cacheByChatId.size > this.#cacheLimit) {
      this.prune();
    }
  }

  async getPaginatedMessages(chatId: string, limit: number, offset: number): Promise<PaginatedChatMessages> {
    const key = String(chatId);
    const messages = await this.ensureLoaded(key);
    const entry = this.#cacheByChatId.get(key);

    if (entry) entry.lastAccessAt = this.#now();

    const total = messages.length;
    const start = Math.max(0, total - offset - limit);
    const end = total - offset;
    const pageMessages = messages.slice(start, end);

    return {
      messages: pageMessages,
      total,
      hasMore: start > 0,
      offset,
      limit,
    };
  }

  evictChat(chatId: string): void {
    this.#cacheByChatId.delete(String(chatId));
  }

  prune(): void {
    const now = this.#now();
    const entries = Array.from(this.#cacheByChatId.values())
      .sort((a, b) => a.lastAccessAt - b.lastAccessAt);

    for (const entry of entries) {
      const active = this.#agents.isChatRunning(entry.chatId);
      if (active) continue;

      const isStale = now - entry.lastAccessAt > this.#staleNonActiveMs;
      const isOverLimit = this.#cacheByChatId.size > this.#cacheLimit;

      if (isStale || isOverLimit) {
        this.#cacheByChatId.delete(entry.chatId);
      }
    }
  }

  async #loadFromAgent(chatId: string): Promise<ChatMessage[]> {
    const session = this.#registry.getChat(chatId);
    if (!session) return [];
    return parseChatMessages(await this.#agents.loadMessages(session, chatId));
  }

}

function mergeChatMessages(
  base: ChatMessage[],
  incoming: ChatMessage[] | null | undefined,
  options = {},
): ChatMessage[] {
  return mergeChatMessagesByIdentity(base, incoming ?? [], options);
}

// Removes duplicate messages from a sorted array. Uses identity tokens
// (including content tokens) for dedup. Messages with no identity tokens
// (e.g. user messages without metadata) fall back to type+content+timestamp.
function deduplicateMessages(messages: ChatMessage[]): ChatMessage[] {
  if (messages.length <= 1) return messages;
  const seen = new Set<string>();
  const result: ChatMessage[] = [];
  for (const message of messages) {
    const tokens = historyCacheIdentityTokens(message);
    if (tokens.some((token) => seen.has(token))) continue;
    for (const token of tokens) seen.add(token);
    result.push(message);
  }
  return result;
}

function takeNewMessages(identityTokens: Set<string>, messages: ChatMessage[]): ChatMessage[] {
  const next: ChatMessage[] = [];
  for (const message of messages) {
    const tokens = historyCacheIdentityTokens(message);
    if (tokens.some((token) => identityTokens.has(token))) continue;
    for (const token of tokens) identityTokens.add(token);
    next.push(message);
  }
  return next;
}
