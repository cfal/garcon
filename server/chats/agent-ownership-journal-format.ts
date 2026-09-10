import { parseAgentSettingsEnvelope } from '@garcon/common/agent-integration';
import { isPermissionMode, isThinkingMode } from '@garcon/common/chat-modes';
import type { AgentChatReference } from '@garcon/server-agent-interface';
import type { ResolvedAgentHandoffTarget } from '../agents/agent-handoff-types.js';
import { parseExecutionLocation } from '../../common/execution-location.js';
import { isStoredProjectPath } from '../../common/execution-nodes.js';
import type { AgentOwnershipJournalFileV5 } from './legacy-ownership-journal-v5.js';
import {
  AGENT_OWNERSHIP_JOURNAL_VERSION,
  type AgentHandoffIntent,
  type AgentOwnershipJournalFile,
  type DeleteIntent,
  type NativeReleaseChatReference,
} from './agent-ownership-journal.js';

// The journal is rewritten on mutation, not on version bumps, so a workspace that never
// handed off or deleted a chat keeps whatever version it was created with. An empty one
// holds nothing a format change could have reshaped; anything else fails closed below.
export function isEmptyEarlierJournal(value: unknown): boolean {
  if (!isObject(value) || !Number.isSafeInteger(value.version)) return false;
  if (Number(value.version) < 0 || Number(value.version) >= AGENT_OWNERSHIP_JOURNAL_VERSION) return false;
  return isEmptyArray(value.ownershipIntents)
    && (value.transferCleanup === undefined || isEmptyArray(value.transferCleanup));
}

function isEmptyArray(value: unknown): boolean {
  return Array.isArray(value) && value.length === 0;
}

// Rejects the whole journal when any durable decision is malformed.
export function isOwnershipJournal(value: unknown): value is AgentOwnershipJournalFile {
  if (!isObject(value) || value.version !== AGENT_OWNERSHIP_JOURNAL_VERSION) return false;
  return Array.isArray(value.ownershipIntents)
    && value.ownershipIntents.every(isOwnershipIntent);
}

export function isJournalV5(value: unknown): value is AgentOwnershipJournalFileV5 {
  return isObject(value) && value.version === 5 && Array.isArray(value.ownershipIntents)
    && value.ownershipIntents.every((intent) => {
      if (!isIntentBase(intent)) return false;
      if (intent.kind === 'delete') {
        return intent.version === 2 && isDeleteFields(intent) && Array.isArray(intent.releaseReferences)
          && intent.releaseReferences.every(isAgentChatReference);
      }
      return intent.kind === 'handoff' && intent.version === 5 && isHandoffFields(intent);
    });
}

function isIntentBase(value: unknown): value is Record<string, unknown> {
  return isObject(value) && typeof value.operationId === 'string' && typeof value.chatId === 'string';
}

function isOwnershipIntent(value: unknown): value is AgentHandoffIntent | DeleteIntent {
  if (!isObject(value) || typeof value.operationId !== 'string'
      || typeof value.chatId !== 'string') return false;
  if (value.kind === 'delete') return isDeleteIntent(value);
  return value.kind === 'handoff' && isHandoffIntent(value);
}

function isDeleteIntent(value: Record<string, unknown>): boolean {
  return value.version === 3 && isDeleteFields(value)
    && Array.isArray(value.releaseReferences)
    && value.releaseReferences.every((reference) => isObject(reference)
      && parseExecutionLocation(reference.executionLocation) !== null && isNativeReleaseChatReference(reference.chat));
}

function isDeleteFields(value: Record<string, unknown>): boolean {
  return (value.phase === 'prepared' || value.phase === 'registry-removed')
    && (value.sourceEpoch === null || typeof value.sourceEpoch === 'string')
    && typeof value.createdAt === 'string';
}

function isHandoffIntent(value: Record<string, unknown>): boolean {
  return value.version === 6 && isHandoffFields(value) && isObject(value.source)
    && parseExecutionLocation(value.source.executionLocation) !== null
    && isObject(value.target) && isObject(value.target.execution)
    && parseExecutionLocation(value.target.execution.executionLocation) !== null
    && isStoredProjectPath(value.target.execution.projectPath);
}

function isHandoffFields(value: Record<string, unknown>): boolean {
  const source = value.source;
  const target = value.target;
  const watermark = value.watermark;
  return (value.phase === 'commit-decided' || value.phase === 'registry-committed')
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

function isResolvedHandoffTarget(value: unknown): value is Omit<ResolvedAgentHandoffTarget, 'executionLocation' | 'projectPath'> {
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
  return isNativeReleaseChatReference(value) && value.settings !== null;
}

function isNativeReleaseChatReference(value: unknown): value is NativeReleaseChatReference {
  if (!isObject(value)) return false;
  const settings = parseAgentSettingsEnvelope(value.settings);
  return nonEmptyString(value.chatId)
    && nonEmptyString(value.agentId)
    && nullableString(value.agentSessionId)
    && typeof value.projectPath === 'string'
    && typeof value.model === 'string'
    && isNativeSessionOrNull(value.nativeSession, value.agentId)
    && typeof value.carryOverRevision === 'string'
    && (value.settings === null || (settings !== null && settings.ownerId === value.agentId));
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
