import { isNormalizedJsonObject, parseProducerStreamIdentity, snapshotEstablishedSession, type ProducerStreamIdentity } from '@garcon/server-agent-interface';
import { parseChatId } from '../../../common/chat-id.js';
import { isExecutionIdentity, parseExecutionLocation } from '../../../common/execution-location.js';
import { isStoredProjectPath } from '../../../common/execution-nodes.js';
import { parseNodeOperationIdentity, type NodeOperationIdentity } from '../../../common/node-operation.js';
import type { ProviderSessionConfigurationPreparation, ProviderSessionConfigurationRequest, ProviderSessionConfigurationResult } from '../provider-configuration.js';
import { exactNodeFields, isNodeData } from './private-json.js';
import { parseNodeConfigurationUpdate } from './provider-configuration-update-wire.js';

export const MAX_NODE_SESSION_CONFIGURATION_BYTES = 240 * 1024;

export type NodeSessionConfigurationCommand =
  | { readonly method: 'provider-session-configuration'; readonly operation: 'prepare'; readonly instanceId: string;
      readonly stream: ProducerStreamIdentity | null; readonly request: ProviderSessionConfigurationRequest }
  | { readonly method: 'provider-session-configuration'; readonly operation: 'commit' | 'cancel' | 'status'; readonly instanceId: string;
      readonly identity: NodeOperationIdentity };

export type NodeSessionConfigurationPreparation =
  | { readonly kind: 'prepared'; readonly identity: NodeOperationIdentity }
  | { readonly kind: 'refused'; readonly code: NodeSessionConfigurationRefusalCode; readonly retryable: boolean }
  | Exclude<ProviderSessionConfigurationPreparation, { kind: 'prepared' }>;

type NodeSessionConfigurationRefusalCode = 'INVALID_SETTINGS' | 'INVALID_ENDPOINT' | 'OPERATION_UNSUPPORTED' | 'SESSION_BUSY';

export function isNodeSessionConfigurationRefusalCode(value: unknown): value is NodeSessionConfigurationRefusalCode {
  return value === 'INVALID_SETTINGS' || value === 'INVALID_ENDPOINT' || value === 'OPERATION_UNSUPPORTED' || value === 'SESSION_BUSY';
}

export type NodeSessionConfigurationReceipt =
  | { readonly phase: 'prepared' | 'committing' | 'cancelling'; readonly result: null }
  | { readonly phase: 'settled'; readonly result: ProviderSessionConfigurationResult };

export type NodeSessionConfigurationReply =
  | { readonly kind: 'provider-session-configuration-prepared'; readonly instanceId: string;
      readonly preparation: NodeSessionConfigurationPreparation }
  | { readonly kind: 'provider-session-configuration-receipt'; readonly instanceId: string;
      readonly identity: NodeOperationIdentity; readonly receipt: NodeSessionConfigurationReceipt | null };

export function isNodeSessionConfigurationReconciliation(command: NodeSessionConfigurationCommand): boolean {
  return command.operation === 'status' || command.operation === 'cancel';
}

export function parseNodeSessionConfigurationCommand(value: unknown): NodeSessionConfigurationCommand | null {
  if (!bounded(value) || value.method !== 'provider-session-configuration' || !isExecutionIdentity(value.instanceId)) return null;
  if (value.operation === 'prepare' && exactNodeFields(value, ['method', 'operation', 'instanceId', 'stream', 'request'])) {
    const request = parseNodeSessionConfigurationRequest(value.request);
    const stream = value.stream === null ? null : parseProducerStreamIdentity(value.stream);
    return request && (value.stream === null || stream) && request.executionLocation.instanceId === value.instanceId
      ? { method: value.method, operation: value.operation, instanceId: value.instanceId, stream, request } : null;
  }
  if ((value.operation === 'commit' || value.operation === 'cancel' || value.operation === 'status')
    && exactNodeFields(value, ['method', 'operation', 'instanceId', 'identity'])) {
    const identity = parseNodeOperationIdentity(value.identity);
    return identity ? { method: value.method, operation: value.operation, instanceId: value.instanceId, identity } : null;
  }
  return null;
}

