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
import {
  TranscriptSearchCarryOverError,
  type TranscriptSearchCarryOverRequest,
  type TranscriptSearchCarryOverStream,
} from '@garcon/server-agent-common/search/transcript-search-service';

const logger = createLogger('chats:carryover-store');

const DEFAULT_SAVE_DELAY_MS = 100;
const CARRYOVER_VERSION = 4;

export interface CarryOverSegment {
  agentId: string;
  model: string;
  messages: ChatMessage[];
  at: string;
  boundary?: boolean;
  boundaryTarget?: { agentId: string; model: string };
}

interface CarryOverChatEntry {
  revision: number;
  segments: CarryOverSegment[];
  staged?: {
    targetEpoch: string;
    ownerId: string;
    revision: number;
    segments: CarryOverSegment[];
  };
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
  #registry: IChatRegistry | null = null;

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
    this.#registry = registry;
    registry.onChatRemoved((chatId) => this.clear(String(chatId)));
  }

  getSegments(chatId: string): CarryOverSegment[] {
    return this.#activeEntry(String(chatId))?.segments ?? [];
  }

  getSearchDescriptor(chatId: string): { filePath: string; chatRevision: number } | null {
    if (!this.#filePath) return null;
    const entry = this.#activeEntry(String(chatId));
    if (!entry || entry.segments.length === 0) return null;
    return { filePath: this.#filePath, chatRevision: entry.revision };
  }

  // Flattens all segments' messages in chronological switch order.
  getMessages(chatId: string): ChatMessage[] {
    const segments = this.#activeEntry(String(chatId))?.segments;
    if (!segments) return [];
    const messages: ChatMessage[] = [];
    for (const segment of segments) messages.push(...segment.messages);
    return messages;
  }

  getRevision(chatId: string): string {
    return `carry-v1:${this.#activeEntry(String(chatId))?.revision ?? 0}`;
  }

  async openSearchStream(
    request: TranscriptSearchCarryOverRequest,
  ): Promise<TranscriptSearchCarryOverStream> {
    request.signal.throwIfAborted();
    const active = this.#activeEntry(String(request.chatId));
    const revision = `carry-v1:${active?.revision ?? 0}`;
    if (revision !== request.expectedRevision) {
      throw new TranscriptSearchCarryOverError({
        kind: 'transcript-search-carry-over-failure',
        code: 'CARRY_OVER_REVISION_CHANGED',
        retryable: true,
      });
    }
    const segments = active?.segments ?? [];
    return {
      revision,
      batches: streamRenderedSegments(segments, {
        agentId: request.currentAgentId,
        model: request.currentModel,
      }, request.limits, request.signal),
    };
  }

  appendSegment(chatId: string, segment: { agentId: string; model: string; messages: ChatMessage[] }): void {
    const key = String(chatId);
    const current = this.#entriesByChatId.get(key);
    const existing = current?.segments ?? [];
    this.#entriesByChatId.set(key, {
      revision: (current?.revision ?? 0) + 1,
      segments: immutableSegments([...existing, immutableSegment({
        agentId: segment.agentId,
        model: segment.model,
        messages: segment.messages,
        at: new Date().toISOString(),
      })]),
    });
    this.#scheduleSave();
  }

  async stageTransfer(input: {
    chatId: string;
    targetEpoch: string;
    ownerId: string;
    segment: { agentId: string; model: string; messages: ChatMessage[] } | null;
  }): Promise<string> {
    const key = String(input.chatId);
    const current = this.#entriesByChatId.get(key) ?? { revision: 0, segments: [] };
    if (current.staged && current.staged.targetEpoch !== input.targetEpoch) {
      throw new Error(`Carry-over transfer already staged for ${key}`);
    }
    const segments = current.segments.map(cloneSegment);
    if (input.segment) {
      segments.push(immutableSegment({
        ...input.segment,
        at: new Date().toISOString(),
      }));
    }
    const revision = current.revision + 1;
    this.#entriesByChatId.set(key, {
      ...current,
      staged: {
        targetEpoch: input.targetEpoch,
        ownerId: input.ownerId,
        revision,
        segments: immutableSegments(segments),
      },
    });
    await this.flush();
    return `carry-v1:${revision}`;
  }

  async stageFork(input: {
    sourceChatId: string;
    targetChatId: string;
    targetEpoch: string;
    ownerId: string;
    ownerModel: string;
    upToSequence?: number;
  }): Promise<void> {
    const source = this.#activeEntry(String(input.sourceChatId));
    if (!source || source.segments.length === 0) return;
    const targetKey = String(input.targetChatId);
    const target = this.#entriesByChatId.get(targetKey) ?? { revision: 0, segments: [] };
    if (target.staged && target.staged.targetEpoch !== input.targetEpoch) {
      throw new Error(`Carry-over fork already staged for ${targetKey}`);
    }
    const segments = sliceRenderedSegments(
      source.segments,
      input.upToSequence,
      { agentId: input.ownerId, model: input.ownerModel },
    );
    if (segments.length === 0) return;
    this.#entriesByChatId.set(targetKey, {
      ...target,
      staged: {
        targetEpoch: input.targetEpoch,
        ownerId: input.ownerId,
        revision: target.revision + 1,
        segments: immutableSegments(segments),
      },
    });
    await this.flush();
  }

  async promoteStaged(chatId: string, targetEpoch: string): Promise<void> {
    const key = String(chatId);
    const current = this.#entriesByChatId.get(key);
    if (!current?.staged) return;
    if (current.staged.targetEpoch !== targetEpoch) {
      throw new Error(`Carry-over epoch mismatch for ${key}`);
    }
    this.#entriesByChatId.set(key, {
      revision: current.staged.revision,
      segments: current.staged.segments,
    });
    await this.flush();
  }

  async discardStaged(chatId: string, targetEpoch: string): Promise<void> {
    const current = this.#entriesByChatId.get(String(chatId));
    if (!current?.staged || current.staged.targetEpoch !== targetEpoch) return;
    const key = String(chatId);
    if (current.segments.length === 0) this.#entriesByChatId.delete(key);
    else this.#entriesByChatId.set(key, { revision: current.revision, segments: current.segments });
    await this.flush();
  }

  async pruneOrphanedStaged(referencedEpochs: ReadonlySet<string>): Promise<void> {
    let dirty = false;
    for (const [chatId, entry] of this.#entriesByChatId) {
      if (!entry.staged || referencedEpochs.has(entry.staged.targetEpoch)) continue;
      if (entry.segments.length === 0) this.#entriesByChatId.delete(chatId);
      else this.#entriesByChatId.set(chatId, { revision: entry.revision, segments: entry.segments });
      dirty = true;
    }
    if (dirty) await this.flush();
  }

  async promoteCommittedStaged(): Promise<void> {
    if (!this.#registry) return;
    let dirty = false;
    for (const [chatId, entry] of this.#entriesByChatId) {
      if (!entry.staged) continue;
      const chat = this.#registry.getChat(chatId);
      if (
        chat?.agentOwnershipEpoch !== entry.staged.targetEpoch
        || chat.agentId !== entry.staged.ownerId
      ) {
        continue;
      }
      this.#entriesByChatId.set(chatId, {
        revision: entry.staged.revision,
        segments: entry.staged.segments,
      });
      dirty = true;
    }
    if (dirty) await this.flush();
  }

  copy(sourceChatId: string, targetChatId: string, upToSequence?: number): void {
    const source = this.#activeEntry(String(sourceChatId));
    if (!source || source.segments.length === 0) return;
    const targetKey = String(targetChatId);
    const target = this.#entriesByChatId.get(targetKey);
    this.#entriesByChatId.set(targetKey, {
      revision: (target?.revision ?? 0) + 1,
      segments: immutableSegments(sliceRenderedSegments(source.segments, upToSequence)),
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
        if (entry.segments.length > 0 || entry.staged) result.set(chatId, entry);
      }
    } catch (error) {
      if (!hasNodeErrorCode(error, 'ENOENT')) {
        logger.warn('carryover: failed to load segments:', errorMessage(error));
      }
    }
    return result;
  }

  #activeEntry(chatId: string): Pick<CarryOverChatEntry, 'revision' | 'segments'> | null {
    const entry = this.#entriesByChatId.get(chatId);
    if (!entry) return null;
    const chat = this.#registry?.getChat(chatId);
    if (
      entry.staged
      && chat?.agentOwnershipEpoch === entry.staged.targetEpoch
      && chat.agentId === entry.staged.ownerId
    ) {
      return entry.staged;
    }
    return entry;
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
  segments: readonly CarryOverSegment[],
  current: { agentId: string; model: string },
): ChatMessage[] {
  const messages: ChatMessage[] = [];
  segments.forEach((segment, index) => {
    const target = segment.boundaryTarget ?? segments[index + 1] ?? current;
    messages.push(...segment.messages);
    if (segment.boundary !== false) {
      messages.push(
        new AgentSwitchMessage(segment.at, segment.agentId, target.agentId, segment.model, target.model),
      );
    }
  });
  return messages;
}

