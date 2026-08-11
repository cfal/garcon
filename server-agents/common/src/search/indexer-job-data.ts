import type { createHash } from 'node:crypto';
import { parseChatMessages, type ChatMessage } from '@garcon/common/chat-types';
import type { TranscriptSearchEntryAnchor } from '@garcon/common/chat-search';
import type {
  AgentTranscriptIndexEntryV4,
  AgentTranscriptIndexSourceRefV4,
} from '@garcon/server-agent-interface';
import { canonicalDigest, canonicalJson } from './digest.js';
import { projectSearchMessage } from './message-projector.js';
import type { HistoricalSearchMessageRow } from './rows.js';
import type {
  TranscriptSearchCatalogEntry,
  TranscriptSearchCarryOverEntry,
} from './transcript-search-service.js';

export const TRANSCRIPT_INDEX_LOAD_LIMITS = {
  maxMessagesPerBatch: 250,
  maxBatchBytes: 8 * 1024 * 1024,
  maxRecordBytes: 8 * 1024 * 1024,
} as const;

interface SearchEnvelope {
  readonly messageOrdinal: number;
  readonly message: ChatMessage;
  readonly anchor: TranscriptSearchEntryAnchor;
  readonly integrity: unknown;
}

export function rowsForCarryOverBatch(
  batch: readonly TranscriptSearchCarryOverEntry[],
  ordinal: { value: number },
  content: ReturnType<typeof createHash>,
): HistoricalSearchMessageRow[] {
  return rowsForEnvelopes(batch.map((item) => {
    ordinal.value += 1;
    return {
      messageOrdinal: ordinal.value,
      message: parseOneMessage(item.message),
      anchor: item.anchor,
      integrity: { anchor: item.anchor, message: item.message },
    };
  }), content);
}

export function rowsForCurrentBatch(
  batch: readonly AgentTranscriptIndexEntryV4[],
  carryOverCount: number,
  agentOwnershipEpoch: string,
  content: ReturnType<typeof createHash>,
): HistoricalSearchMessageRow[] {
  return rowsForEnvelopes(batch.map((item) => ({
    messageOrdinal: carryOverCount + item.ordinal,
    message: parseOneMessage(item.entry.message),
    anchor: {
      kind: 'current-entry' as const,
      agentOwnershipEpoch,
      entryId: item.entry.id,
    },
    integrity: item,
  })), content);
}

function rowsForEnvelopes(
  envelopes: readonly SearchEnvelope[],
  content: ReturnType<typeof createHash>,
): HistoricalSearchMessageRow[] {
  const rows: HistoricalSearchMessageRow[] = [];
  for (const envelope of envelopes) {
    content.update(canonicalJson({
      messageOrdinal: envelope.messageOrdinal,
      anchor: envelope.anchor,
      integrity: envelope.integrity,
    }));
    content.update('\n');
    const projected = projectSearchMessage(envelope.message);
    if (projected) rows.push({ ...projected, messageOrdinal: envelope.messageOrdinal, anchor: envelope.anchor });
  }
  return rows;
}

function parseOneMessage(value: ChatMessage): ChatMessage {
  const encodedBytes = Buffer.byteLength(JSON.stringify(value));
  if (encodedBytes > TRANSCRIPT_INDEX_LOAD_LIMITS.maxRecordBytes) {
    throw new Error('SOURCE_BATCH_TOO_LARGE');
  }
  const message = parseChatMessages([value])[0];
  if (!message) throw new Error('SOURCE_RECORD_INVALID');
  return message;
}

export function catalogEntryKey(entry: TranscriptSearchCatalogEntry): string {
  return canonicalDigest({
    agentId: entry.agentId,
    model: entry.model,
    source: entry.source,
    carryOverRevision: entry.carryOverRevision,
    contentEpoch: entry.contentEpoch,
  });
}

export function validateCatalogEntry(entry: TranscriptSearchCatalogEntry): void {
  if (!entry || typeof entry !== 'object'
      || typeof entry.chatId !== 'string' || entry.chatId.length === 0
      || typeof entry.agentId !== 'string' || entry.agentId.length === 0
      || typeof entry.model !== 'string'
      || typeof entry.carryOverRevision !== 'string'
      || (entry.contentEpoch !== null && (
        typeof entry.contentEpoch !== 'string' || entry.contentEpoch.length === 0
      ))
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
  validateSourceReference(entry.source.reference, entry.agentId, entry.chatId);
}

function validateSourceReference(
  reference: AgentTranscriptIndexSourceRefV4,
  agentId: string,
  chatId: string,
): void {
  if (reference.apiVersion !== 2
      || reference.ownerId !== agentId
      || reference.schemaVersion !== 2
      || reference.checkpoint.chatId !== chatId
      || reference.checkpoint.agentOwnershipEpoch.length === 0
      || reference.checkpoint.contentEpoch.length === 0
      || !Number.isSafeInteger(reference.checkpoint.durableCount)
      || reference.checkpoint.durableCount < 0
      || reference.checkpoint.durableRevision.length === 0
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
