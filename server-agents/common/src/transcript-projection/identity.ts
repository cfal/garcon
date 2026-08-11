import crypto from 'node:crypto';
import type {
  AgentEventDigest,
  AgentOwnershipEpoch,
  AgentProjectionState,
  AgentSegmentIdentity,
  AgentStreamCheckpoint,
  AgentStreamEpoch,
  AgentStreamOffset,
  AgentTranscriptContentEpoch,
  AgentTranscriptEntryId,
  AgentTranscriptSourceIdentity,
} from '@garcon/server-agent-interface';
import { agentOwnershipEpoch } from '@garcon/server-agent-interface';
import { stableJsonStringify } from '@garcon/common/json';

export function newAgentOwnershipEpoch(): AgentOwnershipEpoch {
  return agentOwnershipEpoch(crypto.randomUUID());
}

export function newAgentStreamEpoch(): AgentStreamEpoch {
  return crypto.randomUUID() as AgentStreamEpoch;
}

export function newAgentTranscriptContentEpoch(): AgentTranscriptContentEpoch {
  return crypto.randomUUID() as AgentTranscriptContentEpoch;
}

export function newAgentTranscriptEntryId(): AgentTranscriptEntryId {
  return crypto.randomUUID() as AgentTranscriptEntryId;
}

export function agentTranscriptEntryId(value: string): AgentTranscriptEntryId {
  return required(value, 'Transcript entry ID') as AgentTranscriptEntryId;
}

export function agentStreamEpoch(value: string): AgentStreamEpoch {
  return required(value, 'Stream epoch') as AgentStreamEpoch;
}

export function agentTranscriptContentEpoch(value: string): AgentTranscriptContentEpoch {
  return required(value, 'Transcript content epoch') as AgentTranscriptContentEpoch;
}

export function agentEventDigest(value: string): AgentEventDigest {
  return required(value, 'Event digest') as AgentEventDigest;
}

export function agentStreamOffset(value: number | string): AgentStreamOffset {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || String(parsed) !== String(value)) {
    throw new TypeError('Stream offset must be a canonical non-negative safe integer');
  }
  return String(parsed) as AgentStreamOffset;
}

export function compareAgentStreamOffsets(
  left: AgentStreamOffset,
  right: AgentStreamOffset,
): -1 | 0 | 1 {
  const leftValue = Number(left);
  const rightValue = Number(right);
  if (!Number.isSafeInteger(leftValue) || !Number.isSafeInteger(rightValue)) {
    throw new TypeError('Invalid stream offset');
  }
  return leftValue === rightValue ? 0 : leftValue < rightValue ? -1 : 1;
}

export function nextAgentStreamOffset(offset: AgentStreamOffset): AgentStreamOffset {
  return agentStreamOffset(Number(offset) + 1);
}

export function sourceIdentityKey(source: AgentTranscriptSourceIdentity): string {
  validateSourceIdentity(source);
  return stableJsonStringify([source.namespace, source.itemId, source.subrowId]);
}

export function validateSourceIdentity(source: AgentTranscriptSourceIdentity): void {
  required(source.namespace, 'Source namespace');
  required(source.itemId, 'Source item ID');
  required(source.subrowId, 'Source subrow ID');
}

export function sameSegment(
  left: AgentSegmentIdentity,
  right: AgentSegmentIdentity,
): boolean {
  return left.chatId === right.chatId
    && left.agentOwnershipEpoch === right.agentOwnershipEpoch;
}

export function sameProjectionState(
  left: AgentProjectionState,
  right: AgentProjectionState,
): boolean {
  return left.epoch === right.epoch
    && left.contentEpoch === right.contentEpoch
    && left.total === right.total
    && left.durableCount === right.durableCount
    && left.durableRevision === right.durableRevision
    && left.stateRevision === right.stateRevision;
}

export function sameCheckpoint(
  left: AgentStreamCheckpoint,
  right: AgentStreamCheckpoint,
): boolean {
  return sameSegment(left, right)
    && left.offset === right.offset
    && sameProjectionState(left.projection, right.projection);
}

function required(value: string, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} is required`);
  return value;
}