export function parseNodeSessionConfigurationRequest(value: unknown): ProviderSessionConfigurationRequest | null {
  if (!bounded(value) || !exactNodeFields(value, ['executionLocation', 'expected', 'previous', 'next'])
    || !exactNodeFields(value.expected, ['chatId', 'agentSessionId', 'projectPath', 'nativeSession'])
    || !isExecutionIdentity(value.expected.agentSessionId)
    || !isStoredProjectPath(value.expected.projectPath)) return null;
  const executionLocation = parseExecutionLocation(value.executionLocation);
  const configuration = parseNodeConfigurationUpdate({ previous: value.previous, next: value.next });
  if (!executionLocation || !configuration) return null;
  try {
    const chatId = parseChatId(value.expected.chatId);
    const { nativeSession } = snapshotEstablishedSession({ agentSessionId: value.expected.agentSessionId,
      nativeSession: value.expected.nativeSession, nativeSeedReceipt: null });
    return { executionLocation, expected: { chatId, agentSessionId: value.expected.agentSessionId,
      projectPath: value.expected.projectPath, nativeSession }, ...configuration };
  } catch { return null; }
}

export function parseNodeSessionConfigurationResult(value: unknown): ProviderSessionConfigurationResult | null {
  if (exactNodeFields(value, ['kind']) && (value.kind === 'applied' || value.kind === 'not-required' || value.kind === 'unknown')) {
    return { kind: value.kind };
  }
  if (exactNodeFields(value, ['kind', 'reason']) && value.kind === 'rejected'
    && (value.reason === 'target-conflict' || value.reason === 'target-changed' || value.reason === 'cancelled')) {
    return { kind: value.kind, reason: value.reason };
  }
  return null;
}

export function parseNodeSessionConfigurationReply(value: unknown): NodeSessionConfigurationReply | null {
  if (!bounded(value) || !isExecutionIdentity(value.instanceId)) return null;
  if (value.kind === 'provider-session-configuration-prepared' && exactNodeFields(value, ['kind', 'instanceId', 'preparation'])) {
    const preparation = value.preparation;
    if (exactNodeFields(preparation, ['kind', 'identity']) && preparation.kind === 'prepared') {
      const identity = parseNodeOperationIdentity(preparation.identity);
      return identity ? { kind: value.kind, instanceId: value.instanceId, preparation: { kind: 'prepared', identity } } : null;
    }
    if (exactNodeFields(preparation, ['kind']) && preparation.kind === 'unsupported') {
      return { kind: value.kind, instanceId: value.instanceId, preparation: { kind: 'unsupported' } };
    }
    if (exactNodeFields(preparation, ['kind', 'code', 'retryable']) && preparation.kind === 'refused'
      && isNodeSessionConfigurationRefusalCode(preparation.code) && typeof preparation.retryable === 'boolean') {
      return { kind: value.kind, instanceId: value.instanceId,
        preparation: { kind: 'refused', code: preparation.code, retryable: preparation.retryable } };
    }
    const result = parseNodeSessionConfigurationResult(preparation);
    return result && (result.kind === 'rejected' || result.kind === 'not-required')
      ? { kind: value.kind, instanceId: value.instanceId, preparation: result } : null;
  }
  if (value.kind !== 'provider-session-configuration-receipt' || !exactNodeFields(value, ['kind', 'instanceId', 'identity', 'receipt'])) return null;
  const identity = parseNodeOperationIdentity(value.identity);
  if (!identity) return null;
  if (value.receipt === null) return { kind: value.kind, instanceId: value.instanceId, identity, receipt: null };
  if (!exactNodeFields(value.receipt, ['phase', 'result'])) return null;
  const { phase, result } = value.receipt;
  if ((phase === 'prepared' || phase === 'committing' || phase === 'cancelling') && result === null) {
    return { kind: value.kind, instanceId: value.instanceId, identity, receipt: { phase, result } };
  }
  const parsed = parseNodeSessionConfigurationResult(result);
  return phase === 'settled' && parsed
    ? { kind: value.kind, instanceId: value.instanceId, identity, receipt: { phase, result: parsed } } : null;
}

function bounded(value: unknown): value is Record<string, unknown> {
  return isNodeData(value) && isNormalizedJsonObject(value) && Buffer.byteLength(JSON.stringify(value)) <= MAX_NODE_SESSION_CONFIGURATION_BYTES;
}
