// In-memory metadata index for chat list rendering. Hydrated at startup
// from the registry via ProviderRegistry.getPreview(). Updated on live
// append via history-cache.

export class MetadataIndex {
  #metadataByChatId = new Map();
  #registry;
  #providers;
  #initialized = false;

  // registry: ChatRegistry
  // providers: ProviderRegistry
  constructor(registry, providers) {
    this.#registry = registry;
    this.#providers = providers;
  }

  async init() {
    if (!this.#initialized) {
      this.#initialized = true;
      this.#registry.onChatRemoved((chatId) => this.#metadataByChatId.delete(chatId));
    }

    this.#metadataByChatId.clear();
    const sessions = this.#registry.listAllChats();

    const entries = Object.entries(sessions);
    const results = await Promise.allSettled(
      entries.map(([chatId, session]) => this.#buildMetadataFromPreview(chatId, session)),
    );

    for (let i = 0; i < results.length; i++) {
      const [chatId] = entries[i];
      if (results[i].status === 'fulfilled') {
        this.#metadataByChatId.set(chatId, results[i].value);
      } else {
        console.warn(`metadata: failed to build metadata for ${chatId}:`, results[i].reason?.message);
      }
    }
  }

  getChatMetadata(chatId) {
    return this.#metadataByChatId.get(chatId) || null;
  }

  listAllChatMetadata() {
    return new Map(this.#metadataByChatId);
  }

  updateFromAppendedMessages(chatId, appendedMessages) {
    const key = String(chatId);
    const current = this.#metadataByChatId.get(key);
    if (!current) {
      console.warn(`metadata: no entry for chat ${chatId}, skipping update`);
      return;
    }

    let nextLastActivity = current.lastActivity;
    let nextLastMessage = current.lastMessage;

    for (const msg of appendedMessages) {
      if (msg.timestamp && (!nextLastActivity || msg.timestamp > nextLastActivity)) {
        nextLastActivity = msg.timestamp;
      }

      const text = extractPreviewText(msg);
      if (text) {
        nextLastMessage = text;
      }
    }

    this.#metadataByChatId.set(key, {
      ...current,
      lastActivity: nextLastActivity,
      lastMessage: nextLastMessage,
    });
  }

  addNewChatMetadata(chatId, firstMessage) {
    if (this.#metadataByChatId.has(chatId)) {
      throw new Error(`Chat with ID ${chatId} already exists`);
    }
    const createdAt = new Date().toISOString();
    this.#metadataByChatId.set(chatId, {
      chatId: chatId,
      createdAt,
      lastActivity: createdAt,
      lastMessage: firstMessage,
      firstMessage,
    });
  }

  async #buildMetadataFromPreview(chatId, session) {
    const preview = await this.#providers.getPreview(session);
    if (!preview) {
      throw new Error(`Failed to build preview for chat: ${chatId}`);
    }
    if (!preview.firstMessage) {
      throw new Error(`Missing first message for chat: ${chatId}`);
    }
    return {
      chatId,
      createdAt: preview.createdAt || null,
      lastActivity: preview.lastActivity || null,
      lastMessage: preview.lastMessage || '',
      firstMessage: preview.firstMessage,
    };
  }
}

function extractPreviewText(msg) {
  if (!msg) return '';
  if (msg.type === 'user-message' || msg.type === 'assistant-message') {
    const content = typeof msg.content === 'string' ? msg.content : '';
    return content;
  }
  return '';
}
