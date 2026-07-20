import type { createHash } from 'node:crypto';
import { parseChatMessages, type ChatMessage } from '@garcon/common/chat-types';
import { stripFirstUserSeed } from '@garcon/common/transcript-seed';
import {
  attachNativeMessageSource,
  AgentTranscriptIndexError,
  getNativeMessageSource,
} from '@garcon/server-agent-interface';
import { canonicalDigest, canonicalJson } from './digest.js';
import { projectSearchMessage } from './message-projector.js';
import type { HistoricalSearchMessageRow } from './rows.js';
import type { TranscriptSearchCatalogEntry } from './transcript-search-service.js';

export const TRANSCRIPT_INDEX_LOAD_LIMITS = {
  maxMessagesPerBatch: 250,
  maxBatchBytes: 8 * 1024 * 1024,
  maxRecordBytes: 8 * 1024 * 1024,
} as const;

export function rowsForBatch(
  batch: readonly ChatMessage[],
  ordinal: { value: number },
  content: ReturnType<typeof createHash>,
): HistoricalSearchMessageRow[] {
  const rows: HistoricalSearchMessageRow[] = [];
  for (const message of batch) {
    ordinal.value += 1;
    const projected = projectSearchMessage(message);
    if (!projected) continue;
    content.update(canonicalJson({ ...projected, messageOrdinal: ordinal.value }));
    content.update('\n');
    rows.push({ ...projected, messageOrdinal: ordinal.value });
  }
  return rows;
}

export function validateNativeBatch(batch: readonly ChatMessage[]): ChatMessage[] {
  if (batch.length > TRANSCRIPT_INDEX_LOAD_LIMITS.maxMessagesPerBatch) {
    throw batchTooLargeError();
  }
  const parsed: ChatMessage[] = [];
  let batchBytes = 0;
  for (const raw of batch) {
    const recordBytes = Buffer.byteLength(JSON.stringify(raw));
    batchBytes += recordBytes;
    if (recordBytes > TRANSCRIPT_INDEX_LOAD_LIMITS.maxRecordBytes
        || batchBytes > TRANSCRIPT_INDEX_LOAD_LIMITS.maxBatchBytes) {
      throw batchTooLargeError();
    }
    const message = parseChatMessages([raw])[0];
    if (!message) continue;
    attachNativeMessageSource(message, getNativeMessageSource(raw));
    parsed.push(message);
  }
  return parsed;
}

export function stripFirstUserSeedPreservingSource(batch: ChatMessage[]): ChatMessage[] {
  const index = batch.findIndex((message) => message.type === 'user-message');
  if (index < 0) return batch;
  const source = getNativeMessageSource(batch[index]);
  const stripped = stripFirstUserSeed(batch);
  if (source && stripped[index] !== batch[index]) attachNativeMessageSource(stripped[index], source);
  return stripped;
}

export function catalogEntryKey(entry: TranscriptSearchCatalogEntry): string {
  return canonicalDigest({
    agentId: entry.agentId,
    model: entry.model,
    updatedAt: entry.updatedAt,
    source: entry.source,
    carryOverRevision: entry.carryOverRevision,
  });
}

export function validateCatalogEntry(entry: TranscriptSearchCatalogEntry): void {
  if (!entry || typeof entry !== 'object'
      || typeof entry.chatId !== 'string' || entry.chatId.length === 0
      || typeof entry.agentId !== 'string' || entry.agentId.length === 0
      || typeof entry.model !== 'string'
      || (entry.updatedAt !== null && typeof entry.updatedAt !== 'string')
      || typeof entry.carryOverRevision !== 'string'
      || !entry.source || typeof entry.source !== 'object') {
    throw new Error('INVALID_CATALOG_ENTRY');
  }
  if (entry.source.state === 'absent') return;
  if (entry.source.state === 'failed') {
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(entry.source.code)
        || typeof entry.source.retryable !== 'boolean') {
      throw new Error('INVALID_CATALOG_ENTRY');
    }
    return;
  }
  if (entry.source.state !== 'ready') throw new Error('INVALID_CATALOG_ENTRY');
  const reference = entry.source.reference;
  if (!reference || typeof reference !== 'object'
      || reference.ownerId !== entry.agentId
      || !Number.isSafeInteger(reference.schemaVersion) || reference.schemaVersion < 1
      || !reference.value || typeof reference.value !== 'object' || Array.isArray(reference.value)
      || !isJsonValue(reference.value, new Set())) {
    throw new Error('INVALID_CATALOG_ENTRY');
  }
  let encoded: string;
  try {
    encoded = canonicalJson(reference);
  } catch {
    throw new Error('INVALID_CATALOG_ENTRY');
  }
  if (Buffer.byteLength(encoded) > 64 * 1024) throw new Error('INVALID_CATALOG_ENTRY');
}

function batchTooLargeError(): AgentTranscriptIndexError {
  return new AgentTranscriptIndexError({
    kind: 'agent-transcript-index-failure',
    code: 'SOURCE_BATCH_TOO_LARGE',
    retryable: false,
    refreshSource: false,
  });
}

function isJsonValue(value: unknown, ancestors: Set<object>): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || ancestors.has(value)) return false;
  if (!Array.isArray(value)) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
  }
  ancestors.add(value);
  const valid = Array.isArray(value)
    ? value.every((entry) => isJsonValue(entry, ancestors))
    : Object.values(value as Record<string, unknown>)
      .every((entry) => isJsonValue(entry, ancestors));
  ancestors.delete(value);
  return valid;
}
