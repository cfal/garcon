import { createHash, randomUUID } from 'node:crypto';
import type { ChatMessage } from '@garcon/common/chat-types';
import type { JsonObject } from '@garcon/common/json';
import type {
  AgentChatReferenceV4,
  AgentSegmentIdentity,
  AgentTranscriptEntry,
  AgentTranscriptProvenance,
  AgentTranscriptSourceIdentity,
} from '@garcon/server-agent-interface';
import { getNativeMessageRevisionSource } from '@garcon/server-agent-interface';
import { agentTranscriptEntryId, sourceIdentityKey } from './identity.js';

// Builds journal entries and native aliases from provider evidence or live
// messages: canonical source identities with byte, line, and event fallbacks,
// deterministic entry ids per segment, and the alias metadata that binds a
// committed row to its provider position.

export interface AgentTranscriptSeedEntry {
  readonly message: ChatMessage;
  readonly source: AgentTranscriptSourceIdentity;
  readonly nativeAlias?: JsonObject | null;
  readonly provenance?: AgentTranscriptProvenance | null;
  readonly entryId?: AgentTranscriptEntry['id'];
}

export function transcriptSeedEntries(
  ownerId: string,
  messages: readonly ChatMessage[],
  sourceNamespace?: string,
): readonly AgentTranscriptSeedEntry[] {
  const batchId = randomUUID();
  return messages.map((message, index) => ({
    message,
    source: messageSource(ownerId, sourceNamespace, message, index, batchId),
    nativeAlias: nativeAlias(message),
  }));
}

export function seedEntries(
  chat: AgentChatReferenceV4,
  seeds: readonly AgentTranscriptSeedEntry[],
): readonly AgentTranscriptEntry[] {
  const identity = segmentIdentity(chat);
  const seenSources = new Set<string>();
  return seeds.map((seed) => {
    const sourceKey = sourceIdentityKey(seed.source);
    if (seenSources.has(sourceKey)) throw new TypeError('Bootstrap source identities must be unique');
    seenSources.add(sourceKey);
    return {
      id: seed.entryId ?? deterministicEntryId(identity, seed.source),
      lifetime: 'durable' as const,
      source: seed.source,
      provenance: seed.provenance ?? null,
      message: seed.message,
    };
  });
}

export function deterministicEntryId(
  identity: AgentSegmentIdentity,
  source: AgentTranscriptSourceIdentity,
): AgentTranscriptEntry['id'] {
  return agentTranscriptEntryId(`entry-v1:${createHash('sha256')
    .update(`${identity.chatId}\0${identity.agentOwnershipEpoch}\0${sourceIdentityKey(source)}`)
    .digest('hex')}`);
}

// Rows carrying provider-native identity claim the owner's native namespace;
// rows without one are event-channel observations that make no claim about
// native storage, so they live in the event namespace where audits ignore
// them instead of mistaking them for unproven native records.
export function messageSource(
  ownerId: string,
  namespace: string | undefined,
  message: ChatMessage,
  index: number,
  fallbackBatchId: string,
): AgentTranscriptSourceIdentity {
  const native = getNativeMessageRevisionSource(message);
  const itemId = native?.entryId
    ?? (native?.byteOffset !== undefined ? `byte:${native.byteOffset}` : null)
    ?? (native?.lineNumber !== undefined ? `line:${native.lineNumber}` : null);
  const subrow = native?.withinSourceOrdinal ?? index;
  return {
    namespace: namespace ?? (itemId !== null ? `${ownerId}:native` : `${ownerId}:event`),
    itemId: itemId ?? `event:${fallbackBatchId}`,
    subrowId: `row:${subrow}`,
  };
}

export function aliasesFromSeeds(seeds: readonly AgentTranscriptSeedEntry[]): JsonObject {
  return Object.fromEntries(seeds.flatMap((seed) => {
    const alias = seed.nativeAlias === undefined ? nativeAlias(seed.message) : seed.nativeAlias;
    return alias ? [[sourceIdentityKey(seed.source), alias] as const] : [];
  }));
}

export function nativeAlias(message: ChatMessage): JsonObject | null {
  const source = getNativeMessageRevisionSource(message);
  if (!source) return null;
  return {
    ...(source.entryId ? { entryId: source.entryId } : {}),
    ...(source.lineNumber !== undefined ? { lineNumber: source.lineNumber } : {}),
    ...(source.byteOffset !== undefined ? { byteOffset: source.byteOffset } : {}),
    ...(source.withinSourceOrdinal !== undefined
      ? { withinSourceOrdinal: source.withinSourceOrdinal }
      : {}),
  };
}

export function nativeAliasLineNumber(value: unknown): number | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const lineNumber = (value as Record<string, unknown>).lineNumber;
  return typeof lineNumber === 'number' && Number.isSafeInteger(lineNumber) && lineNumber > 0
    ? lineNumber
    : null;
}

function segmentIdentity(chat: AgentChatReferenceV4): AgentSegmentIdentity {
  return { chatId: chat.chatId, agentOwnershipEpoch: chat.agentOwnershipEpoch };
}
