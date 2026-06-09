// Bounded in-memory cache of ChatMessage[] arrays by chatId. Entries may be
// full history loads or live tails captured before the user opens a chat.

import { mergeChatMessagesByIdentity } from '../../common/chat-message-identity.js';

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

  // registry: ChatRegistry
  // metadata: MetadataIndex
  // agents: AgentRegistry
  constructor(registry, metadata, agents) {
    this.#registry = registry;
    this.#metadata = metadata;
    this.#agents = agents;
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
    entry.lastAccessAt = Date.now();
    return entry.messages;
  }

  async ensureLoaded(chatId) {
    const key = String(chatId);
    const existing = this.#cacheByChatId.get(key);
    if (existing?.completeness === 'full') {
      existing.lastAccessAt = Date.now();
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
      this.#cacheByChatId.set(key, {
        chatId: key,
        messages,
        completeness: 'full',
        lastAccessAt: Date.now(),
      });
      return messages;
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
      entry = { chatId: key, messages: [], completeness: 'tail', lastAccessAt: Date.now() };
      this.#cacheByChatId.set(key, entry);
    }

    entry.messages = mergeChatMessages(entry.messages, appendedMessages);
    entry.lastAccessAt = Date.now();

    try {
      this.#metadata.updateFromAppendedMessages(key, appendedMessages);
    } catch (err) {
      console.warn(`history-cache: metadata update failed for ${key}:`, err.message);
    }

    if (this.#cacheByChatId.size > CACHE_LIMIT) {
      this.prune();
    }
  }

  getPaginatedMessages(chatId, limit, offset) {
    const key = String(chatId);
    const entry = this.#cacheByChatId.get(key);
    if (!entry) {
      return { messages: [], total: 0, hasMore: false, offset, limit };
    }

    entry.lastAccessAt = Date.now();

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
    const now = Date.now();
    const entries = Array.from(this.#cacheByChatId.values())
      .sort((a, b) => a.lastAccessAt - b.lastAccessAt);

    for (const entry of entries) {
      const active = this.#agents.isChatRunning(entry.chatId);
      if (active) continue;

      const isStale = now - entry.lastAccessAt > STALE_NON_ACTIVE_MS;
      const isOverLimit = this.#cacheByChatId.size > CACHE_LIMIT;

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

  // Exposed for tests that need to inspect/populate cache directly.
  get _cacheByChatId() { return this.#cacheByChatId; }
}

export { CACHE_LIMIT as _CACHE_LIMIT, STALE_NON_ACTIVE_MS as _STALE_NON_ACTIVE_MS };

function mergeChatMessages(base, incoming, options = {}) {
  return mergeChatMessagesByIdentity(base, incoming ?? [], options);
}
