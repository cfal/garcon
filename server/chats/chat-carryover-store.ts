// Durable snapshot of prior-agent transcripts for cross-agent continuation.
// A switch persists the outgoing agent's rendered ChatMessage[] as a segment so
// the conversation stays visible on reload even though the new native session
// starts empty. Segments accumulate in order across repeated switches.

import { promises as fs } from 'fs';
import { writeJsonFileAtomic } from '../lib/json-file-store.js';
import type { ChatMessage } from '../../common/chat-types.js';
import { AgentSwitchMessage, parseChatMessages } from '../../common/chat-types.js';
import type { IChatRegistry } from './store.js';
import { createLogger } from '../lib/log.js';
import { errorMessage, hasNodeErrorCode } from '../lib/errors.js';

const logger = createLogger('chats:carryover-store');

const DEFAULT_SAVE_DELAY_MS = 100;
const CARRYOVER_VERSION = 2;

export interface CarryOverSegment {
  agentId: string;
  model: string;
  messages: ChatMessage[];
  at: string;
}

interface CarryOverChatEntry {
  revision: number;
  segments: CarryOverSegment[];
}

interface ChatCarryOverStoreOptions {
  filePath: string | null;
  saveDelayMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export class ChatCarryOverStore {
  #entriesByChatId = new Map<string, CarryOverChatEntry>();
  #filePath: string | null;
  #saveDelayMs: number;
  #initialized = false;
  #migrationRequired = false;
  #pendingSaveTimer: ReturnType<typeof setTimeout> | null = null;
  #savePromise: Promise<void> = Promise.resolve();

  constructor(options: ChatCarryOverStoreOptions) {
    this.#filePath = options.filePath;
    this.#saveDelayMs = options.saveDelayMs ?? DEFAULT_SAVE_DELAY_MS;
  }

  async init(): Promise<void> {
    if (this.#initialized) return;
    this.#initialized = true;
    this.#entriesByChatId = await this.#loadPersisted();
    if (this.#migrationRequired) await this.#saveNow();
  }

  // Registers cleanup so a removed chat's carry-over segments do not linger.
  bindRegistry(registry: IChatRegistry): void {
    registry.onChatRemoved((chatId) => this.clear(String(chatId)));
  }

  getSegments(chatId: string): CarryOverSegment[] {
    return this.#entriesByChatId.get(String(chatId))?.segments ?? [];
  }

  getSearchDescriptor(chatId: string): { filePath: string; chatRevision: number } | null {
    if (!this.#filePath) return null;
    const entry = this.#entriesByChatId.get(String(chatId));
    if (!entry || entry.segments.length === 0) return null;
    return { filePath: this.#filePath, chatRevision: entry.revision };
  }

  // Flattens all segments' messages in chronological switch order.
  getMessages(chatId: string): ChatMessage[] {
    const segments = this.#entriesByChatId.get(String(chatId))?.segments;
    if (!segments) return [];
    const messages: ChatMessage[] = [];
    for (const segment of segments) messages.push(...segment.messages);
    return messages;
  }

  appendSegment(chatId: string, segment: { agentId: string; model: string; messages: ChatMessage[] }): void {
    const key = String(chatId);
    const current = this.#entriesByChatId.get(key);
    const existing = current?.segments ?? [];
    existing.push({
      agentId: segment.agentId,
      model: segment.model,
      messages: segment.messages,
      at: new Date().toISOString(),
    });
    this.#entriesByChatId.set(key, {
      revision: (current?.revision ?? 0) + 1,
      segments: existing,
    });
    this.#scheduleSave();
  }

  copy(sourceChatId: string, targetChatId: string): void {
    const source = this.#entriesByChatId.get(String(sourceChatId));
    if (!source || source.segments.length === 0) return;
    const targetKey = String(targetChatId);
    const target = this.#entriesByChatId.get(targetKey);
    this.#entriesByChatId.set(targetKey, {
      revision: (target?.revision ?? 0) + 1,
      segments: source.segments.map((segment) => ({ ...segment, messages: [...segment.messages] })),
    });
    this.#scheduleSave();
  }

  clear(chatId: string): void {
    if (this.#entriesByChatId.delete(String(chatId))) this.#scheduleSave();
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

  async #loadPersisted(): Promise<Map<string, CarryOverChatEntry>> {
    const result = new Map<string, CarryOverChatEntry>();
    if (!this.#filePath) return result;
    try {
      const raw = await fs.readFile(this.#filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (!isRecord(parsed) || parsed.version !== CARRYOVER_VERSION) {
        this.#migrationRequired = true;
      }
      const chats = isRecord(parsed) ? parsed.chats : null;
      if (!isRecord(chats)) return result;
      for (const [chatId, value] of Object.entries(chats)) {
        const entry = normalizePersistedEntry(value);
        if (entry.segments.length > 0) result.set(chatId, entry);
      }
    } catch (error) {
      if (!hasNodeErrorCode(error, 'ENOENT')) {
        logger.warn('carryover: failed to load segments:', errorMessage(error));
      }
    }
    return result;
  }

  #scheduleSave(): void {
    if (!this.#filePath) return;
    if (this.#pendingSaveTimer) clearTimeout(this.#pendingSaveTimer);
    this.#pendingSaveTimer = setTimeout(() => {
      this.#pendingSaveTimer = null;
      this.#savePromise = this.#savePromise
        .catch(() => undefined)
        .then(() => this.#saveNow());
    }, this.#saveDelayMs);
  }

  async #saveNow(): Promise<void> {
    if (!this.#filePath) return;
    const snapshot = {
      version: CARRYOVER_VERSION,
      chats: Object.fromEntries(this.#entriesByChatId),
    };
    await writeJsonFileAtomic(this.#filePath, snapshot);
  }
}

// Interleaves carried segments with agent-switch boundary markers so a
// rendered transcript shows where the chat was continued under a different
// agent. Each boundary's target is the next segment's producer, or the
// current agent for the most recent switch.
export function renderCarriedTranscript(
  segments: CarryOverSegment[],
  current: { agentId: string; model: string },
): ChatMessage[] {
  const messages: ChatMessage[] = [];
  segments.forEach((segment, index) => {
    const target = segments[index + 1] ?? current;
    messages.push(...segment.messages);
    messages.push(
      new AgentSwitchMessage(segment.at, segment.agentId, target.agentId, segment.model, target.model),
    );
  });
  return messages;
}

function normalizePersistedSegments(value: unknown): CarryOverSegment[] {
  if (!Array.isArray(value)) return [];
  const segments: CarryOverSegment[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const agentId = typeof entry.agentId === 'string' ? entry.agentId : '';
    const model = typeof entry.model === 'string' ? entry.model : '';
    const at = typeof entry.at === 'string' ? entry.at : new Date(0).toISOString();
    if (!agentId) continue;
    segments.push({ agentId, model, at, messages: parseChatMessages(entry.messages) });
  }
  return segments;
}

function normalizePersistedEntry(value: unknown): CarryOverChatEntry {
  if (Array.isArray(value)) {
    return { revision: 1, segments: normalizePersistedSegments(value) };
  }
  if (!isRecord(value)) return { revision: 1, segments: [] };
  const revision = typeof value.revision === 'number'
    && Number.isSafeInteger(value.revision)
    && value.revision > 0
    ? value.revision
    : 1;
  return { revision, segments: normalizePersistedSegments(value.segments) };
}
