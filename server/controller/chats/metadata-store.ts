// Persisted previews remain hidden until paced repair validates their ledger view.
// Live appends and synchronous replacement invalidation keep list reads memory-only.

import { promises as fs } from 'fs';
import { writeJsonFileAtomic } from '../../common/json-file-store.ts';
import { parseStoredJson } from '../../common/stored-json.js';
import type { ChatMessage } from '../../../common/chat-types.js';
import type { CarryOverSegmentRef } from './registry-contracts.js';
import type { IChatRegistry } from './store.js';
import type { ChatRegistryEntry } from './registry-contracts.js';
import { createLogger } from '../../common/log.js';
import { errorMessage, hasNodeErrorCode } from '../../common/errors.js';
import { isRecord } from '../../../common/json.js';
import { EventLoopSteps } from '@garcon/server-agent-common/shared/event-loop';

const logger = createLogger('chats:metadata-store');

// Coalesces the saves of chats that stream at the same time; like chats.json, the file
// is rewritten whole.
const DEFAULT_SAVE_DELAY_MS = 1000;
const METADATA_VERSION = 1;
// Titles and list previews show only a first line, but the whole preview is kept for every
// chat and rewritten on each save, so both are capped. The first message keeps enough for
// the chat details dialog.
const FIRST_MESSAGE_PREVIEW_CHARS = 4096;
const LAST_MESSAGE_PREVIEW_CHARS = 512;

type MetadataSource = 'live' | 'agent-preview' | 'startup';

// Composite content identity the cached preview was produced from. Ownership,
// carryover, or ledger-content changes make the cache stale; control,
// terminal, native-retention, and process-generation changes do not.
export interface ChatMetadataIdentity {
  carryOverRevision: string;
  agentOwnershipEpoch: string;
}

export interface ChatMetadata {
  chatId: string;
  transcriptViewId: string | null;
  createdAt: string | null;
  lastActivity: string | null;
  lastMessage: string;
  firstMessage: string;
  source: MetadataSource;
  identity?: ChatMetadataIdentity;
}

interface AgentPreviewMetadata {
  createdAt?: string | null;
  lastActivity?: string | null;
  lastMessage?: string | null;
  firstMessage: string;
}

interface MetadataIndexOptions {
  metadataPath?: string | null;
  saveDelayMs?: number;
}

interface MetadataTranscriptSource {
  getExistingTranscriptViewId(chatId: string): string | null;
  getExistingTranscriptPreview(session: ChatRegistryEntry, chatId: string): {
    preview: unknown;
  } | null;
}

interface MetadataCarryOverSource {
  revision(refs: readonly CarryOverSegmentRef[], quarantine?: unknown): string;
}

export class MetadataIndex {
  #metadataByChatId = new Map<string, ChatMetadata>();
  #validatedChatIds = new Set<string>();
  #registry: IChatRegistry;
  #transcripts: MetadataTranscriptSource;
  #carryOver: MetadataCarryOverSource;
  #initialized = false;
  #metadataPath: string | null;
  #saveDelayMs: number;
  #repairPromise: Promise<void> | null = null;
  #closed = false;
  #pendingSaveTimer: ReturnType<typeof setTimeout> | null = null;
  #savePromise: Promise<void> = Promise.resolve();

  constructor(
    registry: IChatRegistry,
    transcripts: MetadataTranscriptSource,
    carryOver: MetadataCarryOverSource,
    options: MetadataIndexOptions = {},
  ) {
    this.#registry = registry;
    this.#transcripts = transcripts;
    this.#carryOver = carryOver;
    this.#metadataPath = options.metadataPath ?? null;
    this.#saveDelayMs = options.saveDelayMs ?? DEFAULT_SAVE_DELAY_MS;
  }

