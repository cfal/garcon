import { isRecord } from './json.js';
import { isExecutionIdentity } from './execution-location.js';

export interface NodeSessionIdentity {
  readonly controllerBootId: string;
  readonly nodeBootId: string;
  readonly logicalSessionId: string;
}

export interface NodeOperationIdentity extends NodeSessionIdentity {
  readonly operationId: string;
}

export type NodeOperationResult<T, Code extends string> =
  | { readonly kind: 'completed'; readonly value: T }
  | { readonly kind: 'rejected'; readonly code: Code; readonly message: string }
  | { readonly kind: 'unknown'; readonly operationId: string };

export const NODE_ERROR_CODES = [
  'NODE_UNAVAILABLE', 'NODE_REPLAY_GAP', 'NODE_SESSION_EXPIRED', 'NODE_INCOMPATIBLE',
  'NODE_TLS_UNTRUSTED', 'NODE_REMOVED', 'NODE_CAPACITY', 'NODE_OPERATION_UNKNOWN', 'NODE_UNAUTHORIZED',
] as const;
export type NodeErrorCode = typeof NODE_ERROR_CODES[number];

export function isNodeErrorCode(value: unknown): value is NodeErrorCode {
  return typeof value === 'string' && (NODE_ERROR_CODES as readonly string[]).includes(value);
}

export function parseNodeSessionIdentity(value: unknown): NodeSessionIdentity | null {
  if (!isRecord(value) || Object.keys(value).length !== 3
    || !['controllerBootId', 'nodeBootId', 'logicalSessionId'].every((key) => Object.hasOwn(value, key))
    || !isExecutionIdentity(value.controllerBootId) || !isExecutionIdentity(value.nodeBootId)
    || !isExecutionIdentity(value.logicalSessionId)) return null;
  return { controllerBootId: value.controllerBootId, nodeBootId: value.nodeBootId, logicalSessionId: value.logicalSessionId };
}

export function parseNodeOperationIdentity(value: unknown): NodeOperationIdentity | null {
  if (!isRecord(value) || Object.keys(value).length !== 4
    || !['controllerBootId', 'nodeBootId', 'logicalSessionId', 'operationId'].every((key) => Object.hasOwn(value, key))
    || !isExecutionIdentity(value.operationId)) return null;
  const session = parseNodeSessionIdentity({
    controllerBootId: value.controllerBootId, nodeBootId: value.nodeBootId, logicalSessionId: value.logicalSessionId,
  });
  return session ? { ...session, operationId: value.operationId } : null;
}

export function sameNodeSession(a: NodeSessionIdentity, b: NodeSessionIdentity): boolean {
  return a.controllerBootId === b.controllerBootId && a.nodeBootId === b.nodeBootId
    && a.logicalSessionId === b.logicalSessionId;
}
