// Persistent metadata index for chat list rendering. Agent previews repair
// missing entries, while live appends keep latest preview text durable.

import { promises as fs } from 'fs';
import { writeJsonFileAtomic } from '../lib/json-file-store.ts';

const DEFAULT_PREVIEW_TIMEOUT_MS = 5_000;
const DEFAULT_SAVE_DELAY_MS = 100;
const METADATA_VERSION = 1;

export class MetadataIndex {
  #metadataByChatId = new Map();
  #registry;
  #agents;
  #initialized = false;
  #previewTimeoutMs;
  #metadataPath;
  #saveDelayMs;
  #pendingSaveTimer = null;
  #savePromise = Promise.resolve();

  // registry: ChatRegistry
  // agents: AgentRegistry
  constructor(registry, agents, options = {}) {
    this.#registry = registry;
    this.#agents = agents;
    this.#previewTimeoutMs = options.previewTimeoutMs ?? DEFAULT_PREVIEW_TIMEOUT_MS;
    this.#metadataPath = options.metadataPath ?? null;
    this.#saveDelayMs = options.saveDelayMs ?? DEFAULT_SAVE_DELAY_MS;
  }

  async init() {
    if (!this.#initialized) {
      this.#initialized = true;
      this.#registry.onChatRemoved((chatId) => {
        this.#metadataByChatId.delete(String(chatId));
        this.#scheduleSave();
      });
    }

    this.#metadataByChatId = await this.#loadPersistedMetadata();
    this.#pruneMissingRegistryEntries();
    await this.#repairMissingMetadataFromAgentPreviews();
    this.#pruneMissingRegistryEntries();
    this.#scheduleSave();
  }

  getChatMetadata(chatId) {
    return this.#metadataByChatId.get(String(chatId)) || null;
  }

  listAllChatMetadata() {
    return new Map(this.#metadataByChatId);
  }

  updateFromAppendedMessages(chatId, appendedMessages) {
    const key = String(chatId);
    const current = this.#metadataByChatId.get(key);
    const createdAt = current?.createdAt ?? firstTimestamp(appendedMessages) ?? new Date().toISOString();
    const firstMessage = current?.firstMessage || firstUserText(appendedMessages) || 'New Session';
    const lastMessage = latestPreviewText(appendedMessages) ?? current?.lastMessage ?? firstMessage;
    const lastActivity = latestTimestamp(appendedMessages) ?? current?.lastActivity ?? createdAt;

    this.#metadataByChatId.set(key, {
      chatId: key,
      createdAt,
      lastActivity,
      lastMessage,
      firstMessage,
      source: 'live',
    });
    this.#scheduleSave();
  }

  addNewChatMetadata(chatId, firstMessage) {
    const key = String(chatId);
    if (this.#metadataByChatId.has(key)) {
      throw new Error(`Chat with ID ${chatId} already exists`);
    }
    const createdAt = new Date().toISOString();
    this.#metadataByChatId.set(key, {
      chatId: key,
      createdAt,
      lastActivity: createdAt,
      lastMessage: firstMessage,
      firstMessage,
      source: 'startup',
    });
    this.#scheduleSave();
  }

  async flush() {
    if (this.#pendingSaveTimer) {
      clearTimeout(this.#pendingSaveTimer);
      this.#pendingSaveTimer = null;
    }
    this.#savePromise = this.#savePromise
      .catch(() => undefined)
      .then(() => this.#saveNow());
    await this.#savePromise;
  }

  async #repairMissingMetadataFromAgentPreviews() {
    const sessions = this.#registry.listAllChats();
    const missingEntries = Object.entries(sessions)
      .filter(([chatId]) => !this.#metadataByChatId.has(String(chatId)));

    const results = await Promise.allSettled(
      missingEntries.map(([chatId, session]) => this.#buildMetadataFromPreviewWithTimeout(chatId, session)),
    );

    for (let i = 0; i < results.length; i++) {
      const [chatId] = missingEntries[i];
      if (results[i].status === 'fulfilled') {
        this.#metadataByChatId.set(String(chatId), results[i].value);
      } else {
        console.warn(`metadata: failed to build metadata for ${chatId}:`, results[i].reason?.message);
      }
    }
  }

  async #buildMetadataFromPreviewWithTimeout(chatId, session) {
    return withTimeout(
      this.#buildMetadataFromPreview(chatId, session),
      this.#previewTimeoutMs,
      () => new Error(`Timed out building preview for chat ${chatId} after ${this.#previewTimeoutMs}ms`),
    );
  }

  async #buildMetadataFromPreview(chatId, session) {
    const preview = await this.#agents.getPreview(session);
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
      lastMessage: preview.lastMessage || preview.firstMessage || '',
      firstMessage: preview.firstMessage,
      source: 'agent-preview',
    };
  }

  #pruneMissingRegistryEntries() {
    const sessions = this.#registry.listAllChats();
    const validIds = new Set(Object.keys(sessions).map(String));
    let dirty = false;
    for (const chatId of this.#metadataByChatId.keys()) {
      if (validIds.has(chatId)) continue;
      this.#metadataByChatId.delete(chatId);
      dirty = true;
    }
    if (dirty) this.#scheduleSave();
  }

  async #loadPersistedMetadata() {
    const result = new Map();
    if (!this.#metadataPath) return result;
    try {
      const raw = await fs.readFile(this.#metadataPath, 'utf8');
      const parsed = JSON.parse(raw);
      const chats = parsed && typeof parsed === 'object' ? parsed.chats : null;
      if (!chats || typeof chats !== 'object' || Array.isArray(chats)) return result;
      for (const [chatId, value] of Object.entries(chats)) {
        const normalized = normalizePersistedMetadata(chatId, value);
        if (normalized) result.set(chatId, normalized);
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        console.warn('metadata: failed to load chat metadata:', error.message);
      }
    }
    return result;
  }

  #scheduleSave() {
    if (!this.#metadataPath) return;
    if (this.#pendingSaveTimer) clearTimeout(this.#pendingSaveTimer);
    this.#pendingSaveTimer = setTimeout(() => {
      this.#pendingSaveTimer = null;
      this.#savePromise = this.#savePromise
        .catch(() => undefined)
        .then(() => this.#saveNow());
    }, this.#saveDelayMs);
  }

  async #saveNow() {
    if (!this.#metadataPath) return;
    const snapshot = {
      version: METADATA_VERSION,
      chats: Object.fromEntries(this.#metadataByChatId),
    };
    await writeJsonFileAtomic(this.#metadataPath, snapshot);
  }
}

function normalizePersistedMetadata(chatId, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const firstMessage = typeof value.firstMessage === 'string' ? value.firstMessage : '';
  if (!firstMessage) return null;
  return {
    chatId,
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : null,
    lastActivity: typeof value.lastActivity === 'string' ? value.lastActivity : null,
    lastMessage: typeof value.lastMessage === 'string' ? value.lastMessage : firstMessage,
    firstMessage,
    source: value.source === 'live' || value.source === 'agent-preview' || value.source === 'startup'
      ? value.source
      : 'startup',
  };
}

function withTimeout(promise, timeoutMs, createTimeoutError) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(createTimeoutError()), timeoutMs);
  });
  return Promise.race([
    promise.finally(() => clearTimeout(timeoutId)),
    timeout,
  ]);
}

function extractPreviewText(msg) {
  if (!msg) return '';
  if (msg.type === 'user-message' || msg.type === 'assistant-message') {
    const content = typeof msg.content === 'string' ? msg.content : '';
    return content;
  }
  return '';
}

function firstTimestamp(messages) {
  for (const msg of messages ?? []) {
    if (typeof msg?.timestamp === 'string') return msg.timestamp;
  }
  return null;
}

function latestTimestamp(messages) {
  let latest = null;
  for (const msg of messages ?? []) {
    if (typeof msg?.timestamp === 'string' && (!latest || msg.timestamp > latest)) {
      latest = msg.timestamp;
    }
  }
  return latest;
}

function firstUserText(messages) {
  for (const msg of messages ?? []) {
    if (msg?.type !== 'user-message') continue;
    const text = extractPreviewText(msg);
    if (text) return text;
  }
  return null;
}

function latestPreviewText(messages) {
  let latest = null;
  for (const msg of messages ?? []) {
    const text = extractPreviewText(msg);
    if (text) latest = text;
  }
  return latest;
}
