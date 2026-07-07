// Durable snapshot of prior-agent transcripts for cross-agent continuation.
// A switch persists the outgoing agent's rendered ChatMessage[] as a segment so
// the conversation stays visible on reload even though the new native session
// starts empty. Segments accumulate in order across repeated switches.

import { promises as fs } from 'fs';
import { writeJsonFileAtomic } from '../lib/json-file-store.js';
import type { ChatMessage } from '../../common/chat-types.js';
import { parseChatMessages } from '../../common/chat-types.js';
import type { IChatRegistry } from './store.js';
import { createLogger } from '../lib/log.js';
import { errorMessage, hasNodeErrorCode } from '../lib/errors.js';

const logger = createLogger('chats:carryover-store');

const DEFAULT_SAVE_DELAY_MS = 100;
const CARRYOVER_VERSION = 1;

export interface CarryOverSegment {
  agentId: string;
  model: string;
  messages: ChatMessage[];
  at: string;
}

interface ChatCarryOverStoreOptions {
  filePath: string | null;
  saveDelayMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export class ChatCarryOverStore {
  #segmentsByChatId = new Map<string, CarryOverSegment[]>();
  #filePath: string | null;
  #saveDelayMs: number;
  #initialized = false;
  #pendingSaveTimer: ReturnType<typeof setTimeout> | null = null;
  #savePromise: Promise<void> = Promise.resolve();

  constructor(options: ChatCarryOverStoreOptions) {
    this.#filePath = options.filePath;
    this.#saveDelayMs = options.saveDelayMs ?? DEFAULT_SAVE_DELAY_MS;
  }

  async init(): Promise<void> {
    if (this.#initialized) return;
    this.#initialized = true;
    this.#segmentsByChatId = await this.#loadPersisted();
  }

  // Registers cleanup so a removed chat's carry-over segments do not linger.
  bindRegistry(registry: IChatRegistry): void {
    registry.onChatRemoved((chatId) => this.clear(String(chatId)));
  }

  getSegments(chatId: string): CarryOverSegment[] {
    return this.#segmentsByChatId.get(String(chatId)) ?? [];
  }

  // Flattens all segments' messages in chronological switch order.
  getMessages(chatId: string): ChatMessage[] {
    const segments = this.#segmentsByChatId.get(String(chatId));
    if (!segments) return [];
    const messages: ChatMessage[] = [];
    for (const segment of segments) messages.push(...segment.messages);
    return messages;
  }

  appendSegment(chatId: string, segment: { agentId: string; model: string; messages: ChatMessage[] }): void {
    const key = String(chatId);
    const existing = this.#segmentsByChatId.get(key) ?? [];
    existing.push({
      agentId: segment.agentId,
      model: segment.model,
      messages: segment.messages,
      at: new Date().toISOString(),
    });
    this.#segmentsByChatId.set(key, existing);
    this.#scheduleSave();
  }

  copy(sourceChatId: string, targetChatId: string): void {
    const source = this.#segmentsByChatId.get(String(sourceChatId));
    if (!source || source.length === 0) return;
    this.#segmentsByChatId.set(
      String(targetChatId),
      source.map((segment) => ({ ...segment, messages: [...segment.messages] })),
    );
    this.#scheduleSave();
  }

  clear(chatId: string): void {
    if (this.#segmentsByChatId.delete(String(chatId))) this.#scheduleSave();
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

  async #loadPersisted(): Promise<Map<string, CarryOverSegment[]>> {
    const result = new Map<string, CarryOverSegment[]>();
    if (!this.#filePath) return result;
    try {
      const raw = await fs.readFile(this.#filePath, 'utf8');
      const parsed = JSON.parse(raw);
      const chats = isRecord(parsed) ? parsed.chats : null;
      if (!isRecord(chats)) return result;
      for (const [chatId, value] of Object.entries(chats)) {
        const segments = normalizePersistedSegments(value);
        if (segments.length > 0) result.set(chatId, segments);
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
      chats: Object.fromEntries(this.#segmentsByChatId),
    };
    await writeJsonFileAtomic(this.#filePath, snapshot);
  }
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