  async init(): Promise<void> {
    if (!this.#initialized) {
      this.#initialized = true;
      this.#registry.onChatRemoved((chatId) => {
        this.#metadataByChatId.delete(String(chatId));
        this.#validatedChatIds.delete(String(chatId));
        this.#scheduleSave();
      });
    }

    this.#metadataByChatId = await this.#loadPersistedMetadata();
    this.#validatedChatIds.clear();
    this.#pruneMissingRegistryEntries();
    this.#scheduleSave();
  }

  repair(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    this.#repairPromise ??= this.#repairFromTranscriptPreviews().finally(() => {
      this.#repairPromise = null;
    });
    return this.#repairPromise;
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.#repairPromise;
  }

  getChatMetadata(chatId: string): ChatMetadata | null {
    const key = String(chatId);
    return this.#validatedChatIds.has(key) ? this.#metadataByChatId.get(key) ?? null : null;
  }

  invalidateTranscriptView(chatId: string): void {
    this.#validatedChatIds.delete(String(chatId));
  }

  listAllChatMetadata(): Map<string, ChatMetadata> {
    const entries = new Map<string, ChatMetadata>();
    for (const chatId of this.#metadataByChatId.keys()) {
      const metadata = this.getChatMetadata(chatId);
      if (metadata) entries.set(chatId, metadata);
    }
    return entries;
  }

  updateFromAppendedMessages(
    chatId: string,
    transcriptViewId: string,
    appendedMessages: ChatMessage[],
    identity?: ChatMetadataIdentity,
  ): void {
    const key = String(chatId);
    if (this.#transcripts.getExistingTranscriptViewId(key) !== transcriptViewId) return;
    const cached = this.#metadataByChatId.get(key);
    let current = cached?.transcriptViewId === transcriptViewId ? cached : null;
    if (cached && !this.#validatedChatIds.has(key)) {
      const session = this.#registry.getChat(key);
      if (!session) return;
      current = this.#repairChatMetadata(key, session);
      // A live suffix cannot establish the first input missing from a cold preview.
      if (!current) return;
    }
    const createdAt = current?.createdAt ?? firstTimestamp(appendedMessages) ?? new Date().toISOString();
    const firstMessage = current?.firstMessage || firstMessagePreview(firstUserText(appendedMessages));
    const lastMessage = lastMessagePreview(latestPreviewText(appendedMessages) ?? current?.lastMessage ?? firstMessage);
    const lastActivity = latestTimestamp(appendedMessages) ?? current?.lastActivity ?? createdAt;

    this.#metadataByChatId.set(key, {
      chatId: key,
      transcriptViewId,
      createdAt,
      lastActivity,
      lastMessage,
      firstMessage,
      source: 'live',
      ...(identity ?? current?.identity
        ? { identity: identity ?? current?.identity }
        : {}),
    });
    this.#validatedChatIds.add(key);
    this.#scheduleSave();
  }

  // Recomputes the cached preview from the complete replacement view.
  async replaceFromTranscriptView(
    chatId: string,
    transcriptViewId: string,
    pages: AsyncIterable<readonly ChatMessage[]>,
  ): Promise<void> {
    let firstMessage = '';
    let firstAt: string | null = null;
    let lastText: string | null = null;
    let lastAt: string | null = null;
    const steps = new EventLoopSteps('replacement-metadata');
    for await (const messages of pages) {
      for (const message of messages) {
        const text = extractPreviewText(message);
        if (!firstMessage && message.type === 'user-message') firstMessage = firstMessagePreview(text);
        if (text) lastText = lastMessagePreview(text);
        if (typeof message.timestamp === 'string') {
          firstAt ??= message.timestamp;
          if (!lastAt || message.timestamp > lastAt) lastAt = message.timestamp;
        }
        if (steps.due) await steps.next();
      }
    }
    const key = String(chatId);
    if (this.#transcripts.getExistingTranscriptViewId(key) !== transcriptViewId) return;
    const current = this.#metadataByChatId.get(key);
    const createdAt = current?.createdAt ?? firstAt ?? new Date().toISOString();
    const lastMessage = lastText ?? lastMessagePreview(firstMessage);
    const lastActivity = lastAt ?? createdAt;
    this.#metadataByChatId.set(key, {
      chatId: key,
      transcriptViewId,
      createdAt,
      lastActivity,
      lastMessage,
      firstMessage,
      source: 'live',
      ...(current?.identity ? { identity: current.identity } : {}),
    });
    this.#validatedChatIds.add(key);
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
      transcriptViewId: this.#transcripts.getExistingTranscriptViewId(key),
      createdAt,
      lastActivity: createdAt,
      lastMessage: lastMessagePreview(firstMessage),
      firstMessage: firstMessagePreview(firstMessage),
      source: 'startup',
    });
    this.#validatedChatIds.add(key);
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

  async #repairFromTranscriptPreviews(): Promise<void> {
    for (const chatId of this.#registry.listChatIds()) {
      // Timers cannot interrupt synchronous SQLite/JSON work. Yield between bounded reads.
      await Bun.sleep(0);
      if (this.#closed) break;
      const session = this.#registry.getChat(chatId);
      if (!session) continue;
      this.#repairChatMetadata(chatId, session);
    }
  }

  #repairChatMetadata(chatId: string, session: ChatRegistryEntry): ChatMetadata | null {
    const existing = this.#metadataByChatId.get(chatId);
    try {
      if (existing?.firstMessage && !this.#isStale(existing, session)) {
        this.#validatedChatIds.add(chatId);
        return existing;
      }
      // Read and publish synchronously so no live update, deletion, or view replacement can interleave.
      const metadata = this.#buildMetadataFromPreview(chatId, session);
      if (!metadata) return null;
      this.#metadataByChatId.set(chatId, metadata);
      this.#validatedChatIds.add(chatId);
      this.#scheduleSave();
      return metadata;
    } catch (error) {
      logger.warn(`metadata: failed to build metadata for ${chatId}:`, errorMessage(error));
      return null;
    }
  }

  #isStale(entry: ChatMetadata, session: ChatRegistryEntry): boolean {
    const viewId = this.#transcripts.getExistingTranscriptViewId(entry.chatId);
    if (viewId && entry.transcriptViewId !== viewId) return true;
    const identity = entry.identity;
    if (!identity) return false;
    if (identity.agentOwnershipEpoch !== session.agentOwnershipEpoch) return true;
    const carryOverRevision = this.#carryOver.revision(
      session.carryOverSegments ?? [],
      session.carryOverMigrationQuarantine,
    );
    if (identity.carryOverRevision !== carryOverRevision) return true;
    return false;
  }

  #buildMetadataFromPreview(chatId: string, session: ChatRegistryEntry): ChatMetadata | null {
    const transcriptViewId = this.#transcripts.getExistingTranscriptViewId(chatId);
    const result = this.#transcripts.getExistingTranscriptPreview(session, chatId);
    if (!result) return null;
    const preview = isAgentPreviewMetadata(result.preview) ? result.preview : null;
    const refs = session.carryOverSegments ?? [];
    const firstMessage = firstMessagePreview(preview?.firstMessage);
    const createdAt = preview?.createdAt || null;
    return {
      chatId,
      transcriptViewId,
      createdAt,
      lastActivity: preview?.lastActivity || createdAt,
      lastMessage: lastMessagePreview(preview?.lastMessage || firstMessage),
      firstMessage,
      source: 'agent-preview',
      identity: {
        carryOverRevision: this.#carryOver.revision(refs, session.carryOverMigrationQuarantine),
        agentOwnershipEpoch: session.agentOwnershipEpoch,
      },
    };
  }

  #pruneMissingRegistryEntries(): void {
    const validIds = new Set(this.#registry.listChatIds().map(String));
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
      if (process.platform !== 'win32') {
        await fs.chmod(this.#metadataPath, 0o600).catch((error) => {
          logger.warn('metadata: failed to repair chat-metadata.json permissions:', errorMessage(error));
        });
      }
      const parsed = parseStoredJson(raw, 'chat-metadata.json');
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
    await writeJsonFileAtomic(this.#metadataPath, snapshot, { mode: 0o600 });
  }
}

