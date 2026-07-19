// Persistent metadata index for chat list rendering. Agent previews repair
// missing entries, while live appends keep latest preview text durable.

import { promises as fs } from 'fs';
import { writeJsonFileAtomic } from '../lib/json-file-store.ts';
import type { ChatMessage } from '../../common/chat-types.js';
import type { ChatRegistryEntry, IChatRegistry } from './store.js';
import { createLogger } from '../lib/log.js';
import { errorMessage, hasNodeErrorCode } from '../lib/errors.js';

const logger = createLogger('chats:metadata-store');

const DEFAULT_PREVIEW_TIMEOUT_MS = 5_000;
const DEFAULT_SAVE_DELAY_MS = 100;
const METADATA_VERSION = 1;

type MetadataSource = 'live' | 'agent-preview' | 'startup';

export interface ChatMetadata {
  chatId: string;
  createdAt: string | null;
  lastActivity: string | null;
  lastMessage: string;
  firstMessage: string;
  source: MetadataSource;
}

interface AgentPreviewMetadata {
  createdAt?: string | null;
  lastActivity?: string | null;
  lastMessage?: string | null;
  firstMessage: string;
}

interface MetadataIndexOptions {
  previewTimeoutMs?: number;
  metadataPath?: string | null;
  saveDelayMs?: number;
}

