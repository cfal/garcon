// Bounded in-memory cache of ChatMessage[] arrays by chatId. Entries may be
// full history loads or live tails captured before the user opens a chat.

import { mergeChatMessagesByIdentity, chatMessageIdentityTokens } from '../../common/chat-message-identity.js';

const CACHE_LIMIT = 100;
const STALE_NON_ACTIVE_MS = 10 * 60 * 1000;
const PRUNE_INTERVAL_MS = 5 * 60 * 1000;

export class HistoryCache {
  #cacheByChatId = new Map();
  #inFlightLoads = new Map();
  #pruneTimer = null;
  #initialized = false;
  #registry;
  #metadata;
  #agents;
  #cacheLimit;
  #staleNonActiveMs;
  #now;

  // registry: ChatRegistry
  // metadata: MetadataIndex
  // agents: AgentRegistry
  constructor(registry, metadata, agents, options = {}) {
    this.#registry = registry;
    this.#metadata = metadata;
    this.#agents = agents;
    this.#cacheLimit = options.cacheLimit ?? CACHE_LIMIT;
    this.#staleNonActiveMs = options.staleNonActiveMs ?? STALE_NON_ACTIVE_MS;
    this.#now = options.now ?? (() => Date.now());

    for (const entry of options.initialEntries ?? []) {
      const chatId = String(entry.chatId);
      this.#cacheByChatId.set(chatId, {
        chatId,
        messages: Array.isArray(entry.messages) ? [...entry.messages] : [],
        completeness: entry.completeness ?? 'tail',
        lastAccessAt: typeof entry.lastAccessAt === 'number' ? entry.lastAccessAt : this.#now(),
      });
    }
  }

  init() {
    if (!this.#initialized) {
      this.#initialized = true;

      // Evict cache entry when a chat is removed from registry.
      this.#registry.onChatRemoved((chatId) => this.evictChat(chatId));

      // Self-wire: append agent messages to cache as they arrive.
      this.#agents.onMessages((chatId, messages) => {
        this.appendMessages(chatId, messages).catch((err) => {
          console.warn('history-cache: appendMessages failed:', err.message);
        });
      });
    }

    if (this.#pruneTimer) clearInterval(this.#pruneTimer);
    this.#pruneTimer = setInterval(() => {
      try {
        this.prune();
      } catch (err) {
        console.warn('history-cache: prune failed:', err.message);
      }
    }, PRUNE_INTERVAL_MS);
  }

  destroy() {
    clearInterval(this.#pruneTimer);
    this.#pruneTimer = null;
    this.#cacheByChatId.clear();
    this.#inFlightLoads.clear();
  }

  getMessages(chatId) {
    const key = String(chatId);
    const entry = this.#cacheByChatId.get(key);
    if (!entry) return null;
    entry.lastAccessAt = this.#now();
    return entry.messages;
  }

  async ensureLoaded(chatId) {
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
      this.#cacheByChatId.set(key, {
        chatId: key,
        messages: deduped,
        completeness: 'full',
        lastAccessAt: this.#now(),
      });
      return deduped;
    })();

    this.#inFlightLoads.set(key, loadPromise);

    try {
      return await loadPromise;
    } finally {
      this.#inFlightLoads.delete(key);
    }
  }

  async appendMessages(chatId, appendedMessages) {
    const key = String(chatId);
    let entry = this.#cacheByChatId.get(key);

    if (!entry) {
      entry = { chatId: key, messages: [], completeness: 'tail', lastAccessAt: this.#now() };
      this.#cacheByChatId.set(key, entry);
    }

    entry.messages = deduplicateMessages(
      mergeChatMessages(entry.messages, appendedMessages),
    );
    entry.lastAccessAt = this.#now();

    try {
      this.#metadata.updateFromAppendedMessages(key, appendedMessages);
    } catch (err) {
      console.warn(`history-cache: metadata update failed for ${key}:`, err.message);
    }

    if (this.#cacheByChatId.size > this.#cacheLimit) {
      this.prune();
    }
  }

  getPaginatedMessages(chatId, limit, offset) {
    const key = String(chatId);
    const entry = this.#cacheByChatId.get(key);
    if (!entry) {
      return { messages: [], total: 0, hasMore: false, offset, limit };
    }

    entry.lastAccessAt = this.#now();

    const total = entry.messages.length;
    const start = Math.max(0, total - offset - limit);
    const end = total - offset;
    const messages = entry.messages.slice(start, end);

    return {
      messages,
      total,
      hasMore: start > 0,
      offset,
      limit,
    };
  }

  evictChat(chatId) {
    this.#cacheByChatId.delete(String(chatId));
  }

  prune() {
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

  async #loadFromAgent(chatId) {
    const session = this.#registry.getChat(chatId);
    if (!session) return [];
    return this.#agents.loadMessages(session, chatId);
  }

}

function mergeChatMessages(base, incoming, options = {}) {
  return mergeChatMessagesByIdentity(base, incoming ?? [], options);
}

// Removes duplicate messages from a sorted array. Uses identity tokens
// (including content tokens) for dedup. Messages with no identity tokens
// (e.g. user messages without metadata) fall back to type+content+timestamp.
function deduplicateMessages(messages) {
  if (messages.length <= 1) return messages;
  const seen = new Set();
  const result = [];
  for (const message of messages) {
    const tokens = chatMessageIdentityTokens(message, { includeContentToken: true });
    if (tokens.length === 0) {
      // Fallback for messages with no identity tokens (user messages
      // without metadata). Dedup by type + content + timestamp.
      const type = message.type || '';
      const content = typeof message.content === 'string' ? message.content.trim() : '';
      const ts = message.timestamp || '';
      tokens.push(`${type}:fallback:${content}:${ts}`);
    }
    if (tokens.some((token) => seen.has(token))) continue;
    for (const token of tokens) seen.add(token);
    result.push(message);
  }
  return result;
}
