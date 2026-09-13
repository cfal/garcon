import { isNormalizedJsonObject, type AgentNativeSessionRef, type AgentTranscriptSourceLocation } from '@garcon/server-agent-interface';
import { parseChatId } from '../../../common/chat-id.js';
import { isExecutionIdentity } from '../../../common/execution-location.js';
import { parseNativeSeedReceipt } from '../../../common/transcript-seed.js';
import type { ProviderNativeChatReference } from '../provider-native-sessions.js';
import { exactNodeFields, isNodeData, nodeString } from './private-json.js';
import { parseNodeProviderSettings } from './provider-configuration-wire.js';

export const MAX_NODE_NATIVE_SERVICE_BYTES = 240 * 1024;

export type NodeNativeChatReference = Omit<ProviderNativeChatReference, 'projectPath'>;

export type NodeProviderNativeCommand = {
  readonly method: 'provider-native-sessions';
  readonly instanceId: string;
  readonly workspaceId: string;
  readonly chat: NodeNativeChatReference;
} & (
  | { readonly operation: 'resolve' | 'describe' }
  | { readonly operation: 'release'; readonly reason: 'deleted' | 'transferred' }
);

export type NodeProviderNativeReply = {
  readonly kind: 'provider-native-result';
  readonly instanceId: string;
  readonly workspaceId: string;
} & (
  | { readonly operation: 'resolve'; readonly reference: AgentNativeSessionRef | null }
  | { readonly operation: 'describe'; readonly source: AgentTranscriptSourceLocation | null }
  | { readonly operation: 'release' }
);

export function parseNodeNativeChatReference(value: unknown): NodeNativeChatReference | null {
  if (!bounded(value) || !exactNodeFields(value, ['chatId', 'agentId', 'agentSessionId', 'model', 'nativeSession',
    'carryOverRevision', 'nativeSeedReceipt', 'settings']) || !isExecutionIdentity(value.agentId)
    || value.agentSessionId !== null && !nodeString(value.agentSessionId, 32_768)
    || !nodeString(value.model, 4096, true) || !nodeString(value.carryOverRevision, 4096, true)) return null;
  const nativeSession = value.nativeSession === null ? null : parseNodeNativeSessionReference(value.nativeSession);
  if (value.nativeSession !== null && (!nativeSession || nativeSession.ownerId !== value.agentId)) return null;
  const settings = value.settings === null ? null : parseNodeProviderSettings(value.settings);
  if (value.settings !== null && (!settings || settings.ownerId !== value.agentId)) return null;
  const receipt = value.nativeSeedReceipt;
  if (receipt !== null && !exactNodeFields(receipt, ['agentSessionId', 'placement', 'format', 'codeUnitLength', 'sha256'])) return null;
  const nativeSeedReceipt = receipt === null ? null : parseNativeSeedReceipt(receipt);
  if (receipt !== null && (!nativeSeedReceipt || nativeSeedReceipt.agentSessionId !== value.agentSessionId)) return null;
  try {
    return { chatId: parseChatId(value.chatId), agentId: value.agentId, agentSessionId: value.agentSessionId as string | null,
      model: value.model, nativeSession, carryOverRevision: value.carryOverRevision, nativeSeedReceipt, settings };
  } catch { return null; }
}

export function parseNodeNativeSessionReference(value: unknown): AgentNativeSessionRef | null {
  if (!bounded(value) || !exactNodeFields(value, ['ownerId', 'schemaVersion', 'value']) || !isExecutionIdentity(value.ownerId)
    || !Number.isSafeInteger(value.schemaVersion) || Number(value.schemaVersion) < 1 || !isNormalizedJsonObject(value.value)) return null;
  return { ownerId: value.ownerId, schemaVersion: Number(value.schemaVersion), value: structuredClone(value.value) };
}

export function parseNodeProviderNativeCommand(value: unknown): NodeProviderNativeCommand | null {
  if (!bounded(value) || value.method !== 'provider-native-sessions' || !isExecutionIdentity(value.instanceId)
    || !isExecutionIdentity(value.workspaceId)) return null;
  const chat = parseNodeNativeChatReference(value.chat);
  if (!chat) return null;
  const base = { method: 'provider-native-sessions', instanceId: value.instanceId, workspaceId: value.workspaceId, chat } as const;
  if ((value.operation === 'resolve' || value.operation === 'describe')
    && exactNodeFields(value, ['method', 'instanceId', 'workspaceId', 'chat', 'operation'])) return { ...base, operation: value.operation };
  if (value.operation === 'release' && (value.reason === 'deleted' || value.reason === 'transferred')
    && exactNodeFields(value, ['method', 'instanceId', 'workspaceId', 'chat', 'operation', 'reason'])) {
    return { ...base, operation: value.operation, reason: value.reason };
  }
  return null;
}

export function parseNodeProviderNativeReply(value: unknown): NodeProviderNativeReply | null {
  if (!bounded(value) || value.kind !== 'provider-native-result' || !isExecutionIdentity(value.instanceId)
    || !isExecutionIdentity(value.workspaceId)) return null;
  const base = { kind: 'provider-native-result', instanceId: value.instanceId, workspaceId: value.workspaceId } as const;
  if (value.operation === 'release' && exactNodeFields(value, ['kind', 'instanceId', 'workspaceId', 'operation'])) {
    return { ...base, operation: value.operation };
  }
  if (value.operation === 'resolve' && exactNodeFields(value, ['kind', 'instanceId', 'workspaceId', 'operation', 'reference'])) {
    const reference = value.reference === null ? null : parseNodeNativeSessionReference(value.reference);
    return value.reference === null || reference ? { ...base, operation: value.operation, reference } : null;
  }
  if (value.operation === 'describe' && exactNodeFields(value, ['kind', 'instanceId', 'workspaceId', 'operation', 'source'])) {
    const source = value.source;
    if (source === null) return { ...base, operation: value.operation, source: null };
    if (exactNodeFields(source, ['kind', 'value']) && (source.kind === 'filesystem-path' || source.kind === 'provider-reference')
      && nodeString(source.value, 32_768)) return { ...base, operation: value.operation, source: { kind: source.kind, value: source.value } };
  }
  return null;
}

function bounded(value: unknown): value is Record<string, unknown> {
  return isNodeData(value) && isNormalizedJsonObject(value) && Buffer.byteLength(JSON.stringify(value)) <= MAX_NODE_NATIVE_SERVICE_BYTES;
}