function isAgentPreviewMetadata(value: unknown): value is AgentPreviewMetadata {
  return isRecord(value) && typeof value.firstMessage === 'string';
}

function normalizePersistedIdentity(value: unknown): ChatMetadataIdentity | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.carryOverRevision !== 'string' || typeof value.agentOwnershipEpoch !== 'string') {
    return undefined;
  }
  return {
    carryOverRevision: value.carryOverRevision,
    agentOwnershipEpoch: value.agentOwnershipEpoch,
  };
}

// Caps previews written before they were bounded, so the next save shrinks the file.
function normalizePersistedMetadata(chatId: string, value: unknown): ChatMetadata | null {
  if (!isRecord(value) || typeof value.firstMessage !== 'string') return null;
  const firstMessage = firstMessagePreview(value.firstMessage);
  const identity = normalizePersistedIdentity(value.identity);
  return {
    chatId,
    transcriptViewId: typeof value.transcriptViewId === 'string' ? value.transcriptViewId : null,
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : null,
    lastActivity: typeof value.lastActivity === 'string' ? value.lastActivity : null,
    lastMessage: lastMessagePreview(typeof value.lastMessage === 'string' ? value.lastMessage : firstMessage),
    firstMessage,
    source: isMetadataSource(value.source)
      ? value.source
      : 'startup',
    ...(identity ? { identity } : {}),
  };
}