async function* streamRenderedSegments(
  segments: readonly CarryOverSegment[],
  current: { agentId: string; model: string },
  limits: { readonly maxMessagesPerBatch: number; readonly maxBatchBytes: number },
  signal: AbortSignal,
): AsyncIterable<readonly ChatMessage[]> {
  let segmentIndex = 0;
  let messageIndex = 0;
  let boundaryPending = false;
  while (segmentIndex < segments.length) {
    signal.throwIfAborted();
    const batch: ChatMessage[] = [];
    let batchBytes = 2;
    while (segmentIndex < segments.length && batch.length < limits.maxMessagesPerBatch) {
      const segment = segments[segmentIndex];
      let message: ChatMessage | null = null;
      if (messageIndex < segment.messages.length) {
        message = segment.messages[messageIndex++];
      } else if (!boundaryPending && segment.boundary !== false) {
        const target = segment.boundaryTarget ?? segments[segmentIndex + 1] ?? current;
        boundaryPending = true;
        message = new AgentSwitchMessage(
          segment.at,
          segment.agentId,
          target.agentId,
          segment.model,
          target.model,
        );
      } else {
        segmentIndex += 1;
        messageIndex = 0;
        boundaryPending = false;
        continue;
      }
      const encodedBytes = Buffer.byteLength(JSON.stringify(message)) + (batch.length > 0 ? 1 : 0);
      if (encodedBytes + 2 > limits.maxBatchBytes) {
        throw new TranscriptSearchCarryOverError({
          kind: 'transcript-search-carry-over-failure',
          code: 'CARRY_OVER_MESSAGE_TOO_LARGE',
          retryable: false,
        });
      }
      if (batch.length > 0 && batchBytes + encodedBytes > limits.maxBatchBytes) {
        if (messageIndex > 0 && message === segment.messages[messageIndex - 1]) messageIndex -= 1;
        else boundaryPending = false;
        break;
      }
      batch.push(message);
      batchBytes += encodedBytes;
    }
    if (batch.length > 0) yield batch;
    signal.throwIfAborted();
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
    const boundaryTarget = normalizeBoundaryTarget(entry.boundaryTarget);
    if (!agentId) continue;
    segments.push(immutableSegment({
      agentId,
      model,
      at,
      messages: parseChatMessages(entry.messages),
      ...(entry.boundary === false ? { boundary: false } : {}),
      ...(boundaryTarget ? { boundaryTarget } : {}),
    }));
  }
  return immutableSegments(segments);
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
  const staged = normalizeStaged(value.staged);
  return {
    revision,
    segments: normalizePersistedSegments(value.segments),
    ...(staged ? { staged } : {}),
  };
}

