import { parseAgentSettingsEnvelope } from '@garcon/common/agent-integration';
import { isPermissionMode, isThinkingMode } from '@garcon/common/chat-modes';
import type { AgentChatReference } from '@garcon/server-agent-interface';
import type { ResolvedAgentHandoffTarget } from '../agents/agent-handoff-types.js';
import {
  AGENT_OWNERSHIP_JOURNAL_VERSION,
  type AgentHandoffIntent,
  type AgentOwnershipJournalFileV5,
  type DeleteIntentV2,
} from './agent-ownership-journal.js';

// Accepts a journal written by an earlier format only when it recorded no decisions. The
// file is rewritten on mutation, not on version bumps, so a workspace that never handed off
// or deleted a chat still holds whatever version it was created with; refusing to read it
// would brick that workspace permanently. An empty journal holds nothing a format change
// could have reshaped, while anything still carrying a decision falls through to the
// fail-closed path below, because an unreadable decision must not be guessed at.
export function isEmptyEarlierJournal(value: unknown): boolean {
  if (!isObject(value) || !Number.isSafeInteger(value.version)) return false;
  if (Number(value.version) >= AGENT_OWNERSHIP_JOURNAL_VERSION) return false;
  return isEmptyArray(value.ownershipIntents)
    && (value.transferCleanup === undefined || isEmptyArray(value.transferCleanup));
}

function isEmptyArray(value: unknown): boolean {
  return Array.isArray(value) && value.length === 0;
}

// Rejects the whole journal when any durable decision is malformed.
export function isJournalV5(value: unknown): value is AgentOwnershipJournalFileV5 {
  if (!isObject(value) || value.version !== AGENT_OWNERSHIP_JOURNAL_VERSION) return false;
  return Array.isArray(value.ownershipIntents)
    && value.ownershipIntents.every(isOwnershipIntent);
}

function isOwnershipIntent(value: unknown): value is AgentHandoffIntent | DeleteIntentV2 {
  if (!isObject(value) || typeof value.operationId !== 'string'
      || typeof value.chatId !== 'string') return false;
  if (value.kind === 'delete') return isDeleteIntent(value);
  return value.kind === 'handoff' && isHandoffIntent(value);
}

function isDeleteIntent(value: Record<string, unknown>): boolean {
  return value.version === 2
    && (value.phase === 'prepared' || value.phase === 'registry-removed')
    && (value.sourceEpoch === null || typeof value.sourceEpoch === 'string')
    && Array.isArray(value.releaseReferences)
    && value.releaseReferences.every(isAgentChatReference)
    && typeof value.createdAt === 'string';
}

function isHandoffIntent(value: Record<string, unknown>): boolean {
  const source = value.source;
  const target = value.target;
  const watermark = value.watermark;
  return value.version === 5
    && (value.phase === 'commit-decided' || value.phase === 'registry-committed')
    && typeof value.clientRequestId === 'string'
    && typeof value.submittedTargetHash === 'string'
    && /^[a-f0-9]{64}$/.test(value.submittedTargetHash)
    && isObject(source)
    && nonEmptyString(source.agentId)
    && nonEmptyString(source.agentOwnershipEpoch)
    && isObject(target)
    && isResolvedHandoffTarget(target.execution)
    && nonEmptyString(target.agentOwnershipEpoch)
    && isObject(watermark)
    && nonEmptyString(watermark.viewId)
    && Number.isSafeInteger(watermark.ordinal)
    && Number(watermark.ordinal) >= 0
    && typeof value.createdAt === 'string';
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
    && settings !== null
    && settings.ownerId === value.agentId;
}

function isNativeSessionOrNull(value: unknown, agentId: string): boolean {
  if (value === null) return true;
  return isObject(value)
    && value.ownerId === agentId
    && Number.isSafeInteger(value.schemaVersion)
    && Number(value.schemaVersion) >= 1
    && isObject(value.value);
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
