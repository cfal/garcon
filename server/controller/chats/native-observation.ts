import { isNativeChildKey, parseAgentNativeChildRef } from '@garcon/server-agent-interface';
import { parseChatId } from '../../../common/chat-id.js';
import { isRecord } from '../../../common/json.js';
import { DomainError } from '../../common/domain-error.js';
import type { ChatRegistryEntry, NativeChildObservationOrigin } from './registry-contracts.js';

export function assertChatExecutable(entry: Pick<ChatRegistryEntry, 'nativeObservation'>): void {
  if (entry.nativeObservation) {
    throw new DomainError('CHAT_READ_ONLY', 'Native subagent chats are read-only.', 409, false);
  }
}

export function parseNativeObservationOrigin(value: unknown, agentId: string): NativeChildObservationOrigin | null {
  if (value === null) return null;
  if (!isRecord(value) || value.kind !== 'native-child'
    || !isNativeChildKey(value.sourceOwnershipEpoch) || !isNativeChildKey(value.sourceAgentSessionId)
    || (value.parentKey !== null && !isNativeChildKey(value.parentKey))
    || (value.reportedModel !== null && !isNativeChildKey(value.reportedModel))) {
    throw new Error('Invalid native child observation');
  }
  const sourceChatId = parseChatId(value.sourceChatId);
  const child = parseAgentNativeChildRef(value.child);
  if (!child || child.ownerId !== agentId) throw new Error('Invalid native child observation owner');
  return {
    kind: 'native-child', sourceChatId, child,
    sourceOwnershipEpoch: value.sourceOwnershipEpoch,
    sourceAgentSessionId: value.sourceAgentSessionId,
    parentKey: value.parentKey,
    reportedModel: value.reportedModel,
  };
}

export function assertObservationBindings(entry: Pick<ChatRegistryEntry,
  'nativeObservation' | 'agentSessionId' | 'nativeSession' | 'nativeSeedReceipt' | 'lineage'
  | 'carryOverSegments' | 'carryOverMigrationQuarantine' | 'pendingPreambleBoundary' | 'preambleSelection'>): void {
  if (!entry.nativeObservation) return;
  if (entry.agentSessionId !== null || entry.nativeSession !== null || entry.nativeSeedReceipt !== null
    || entry.lineage !== null || entry.carryOverSegments.length !== 0 || entry.carryOverMigrationQuarantine !== null
    || entry.pendingPreambleBoundary !== null || entry.preambleSelection.revision !== 0
    || entry.preambleSelection.orderedPreambleIds.length !== 0) {
    throw new Error('Native child observation cannot have execution bindings');
  }
}
