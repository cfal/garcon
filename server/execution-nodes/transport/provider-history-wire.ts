import { isNormalizedJsonObject } from '@garcon/server-agent-interface';
import { isRecord } from '../../../common/json.js';
import { isExecutionIdentity } from '../../../common/execution-location.js';
import { parseNodeOperationIdentity, sameNodeSession, type NodeOperationIdentity } from '../../../common/node-operation.js';
import { parseNodeBulkDescriptor, parseNodeBulkIdentity, type NodeBulkDescriptor, type NodeBulkIdentity } from './bulk-wire.js';
import { exactNodeFields, isNodeData } from './private-json.js';
import { parseNodeNativeChatReference, type NodeNativeChatReference } from './provider-native-wire.js';
import { MAX_NODE_HISTORY_ROW_BYTES, NODE_HISTORY_ROW_ENCODING } from './provider-history-row.js';

export const MAX_NODE_HISTORY_CONTROL_BYTES = 240 * 1024;
export const NODE_HISTORY_FAILURE_CODES = ['NODE_HISTORY_INVALID', 'NODE_HISTORY_TOO_LARGE', 'NODE_HISTORY_UNAVAILABLE',
  'NODE_HISTORY_SOURCE_FAILED', 'NODE_HISTORY_MULTIPLE_FAILURES', 'NODE_CAPACITY'] as const;
export type NodeHistoryFailureCode = typeof NODE_HISTORY_FAILURE_CODES[number];
export type NodeHistoryFacet = 'legacy' | 'native';

export interface NodeHistoryImportTarget {
  readonly identity: NodeOperationIdentity;
  readonly instanceId: string;
  readonly connectionId: number;
  readonly bulkAttemptId: string;
}

export type NodeProviderHistoryCommand = NodeHistoryImportTarget & { readonly method: 'provider-history-import' } & (
  | { readonly operation: 'open'; readonly workspaceId: string; readonly facet: NodeHistoryFacet; readonly chat: NodeNativeChatReference }
  | { readonly operation: 'next'; readonly sequence: number }
  | { readonly operation: 'transfer'; readonly sequence: number; readonly grant: NodeBulkIdentity; readonly descriptor: NodeBulkDescriptor }
  | { readonly operation: 'cancel' }
);

export type NodeProviderHistoryReply = NodeHistoryImportTarget & { readonly kind: 'provider-history-result' } & (
  | { readonly operation: 'opened' }
  | { readonly operation: 'row'; readonly sequence: number; readonly encoding: typeof NODE_HISTORY_ROW_ENCODING; readonly descriptor: NodeBulkDescriptor }
  | { readonly operation: 'eof' | 'transferred'; readonly sequence: number }
  | { readonly operation: 'cancelled'; readonly settled: boolean }
  | { readonly operation: 'failed'; readonly code: NodeHistoryFailureCode }
);

const targetFields = ['identity', 'instanceId', 'connectionId', 'bulkAttemptId'] as const;

export function parseNodeHistoryImportTarget(value: unknown): NodeHistoryImportTarget | null {
  if (!isNodeData(value) || !isRecord(value) || !isExecutionIdentity(value.instanceId) || !isExecutionIdentity(value.bulkAttemptId)
    || !positive(value.connectionId)) return null;
  const identity = parseNodeOperationIdentity(value.identity);
  return identity ? { identity, instanceId: value.instanceId, connectionId: value.connectionId, bulkAttemptId: value.bulkAttemptId } : null;
}

export function sameNodeHistoryImport(a: NodeHistoryImportTarget, b: NodeHistoryImportTarget): boolean {
  return sameNodeSession(a.identity, b.identity) && a.identity.operationId === b.identity.operationId && a.instanceId === b.instanceId
    && a.connectionId === b.connectionId && a.bulkAttemptId === b.bulkAttemptId;
}

