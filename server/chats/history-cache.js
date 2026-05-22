// Bounded in-memory cache of ChatMessage[] arrays by chatId. Entries may be
// full history loads or live tails captured before the user opens a chat.

const CACHE_LIMIT = 100;
const STALE_NON_ACTIVE_MS = 10 * 60 * 1000;
const PRUNE_INTERVAL_MS = 5 * 60 * 1000;
const MAX_MESSAGES_PER_ENTRY = 500;

export class HistoryCache {
  #cacheByChatId = new Map();
  #inFlightLoads = new Map();
  #pruneTimer = null;
  #initialized = false;
  #registry;
  #metadata;
  #providers;

  // registry: ChatRegistry
  // metadata: MetadataIndex
  // providers: ProviderRegistry
  constructor(registry, metadata, providers) {
    this.#registry = registry;
    this.#metadata = metadata;
    this.#providers = providers;
  }

  init() {
    if (!this.#initialized) {
      this.#initialized = true;

      // Evict cache entry when a chat is removed from registry.
      this.#registry.onChatRemoved((chatId) => this.evictChat(chatId));

      // Self-wire: append provider messages to cache as they arrive.
      this.#providers.onMessages((chatId, messages) => {
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
      const loaded = await this.#loadFromProvider(key);
      const current = this.#cacheByChatId.get(key);
      const liveTail = current?.completeness === 'tail' ? current.messages : [];
      const messages = trimTail(
        mergeChatMessages(loaded, liveTail, { dedupeUserProviderEchoes: true }),
        MAX_MESSAGES_PER_ENTRY,
      );
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

    entry.messages = trimTail(mergeChatMessages(entry.messages, appendedMessages), MAX_MESSAGES_PER_ENTRY);
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
      const active = this.#providers.isChatRunning(entry.chatId);
      if (active) continue;

      const isStale = now - entry.lastAccessAt > STALE_NON_ACTIVE_MS;
      const isOverLimit = this.#cacheByChatId.size > CACHE_LIMIT;

      if (isStale || isOverLimit) {
        this.#cacheByChatId.delete(entry.chatId);
      }
    }
  }

  async #loadFromProvider(chatId) {
    const session = this.#registry.getChat(chatId);
    if (!session) return [];
    return this.#providers.loadMessages(session);
  }

  // Exposed for tests that need to inspect/populate cache directly.
  get _cacheByChatId() { return this.#cacheByChatId; }
}

export { CACHE_LIMIT as _CACHE_LIMIT, STALE_NON_ACTIVE_MS as _STALE_NON_ACTIVE_MS, MAX_MESSAGES_PER_ENTRY as _MAX_MESSAGES_PER_ENTRY };

function trimTail(messages, maxMessages) {
  return messages.length > maxMessages ? messages.slice(-maxMessages) : messages;
}

function mergeChatMessages(base, incoming, options = {}) {
  const seen = new Set();
  const providerUserEchoTexts = new Set();
  const merged = [...base];
  for (const message of base) {
    rememberMessageIdentity(message, seen, providerUserEchoTexts);
  }
  for (const message of incoming ?? []) {
    const key = chatMessageIdentity(message);
    if (seen.has(key)) continue;
    if (options.dedupeUserProviderEchoes && hasClientUserIdentity(message)) {
      const text = userTextFingerprint(message);
      if (text && providerUserEchoTexts.has(text)) continue;
    }
    rememberMessageIdentity(message, seen, providerUserEchoTexts);
    merged.push(message);
  }
  return merged;
}

function rememberMessageIdentity(message, seen, providerUserEchoTexts) {
  seen.add(chatMessageIdentity(message));
  if (message?.type === 'user-message' && !hasClientUserIdentity(message)) {
    const text = userTextFingerprint(message);
    if (text) providerUserEchoTexts.add(text);
  }
}

function chatMessageIdentity(message) {
  if (!message || typeof message !== 'object') return 'unknown';
  if (typeof message.toolId === 'string' && message.toolId) {
    return `${message.type}:tool:${message.toolId}`;
  }
  if (message.type === 'user-message' && hasClientUserIdentity(message)) {
    return `${message.type}:client:${userClientIdentity(message)}`;
  }
  if (typeof message.content === 'string') {
    return `${message.type}:text:${message.content.trim()}`;
  }
  return `${message.type}:json:${JSON.stringify(message)}`;
}

function hasClientUserIdentity(message) {
  return userClientIdentity(message) !== null;
}

function userClientIdentity(message) {
  const metadata = message?.metadata && typeof message.metadata === 'object' ? message.metadata : {};
  const requestId = metadata.clientRequestId || metadata.messageId;
  return typeof requestId === 'string' && requestId ? requestId : null;
}

function userTextFingerprint(message) {
  return typeof message?.content === 'string' ? message.content.trim() : null;
}
