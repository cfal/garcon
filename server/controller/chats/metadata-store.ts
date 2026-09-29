// Persistent metadata index for chat list rendering. Ledger previews repair
// missing entries, while live appends keep latest preview text durable.

import { promises as fs } from 'fs';
import { writeJsonFileAtomic } from '../../common/json-file-store.ts';
import type { ChatMessage } from '../../../common/chat-types.js';
import type { CarryOverSegmentRef } from './store.js';
import type { ChatRegistryEntry, IChatRegistry } from './store.js';
import { createLogger } from '../../common/log.js';
import { errorMessage, hasNodeErrorCode } from '../../common/errors.js';
import { isRecord } from '../../../common/json.js';

const logger = createLogger('chats:metadata-store');

const DEFAULT_SAVE_DELAY_MS = 100;
const METADATA_VERSION = 1;
const DEFAULT_REPAIR_DEADLINE_MS = 30_000;

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
  repairDeadlineMs?: number;
}

interface MetadataTranscriptSource {
  getExistingTranscriptPreview(session: ChatRegistryEntry, chatId: string): {
    preview: unknown;
  } | null;
}

interface MetadataCarryOverSource {
  revision(refs: readonly CarryOverSegmentRef[], quarantine?: unknown): string;
}

export class MetadataIndex {
  #metadataByChatId = new Map<string, ChatMetadata>();
  #registry: IChatRegistry;
  #transcripts: MetadataTranscriptSource;
  #carryOver: MetadataCarryOverSource;
  #initialized = false;
  #metadataPath: string | null;
  #saveDelayMs: number;
  #repairDeadlineMs: number;
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
    this.#repairDeadlineMs = options.repairDeadlineMs ?? DEFAULT_REPAIR_DEADLINE_MS;
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
    return this.#metadataByChatId.get(String(chatId)) || null;
  }

  listAllChatMetadata(): Map<string, ChatMetadata> {
    return new Map(this.#metadataByChatId);
  }

  updateFromAppendedMessages(
    chatId: string,
    appendedMessages: ChatMessage[],
    identity?: ChatMetadataIdentity,
  ): void {
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
      ...(identity ?? current?.identity
        ? { identity: identity ?? current?.identity }
        : {}),
    });
    this.#scheduleSave();
  }

  // Recomputes the cached preview from the complete replacement view.
  replaceFromTranscriptView(
    chatId: string,
    messages: readonly ChatMessage[],
  ): void {
    const key = String(chatId);
    const current = this.#metadataByChatId.get(key);
    const firstMessage = firstUserText(messages) || current?.firstMessage || 'New Session';
    const createdAt = current?.createdAt ?? firstTimestamp(messages) ?? new Date().toISOString();
    const lastMessage = latestPreviewText(messages) ?? firstMessage;
    const lastActivity = latestTimestamp(messages) ?? createdAt;
    this.#metadataByChatId.set(key, {
      chatId: key,
      createdAt,
      lastActivity,
      lastMessage,
      firstMessage,
      source: 'live',
      ...(current?.identity ? { identity: current.identity } : {}),
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

  async #repairFromTranscriptPreviews(): Promise<void> {
    const started = performance.now();
    for (const chatId of this.#registry.listChatIds()) {
      // Timers cannot interrupt synchronous SQLite/JSON work. Yield between bounded reads.
      await Bun.sleep(0);
      if (this.#closed || performance.now() - started >= this.#repairDeadlineMs) break;
      const session = this.#registry.getChat(chatId);
      if (!session) continue;
      const existing = this.#metadataByChatId.get(String(chatId));
      if (existing && !this.#isCheaplyStale(existing, session)) continue;
      try {
        // Read and publish synchronously so no live update, deletion, or view replacement can interleave.
        const metadata = this.#buildMetadataFromPreview(chatId, session);
        if (metadata) {
          this.#metadataByChatId.set(chatId, metadata);
          this.#scheduleSave();
        }
      } catch (error) {
        logger.warn(`metadata: failed to build metadata for ${chatId}:`, errorMessage(error));
      }
    }
  }

  // Detects ownership and carryover changes without opening every ledger at startup.
  // Live transcript events keep view and ordinal identity current.
  #isCheaplyStale(entry: ChatMetadata, session: ChatRegistryEntry): boolean {
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
    const result = this.#transcripts.getExistingTranscriptPreview(session, chatId);
    if (!result) return null;
    const preview = result && isAgentPreviewMetadata(result.preview) ? result.preview : null;
    const refs = session.carryOverSegments ?? [];
    const firstMessage = preview?.firstMessage || '';
    if (!firstMessage) {
      throw new Error(`Failed to build preview for chat: ${chatId}`);
    }
    const createdAt = preview?.createdAt || null;
    return {
      chatId,
      createdAt,
      lastActivity: preview?.lastActivity || createdAt,
      lastMessage: preview?.lastMessage || firstMessage,
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

function normalizePersistedMetadata(chatId: string, value: unknown): ChatMetadata | null {
  if (!isRecord(value)) return null;
  const firstMessage = typeof value.firstMessage === 'string' ? value.firstMessage : '';
  if (!firstMessage) return null;
  const identity = normalizePersistedIdentity(value.identity);
  return {
    chatId,
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : null,
    lastActivity: typeof value.lastActivity === 'string' ? value.lastActivity : null,
    lastMessage: typeof value.lastMessage === 'string' ? value.lastMessage : firstMessage,
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

function extractPreviewText(msg: ChatMessage | null | undefined): string {
  if (!msg) return '';
  if (msg.type === 'user-message' || msg.type === 'assistant-message') {
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