export function matchesNodeHistoryReply(command: NodeProviderHistoryCommand, reply: NodeProviderHistoryReply): boolean {
  if (!sameNodeHistoryImport(command, reply)) return false;
  if (reply.operation === 'failed') return true;
  switch (command.operation) {
    case 'open': return reply.operation === 'opened';
    case 'cancel': return reply.operation === 'cancelled';
    case 'next': return (reply.operation === 'row' || reply.operation === 'eof') && reply.sequence === command.sequence;
    case 'transfer': return reply.operation === 'transferred' && reply.sequence === command.sequence;
  }
}

export function parseNodeProviderHistoryCommand(value: unknown): NodeProviderHistoryCommand | null {
  if (!bounded(value) || value.method !== 'provider-history-import') return null;
  const target = parseNodeHistoryImportTarget(value);
  if (!target) return null;
  const base = { ...target, method: 'provider-history-import' } as const;
  const fields = ['method', 'operation', ...targetFields];
  if (value.operation === 'open' && exactNodeFields(value, [...fields, 'workspaceId', 'facet', 'chat'])
    && isExecutionIdentity(value.workspaceId) && (value.facet === 'legacy' || value.facet === 'native')) {
    const chat = parseNodeNativeChatReference(value.chat);
    return chat ? { ...base, operation: 'open', workspaceId: value.workspaceId, facet: value.facet, chat } : null;
  }
  if (value.operation === 'cancel' && exactNodeFields(value, fields)) return { ...base, operation: 'cancel' };
  if (value.operation === 'next' && exactNodeFields(value, [...fields, 'sequence']) && positive(value.sequence)) {
    return { ...base, operation: 'next', sequence: value.sequence };
  }
  if (value.operation === 'transfer' && exactNodeFields(value, [...fields, 'sequence', 'grant', 'descriptor']) && positive(value.sequence)) {
    const grant = parseNodeBulkIdentity(value.grant); const descriptor = rowDescriptor(value.descriptor);
    return grant && sameNodeSession(grant, target.identity) && descriptor
      ? { ...base, operation: 'transfer', sequence: value.sequence, grant, descriptor } : null;
  }
  return null;
}

export function parseNodeProviderHistoryReply(value: unknown): NodeProviderHistoryReply | null {
  if (!bounded(value) || value.kind !== 'provider-history-result') return null;
  const target = parseNodeHistoryImportTarget(value);
  if (!target) return null;
  const base = { ...target, kind: 'provider-history-result' } as const;
  const fields = ['kind', 'operation', ...targetFields];
  if (value.operation === 'opened' && exactNodeFields(value, fields)) return { ...base, operation: 'opened' };
  if (value.operation === 'cancelled' && exactNodeFields(value, [...fields, 'settled']) && typeof value.settled === 'boolean') {
    return { ...base, operation: 'cancelled', settled: value.settled };
  }
  if (value.operation === 'failed' && exactNodeFields(value, [...fields, 'code'])
    && NODE_HISTORY_FAILURE_CODES.some((code) => code === value.code)) return { ...base, operation: 'failed', code: value.code as NodeHistoryFailureCode };
  if ((value.operation === 'eof' || value.operation === 'transferred') && exactNodeFields(value, [...fields, 'sequence']) && positive(value.sequence)) {
    return { ...base, operation: value.operation, sequence: value.sequence };
  }
  if (value.operation === 'row' && exactNodeFields(value, [...fields, 'sequence', 'encoding', 'descriptor'])
    && positive(value.sequence) && value.encoding === NODE_HISTORY_ROW_ENCODING) {
    const descriptor = rowDescriptor(value.descriptor);
    return descriptor ? { ...base, operation: 'row', sequence: value.sequence, encoding: NODE_HISTORY_ROW_ENCODING, descriptor } : null;
  }
  return null;
}

function rowDescriptor(value: unknown): NodeBulkDescriptor | null {
  const descriptor = parseNodeBulkDescriptor(value);
  return descriptor && descriptor.byteLength > 0 && descriptor.byteLength <= MAX_NODE_HISTORY_ROW_BYTES ? descriptor : null;
}
function positive(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0; }
function bounded(value: unknown): value is Record<string, unknown> {
  return isNodeData(value) && isNormalizedJsonObject(value) && Buffer.byteLength(JSON.stringify(value)) <= MAX_NODE_HISTORY_CONTROL_BYTES;
}