function normalizeStaged(value: unknown): CarryOverChatEntry['staged'] | null {
  if (!isRecord(value)) return null;
  const targetEpoch = typeof value.targetEpoch === 'string' ? value.targetEpoch : '';
  const ownerId = typeof value.ownerId === 'string' ? value.ownerId : '';
  const revision = typeof value.revision === 'number' && Number.isSafeInteger(value.revision)
    ? value.revision
    : 0;
  if (!targetEpoch || !ownerId || revision < 1) return null;
  return {
    targetEpoch,
    ownerId,
    revision,
    segments: normalizePersistedSegments(value.segments),
  };
}

function cloneSegment(segment: CarryOverSegment): CarryOverSegment {
  return immutableSegment(segment);
}

function immutableSegment(segment: CarryOverSegment): CarryOverSegment {
  const boundaryTarget = segment.boundaryTarget
    ? Object.freeze({ ...segment.boundaryTarget })
    : undefined;
  return Object.freeze({
    ...segment,
    messages: Object.freeze([...segment.messages]) as unknown as ChatMessage[],
    ...(boundaryTarget ? { boundaryTarget } : {}),
  });
}

function immutableSegments(segments: readonly CarryOverSegment[]): CarryOverSegment[] {
  return Object.freeze([...segments]) as unknown as CarryOverSegment[];
}

function sliceRenderedSegments(
  source: readonly CarryOverSegment[],
  upToSequence?: number,
  current?: { agentId: string; model: string },
): CarryOverSegment[] {
  if (upToSequence === undefined) return source.map(cloneSegment);
  let remaining = upToSequence;
  const result: CarryOverSegment[] = [];
  for (const [index, segment] of source.entries()) {
    if (remaining <= 0) break;
    const messageCount = segment.messages.length;
    if (remaining <= messageCount) {
      result.push(immutableSegment({
        ...segment,
        messages: segment.messages.slice(0, remaining),
        boundary: false,
      }));
      break;
    }
    let boundaryTarget = segment.boundaryTarget;
    if (segment.boundary !== false) {
      const target = segment.boundaryTarget ?? source[index + 1] ?? current;
      if (target) boundaryTarget = { agentId: target.agentId, model: target.model };
    }
    result.push(immutableSegment({ ...segment, ...(boundaryTarget ? { boundaryTarget } : {}) }));
    remaining -= messageCount;
    if (segment.boundary !== false) remaining -= 1;
  }
  return result;
}

function normalizeBoundaryTarget(value: unknown): CarryOverSegment['boundaryTarget'] | null {
  if (!isRecord(value)) return null;
  const agentId = typeof value.agentId === 'string' ? value.agentId : '';
  const model = typeof value.model === 'string' ? value.model : '';
  return agentId ? { agentId, model } : null;
}
