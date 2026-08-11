import { parseAgentSettingsEnvelope } from '@garcon/common/agent-integration';
import { isPermissionMode, isThinkingMode } from '@garcon/common/chat-modes';
import { parseNativeSeedReceipt } from '@garcon/common/transcript-seed';
import type {
  AgentChatReference,
  AgentChatReferenceV4,
} from '@garcon/server-agent-interface';
import type { ResolvedAgentHandoffTarget } from '../agents/agent-handoff-types.js';
import type { CarryOverSegmentRef } from './store.js';
import { parseCarryOverSegmentRefs } from './store.js';
import {
  AGENT_OWNERSHIP_JOURNAL_VERSION,
  type AgentHandoffIntent,
  type AgentOwnershipJournalFileV4,
  type DeleteIntentV2,
  type SourceReleaseCleanup,
} from './agent-ownership-journal.js';

// Validates the persisted ownership-journal file shape. Guards are strict:
// an unrecognized record keeps the whole journal unreadable rather than
// silently dropping durable handoff or deletion state.
export function isJournalV4(value: unknown): value is AgentOwnershipJournalFileV4 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const journal = value as Record<string, unknown>;
  if (journal.version !== AGENT_OWNERSHIP_JOURNAL_VERSION) return false;
  if (!Array.isArray(journal.ownershipIntents) || !Array.isArray(journal.transferCleanup)) return false;
  return journal.ownershipIntents.every(isOwnershipIntent)
    && journal.transferCleanup.every(isTransferCleanup);
}

function isOwnershipIntent(value: unknown): value is AgentHandoffIntent | DeleteIntentV2 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const intent = value as Record<string, unknown>;
  if ((intent.version !== 2 && intent.version !== 4) || typeof intent.operationId !== 'string' || typeof intent.chatId !== 'string') {
    return false;
  }
  if (intent.kind === 'delete') {
    return (intent.phase === 'prepared' || intent.phase === 'registry-removed')
      && (intent.sourceEpoch === null || typeof intent.sourceEpoch === 'string')
      && Array.isArray(intent.releaseReferences)
      && intent.releaseReferences.every(isAgentChatReference)
      && typeof intent.createdAt === 'string';
  }
  const source = intent.source;
  const target = intent.target;
  const staging = intent.staging;
  const phase = intent.phase;
  return intent.kind === 'handoff'
    && intent.version === 4
    && (phase === 'intent' || phase === 'staged'
      || phase === 'commit-decided' || phase === 'registry-committed')
    && typeof intent.clientRequestId === 'string'
    && typeof intent.submittedTargetHash === 'string'
    && /^[a-f0-9]{64}$/.test(intent.submittedTargetHash)
    && isObject(source)
    && nonEmptyString(source.agentId)
    && typeof source.model === 'string'
    && nullableString(source.sessionId)
    && nonEmptyString(source.agentOwnershipEpoch)
    && nonEmptyString(source.carryOverRevision)
    && isNativeSeedReceiptOrNull(source.nativeSeedReceipt)
    && isAgentChatReferenceV4(source.reference)
    && isObject(target)
    && isResolvedHandoffTarget(target.execution)
    && nonEmptyString(target.agentOwnershipEpoch)
    && isCarryOverSegmentRefs(target.carryOverSegments)
    && (staging === null || isHandoffStaging(staging, intent.chatId, source.agentOwnershipEpoch, target.agentOwnershipEpoch))
    && (phase === 'intent' ? staging === null : staging !== null)
    && typeof intent.createdAt === 'string';
}

function isHandoffStaging(
  value: unknown,
  chatId: unknown,
  sourceEpoch: unknown,
  targetEpoch: unknown,
): boolean {
  if (!isObject(value) || typeof chatId !== 'string'
      || typeof sourceEpoch !== 'string' || typeof targetEpoch !== 'string') return false;
  return isStreamCheckpoint(value.sourceCheckpoint, chatId, sourceEpoch)
    && isStreamCheckpoint(value.incomingCheckpoint, chatId, targetEpoch);
}

function isStreamCheckpoint(value: unknown, chatId: string, ownershipEpoch: string): boolean {
  if (!isObject(value) || value.chatId !== chatId
      || value.agentOwnershipEpoch !== ownershipEpoch
      || typeof value.offset !== 'string') return false;
  const projection = value.projection;
  return isObject(projection)
    && nonEmptyString(projection.epoch)
    && nonEmptyString(projection.contentEpoch)
    && Number.isSafeInteger(projection.total)
    && Number(projection.total) >= 0
    && Number.isSafeInteger(projection.durableCount)
    && Number(projection.durableCount) === Number(projection.total)
    && nonEmptyString(projection.durableRevision)
    && nonEmptyString(projection.stateRevision);
}

function isTransferCleanup(value: unknown): value is SourceReleaseCleanup {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const cleanup = value as Record<string, unknown>;
  return cleanup.version === 1
    && typeof cleanup.operationId === 'string'
    && typeof cleanup.chatId === 'string'
    && isAgentChatReferenceV4(cleanup.source)
    && cleanup.reason === 'transferred'
    && (cleanup.status === 'pending' || cleanup.status === 'claimed' || cleanup.status === 'abandoned')
    && Number.isSafeInteger(cleanup.attempts)
    && Number(cleanup.attempts) >= 0
    && (cleanup.lastErrorCode === null || typeof cleanup.lastErrorCode === 'string')
    && typeof cleanup.createdAt === 'string';
}

function isResolvedHandoffTarget(value: unknown): value is ResolvedAgentHandoffTarget {
  if (!isObject(value)) return false;
  const settings = parseAgentSettingsEnvelope(value.agentSettings);
  return nonEmptyString(value.agentId)
    && typeof value.model === 'string'
    && nullableString(value.apiProviderId)
    && nullableString(value.modelEndpointId)
    && (
      value.modelProtocol === null
      || value.modelProtocol === 'anthropic-messages'
      || value.modelProtocol === 'openai-compatible'
    )
    && isPermissionMode(value.permissionMode)
    && isThinkingMode(value.thinkingMode)
    && settings !== null
    && settings.ownerId === value.agentId;
}

function isAgentChatReference(value: unknown): value is AgentChatReference {
  if (!isObject(value)) return false;
  const settings = parseAgentSettingsEnvelope(value.settings);
  return nonEmptyString(value.chatId)
    && nonEmptyString(value.agentId)
    && nullableString(value.agentSessionId)
    && typeof value.projectPath === 'string'
    && typeof value.model === 'string'
    && isNativeSessionOrNull(value.nativeSession, value.agentId)
    && typeof value.carryOverRevision === 'string'
    && isNativeSeedReceiptOrNull(value.nativeSeedReceipt)
    && settings !== null
    && settings.ownerId === value.agentId;
}

function isAgentChatReferenceV4(value: unknown): value is AgentChatReferenceV4 {
  return isAgentChatReference(value)
    && nonEmptyString((value as unknown as Record<string, unknown>).agentOwnershipEpoch);
}

function isNativeSessionOrNull(value: unknown, agentId: string): boolean {
  if (value === null) return true;
  if (!isObject(value)) return false;
  return value.ownerId === agentId
    && Number.isSafeInteger(value.schemaVersion)
    && Number(value.schemaVersion) >= 1
    && isObject(value.value);
}

function isNativeSeedReceiptOrNull(value: unknown): boolean {
  return value === null || parseNativeSeedReceipt(value) !== null;
}

function isCarryOverSegmentRefs(value: unknown): value is readonly CarryOverSegmentRef[] {
  try {
    parseCarryOverSegmentRefs(value);
    return true;
  } catch {
    return false;
  }
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
