import { NODE_WIRE_VERSION, isNormalizedJsonObject, parseProducerStreamIdentity, type ProducerStreamIdentity } from '@garcon/server-agent-interface';
import type { PermissionDecisionPayload } from '../../../common/chat-command-contracts.js';
import { isExecutionIdentity } from '../../../common/execution-location.js';
import { isPermissionOccurrenceId } from '../../../common/permission-occurrence.js';
import { exactNodeFields, parsePrivateNodeJson } from './private-json.js';

export const MAX_NODE_PERMISSION_BYTES = 64 * 1024;

export interface NodePermissionReference {
  readonly stream: ProducerStreamIdentity;
  readonly handle: string;
  readonly runId: string;
  readonly permissionOccurrenceId: string;
}

export interface NodePermissionReceipt {
  readonly permission: NodePermissionReference;
  readonly phase: 'available' | 'pending' | 'resolved' | 'unknown' | 'expired';
}

export type NodePermissionCommand = {
  readonly method: 'permission-respond';
  readonly permission: NodePermissionReference;
  readonly decision: PermissionDecisionPayload;
} | {
  readonly method: 'permission-status';
  readonly permission: NodePermissionReference;
};

/** A null receipt includes settled history evicted from the node's bounded reconciliation window. */
export type NodePermissionResult =
  | { readonly kind: 'permission'; readonly receipt: NodePermissionReceipt | null }
  | { readonly kind: 'rejected'; readonly code: 'VALIDATION_FAILED' | 'NODE_SESSION_EXPIRED' | 'NODE_UNAVAILABLE' | 'NODE_CAPACITY' }
  | { readonly kind: 'unknown' };

export function parseNodePermissionReference(value: unknown): NodePermissionReference | null {
  if (!exactNodeFields(value, ['stream', 'handle', 'runId', 'permissionOccurrenceId'])
    || !isExecutionIdentity(value.handle) || !isExecutionIdentity(value.runId) || !isPermissionOccurrenceId(value.permissionOccurrenceId)) return null;
  const stream = parseProducerStreamIdentity(value.stream);
  return stream ? Object.freeze({ stream: Object.freeze(stream), handle: value.handle, runId: value.runId,
    permissionOccurrenceId: value.permissionOccurrenceId }) : null;
}

export function parseNodePermissionDecision(value: unknown): PermissionDecisionPayload | null {
  if (!isNormalizedJsonObject(value) || !exactNodeFields(value, ['allow'], ['alwaysAllow', 'response']) || typeof value.allow !== 'boolean'
    || value.alwaysAllow !== undefined && typeof value.alwaysAllow !== 'boolean') return null;
  try {
    const decision = parsePrivateNodeJson(JSON.stringify(value), MAX_NODE_PERMISSION_BYTES);
    if (!decision || decision.response !== undefined && (decision.response === null || typeof decision.response !== 'object' || Array.isArray(decision.response))) return null;
    return { allow: value.allow, alwaysAllow: value.alwaysAllow ?? false,
      ...(decision.response === undefined ? {} : { response: decision.response as Record<string, unknown> }) };
  } catch { return null; }
}

export function parseNodePermissionCommandText(text: string): NodePermissionCommand | null {
  const value = parsePrivateNodeJson(text, MAX_NODE_PERMISSION_BYTES);
  if (!exactNodeFields(value, ['version', 'method', 'permission'], ['decision']) || value.version !== NODE_WIRE_VERSION) return null;
  const permission = parseNodePermissionReference(value.permission);
  if (!permission) return null;
  if (value.method === 'permission-status' && exactNodeFields(value, ['version', 'method', 'permission'])) return { method: value.method, permission };
  if (value.method !== 'permission-respond') return null;
  const decision = parseNodePermissionDecision(value.decision);
  return decision ? { method: value.method, permission, decision } : null;
}

export function serializeNodePermissionCommand(command: NodePermissionCommand): string {
  if (!isNormalizedJsonObject(command)) throw new TypeError('Invalid node permission command');
  const text = JSON.stringify({ version: NODE_WIRE_VERSION, ...command });
  if (!parseNodePermissionCommandText(text)) throw new TypeError('Invalid node permission command');
  return text;
}

export function parseNodePermissionResultText(text: string): NodePermissionResult | null {
  const value = parsePrivateNodeJson(text, MAX_NODE_PERMISSION_BYTES);
  if (!value || value.version !== NODE_WIRE_VERSION) return null;
  if (value.kind === 'unknown' && exactNodeFields(value, ['version', 'kind'])) return { kind: 'unknown' };
  if (value.kind === 'rejected' && exactNodeFields(value, ['version', 'kind', 'code'])
    && (value.code === 'VALIDATION_FAILED' || value.code === 'NODE_SESSION_EXPIRED' || value.code === 'NODE_UNAVAILABLE' || value.code === 'NODE_CAPACITY')) return { kind: value.kind, code: value.code };
  if (value.kind !== 'permission' || !exactNodeFields(value, ['version', 'kind', 'receipt'])) return null;
  if (value.receipt === null) return { kind: 'permission', receipt: null };
  if (!exactNodeFields(value.receipt, ['permission', 'phase'])) return null;
  const permission = parseNodePermissionReference(value.receipt.permission);
  const phase = value.receipt.phase;
  return permission && (phase === 'available' || phase === 'pending' || phase === 'resolved' || phase === 'unknown' || phase === 'expired')
    ? { kind: 'permission', receipt: { permission, phase } } : null;
}

export function serializeNodePermissionResult(result: NodePermissionResult): string {
  if (!isNormalizedJsonObject(result)) throw new TypeError('Invalid node permission result');
  const text = JSON.stringify({ version: NODE_WIRE_VERSION, ...result });
  if (!parseNodePermissionResultText(text)) throw new TypeError('Invalid node permission result');
  return text;
}