function isMetadataSource(value: unknown): value is MetadataSource {
  return value === 'live' || value === 'agent-preview' || value === 'startup';
}

function firstMessagePreview(text: string | null | undefined): string {
  return boundedPreview(text ?? '', FIRST_MESSAGE_PREVIEW_CHARS);
}

function lastMessagePreview(text: string): string {
  return boundedPreview(text, LAST_MESSAGE_PREVIEW_CHARS);
}

// Keeps a surrogate pair whole and marks the cut with an ellipsis.
function boundedPreview(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const end = /[\uD800-\uDBFF]/.test(text[maxChars - 1]!) ? maxChars - 1 : maxChars;
  return `${text.slice(0, end)}\u2026`;
}

function extractPreviewText(msg: ChatMessage | null | undefined): string {
  if (!msg) return '';
  if (msg.type === 'user-message' || msg.type === 'assistant-message' || msg.type === 'command-output') {
    const content = typeof msg.content === 'string' ? msg.content : '';
    return content;
  }
  return '';
}

function firstTimestamp(messages: readonly ChatMessage[]): string | null {
  for (const msg of messages ?? []) {
    if (typeof msg?.timestamp === 'string') return msg.timestamp;
  }
  return null;
}

function latestTimestamp(messages: readonly ChatMessage[]): string | null {
  let latest: string | null = null;
  for (const msg of messages ?? []) {
    if (typeof msg?.timestamp === 'string' && (!latest || msg.timestamp > latest)) {
      latest = msg.timestamp;
    }
  }
  return latest;
}

function firstUserText(messages: readonly ChatMessage[]): string | null {
  for (const msg of messages ?? []) {
    if (msg?.type !== 'user-message') continue;
    const text = extractPreviewText(msg);
    if (text) return text;
  }
  return null;
}

// Scans from the newest message, which is the one kept, so a whole view costs
// no more than its tail.
function latestPreviewText(messages: readonly ChatMessage[]): string | null {
  for (let index = (messages?.length ?? 0) - 1; index >= 0; index -= 1) {
    const text = extractPreviewText(messages[index]);
    if (text) return text;
  }
  return null;
}