interface MetadataAgentSource {
  getPreview(session: ChatRegistryEntry, chatId: string): Promise<unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export class MetadataIndex {
  #metadataByChatId = new Map<string, ChatMetadata>();
  #registry: IChatRegistry;
  #agents: MetadataAgentSource;
  #initialized = false;
  #previewTimeoutMs: number;
  #metadataPath: string | null;
  #saveDelayMs: number;
  #pendingSaveTimer: ReturnType<typeof setTimeout> | null = null;
  #savePromise: Promise<void> = Promise.resolve();

  constructor(registry: IChatRegistry, agents: MetadataAgentSource, options: MetadataIndexOptions = {}) {
    this.#registry = registry;
    this.#agents = agents;
    this.#previewTimeoutMs = options.previewTimeoutMs ?? DEFAULT_PREVIEW_TIMEOUT_MS;
    this.#metadataPath = options.metadataPath ?? null;
    this.#saveDelayMs = options.saveDelayMs ?? DEFAULT_SAVE_DELAY_MS;
  }

  async init(): Promise<void> {
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

  getChatMetadata(chatId: string): ChatMetadata | null {
    return this.#metadataByChatId.get(String(chatId)) || null;
  }

  listAllChatMetadata(): Map<string, ChatMetadata> {
    return new Map(this.#metadataByChatId);
  }

  updateFromAppendedMessages(chatId: string, appendedMessages: ChatMessage[]): void {
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

  addNewChatMetadata(chatId: string, firstMessage: string): void {
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

  async flush(): Promise<void> {
    if (this.#pendingSaveTimer) {
      clearTimeout(this.#pendingSaveTimer);
      this.#pendingSaveTimer = null;
    }
    this.#savePromise = this.#savePromise
      .catch(() => undefined)
      .then(() => this.#saveNow());
    await this.#savePromise;
  }

  async #repairMissingMetadataFromAgentPreviews(): Promise<void> {
    const sessions = this.#registry.listAllChats();
    const missingEntries = Object.entries(sessions)
      .filter(([chatId]) => !this.#metadataByChatId.has(String(chatId)));

    const results = await Promise.allSettled(
      missingEntries.map(([chatId, session]) => this.#buildMetadataFromPreviewWithTimeout(chatId, session)),
    );

    for (let i = 0; i < results.length; i++) {
      const [chatId] = missingEntries[i];
      const result = results[i];
      if (result.status === 'fulfilled') {
        this.#metadataByChatId.set(String(chatId), result.value);
      } else {
        logger.warn(`metadata: failed to build metadata for ${chatId}:`, errorMessage(result.reason));
      }
    }
  }

  async #buildMetadataFromPreviewWithTimeout(
    chatId: string,
    session: ChatRegistryEntry,
  ): Promise<ChatMetadata> {
    return withTimeout(
      this.#buildMetadataFromPreview(chatId, session),
      this.#previewTimeoutMs,
      () => new Error(`Timed out building preview for chat ${chatId} after ${this.#previewTimeoutMs}ms`),
    );
  }

  async #buildMetadataFromPreview(chatId: string, session: ChatRegistryEntry): Promise<ChatMetadata> {
    const preview = await this.#agents.getPreview(session, chatId);
    if (!isAgentPreviewMetadata(preview)) {
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

  #pruneMissingRegistryEntries(): void {
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

  async #loadPersistedMetadata(): Promise<Map<string, ChatMetadata>> {
    const result = new Map<string, ChatMetadata>();
    if (!this.#metadataPath) return result;
    try {
      const raw = await fs.readFile(this.#metadataPath, 'utf8');
      const parsed = JSON.parse(raw);
      const chats = isRecord(parsed) ? parsed.chats : null;
      if (!chats || typeof chats !== 'object' || Array.isArray(chats)) return result;
      for (const [chatId, value] of Object.entries(chats)) {
        const normalized = normalizePersistedMetadata(chatId, value);
        if (normalized) result.set(chatId, normalized);
      }
    } catch (error) {
      if (!hasNodeErrorCode(error, 'ENOENT')) {
        logger.warn('metadata: failed to load chat metadata:', errorMessage(error));
      }
    }
    return result;
  }

  #scheduleSave(): void {
    if (!this.#metadataPath) return;
    if (this.#pendingSaveTimer) clearTimeout(this.#pendingSaveTimer);
    this.#pendingSaveTimer = setTimeout(() => {
      this.#pendingSaveTimer = null;
      this.#savePromise = this.#savePromise
        .catch(() => undefined)
        .then(() => this.#saveNow());
    }, this.#saveDelayMs);
  }

  async #saveNow(): Promise<void> {
    if (!this.#metadataPath) return;
    const snapshot = {
      version: METADATA_VERSION,
      chats: Object.fromEntries(this.#metadataByChatId),
    };
    await writeJsonFileAtomic(this.#metadataPath, snapshot);
  }
}

function isAgentPreviewMetadata(value: unknown): value is AgentPreviewMetadata {
  return isRecord(value) && typeof value.firstMessage === 'string';
}

function normalizePersistedMetadata(chatId: string, value: unknown): ChatMetadata | null {
  if (!isRecord(value)) return null;
  const firstMessage = typeof value.firstMessage === 'string' ? value.firstMessage : '';
  if (!firstMessage) return null;
  return {
    chatId,
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : null,
    lastActivity: typeof value.lastActivity === 'string' ? value.lastActivity : null,
    lastMessage: typeof value.lastMessage === 'string' ? value.lastMessage : firstMessage,
    firstMessage,
    source: isMetadataSource(value.source)
      ? value.source
      : 'startup',
  };
}

function isMetadataSource(value: unknown): value is MetadataSource {
  return value === 'live' || value === 'agent-preview' || value === 'startup';
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, createTimeoutError: () => Error): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout>;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(createTimeoutError()), timeoutMs);
  });
  return Promise.race([
    promise.finally(() => clearTimeout(timeoutId)),
    timeout,
  ]) as Promise<T>;
}

function extractPreviewText(msg: ChatMessage | null | undefined): string {
  if (!msg) return '';
  if (msg.type === 'user-message' || msg.type === 'assistant-message') {
    const content = typeof msg.content === 'string' ? msg.content : '';
    return content;
  }
  return '';
}

function firstTimestamp(messages: ChatMessage[]): string | null {
  for (const msg of messages ?? []) {
    if (typeof msg?.timestamp === 'string') return msg.timestamp;
  }
  return null;
}

function latestTimestamp(messages: ChatMessage[]): string | null {
  let latest: string | null = null;
  for (const msg of messages ?? []) {
    if (typeof msg?.timestamp === 'string' && (!latest || msg.timestamp > latest)) {
      latest = msg.timestamp;
    }
  }
  return latest;
}

function firstUserText(messages: ChatMessage[]): string | null {
  for (const msg of messages ?? []) {
    if (msg?.type !== 'user-message') continue;
    const text = extractPreviewText(msg);
    if (text) return text;
  }
  return null;
}

function latestPreviewText(messages: ChatMessage[]): string | null {
  let latest: string | null = null;
  for (const msg of messages ?? []) {
    const text = extractPreviewText(msg);
    if (text) latest = text;
  }
  return latest;
}
