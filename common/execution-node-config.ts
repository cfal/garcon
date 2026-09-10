import { parseControllerTlsTrust, type ControllerTlsTrust } from './controller-tls.js';
import { isExecutionIdentity } from './execution-location.js';
import { isRecord } from './json.js';

export const NODE_ENROLLMENT_TTL_MS = 10 * 60_000;
export const NODE_ENROLLMENT_TIMEOUT_MS = 10_000;
export const MAX_NODE_ENROLLMENT_EXCHANGE_BYTES = 4096;
export const MAX_NODE_PAIRING_DOCUMENT_BYTES = 512 * 1024;
export const NODE_PAIRING_ERROR_CODES = [
  'NODE_ALREADY_PAIRED', 'NODE_PAIRING_CAPACITY', 'NODE_PAIRING_UNAVAILABLE',
  'NODE_ENROLLMENT_INVALID', 'NODE_ENROLLMENT_EXPIRED', 'NODE_ADMIN_REQUIRED', 'NODE_TLS_REQUIRED',
  'NODE_ENROLLMENT_CANCELLED',
] as const;

export interface NodeEnrollmentBundle {
  readonly version: 1;
  readonly controllerId: string;
  readonly nodeId: string;
  readonly controllerUrl: string;
  readonly trust: ControllerTlsTrust;
  readonly expiresAt: string;
  readonly token: string;
}

export interface NodeEnrollmentRequest {
  readonly version: 1;
  readonly controllerId: string;
  readonly nodeId: string;
  readonly token: string;
}

export interface NodeEnrollmentResponse {
  readonly version: 1;
  readonly controllerId: string;
  readonly nodeId: string;
  readonly credential: string;
}

export interface ExecutionNodePairing extends NodeEnrollmentResponse {
  readonly controllerUrl: string;
  readonly trust: ControllerTlsTrust;
}

export interface NodeEnrollmentIssueRequest {
  readonly nodeId: string;
}

export function parseNodeEnrollmentIssueRequest(value: unknown): NodeEnrollmentIssueRequest | null {
  return isRecord(value) && keys(value, ['nodeId']) && isExecutionIdentity(value.nodeId) ? { nodeId: value.nodeId } : null;
}

/** Accepts only an explicit HTTPS origin; paths and redirects cannot retarget credentials. */
export function parseControllerOrigin(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048 || !/^https:\/\/[^/\\@?#\s]+\/?$/.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password
      || url.pathname !== '/' || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function parseNodeEnrollmentBundle(value: unknown): NodeEnrollmentBundle | null {
  if (!isRecord(value) || !keys(value, ['version', 'controllerId', 'nodeId', 'controllerUrl', 'trust', 'expiresAt', 'token'])
    || value.version !== 1 || !isExecutionIdentity(value.controllerId) || !isExecutionIdentity(value.nodeId) || !isPairingTimestamp(value.expiresAt)
    || !parsePairingSecret(value.token, 'enroll')) return null;
  const controllerUrl = parseControllerOrigin(value.controllerUrl);
  const trust = parseControllerTlsTrust(value.trust);
  return controllerUrl && trust
    ? { version: 1, controllerId: value.controllerId, nodeId: value.nodeId, controllerUrl, trust, expiresAt: value.expiresAt, token: value.token as string }
    : null;
}

export function parseNodeEnrollmentRequest(value: unknown): NodeEnrollmentRequest | null {
  if (!isRecord(value) || !keys(value, ['version', 'controllerId', 'nodeId', 'token']) || value.version !== 1
    || !isExecutionIdentity(value.controllerId) || !isExecutionIdentity(value.nodeId) || !parsePairingSecret(value.token, 'enroll')) return null;
  return { version: 1, controllerId: value.controllerId, nodeId: value.nodeId, token: value.token as string };
}

export function parseNodeEnrollmentResponse(value: unknown): NodeEnrollmentResponse | null {
  if (!isRecord(value) || !keys(value, ['version', 'controllerId', 'nodeId', 'credential'])
    || value.version !== 1 || !isExecutionIdentity(value.controllerId) || !isExecutionIdentity(value.nodeId)
    || parsePairingSecret(value.credential, 'node')?.id !== value.nodeId) return null;
  return { version: 1, controllerId: value.controllerId, nodeId: value.nodeId, credential: value.credential as string };
}

export function parseExecutionNodePairing(value: unknown): ExecutionNodePairing | null {
  if (!isRecord(value) || !keys(value, ['version', 'controllerId', 'controllerUrl', 'trust', 'nodeId', 'credential'])) return null;
  const response = parseNodeEnrollmentResponse({
    version: value.version, controllerId: value.controllerId, nodeId: value.nodeId, credential: value.credential,
  });
  const controllerUrl = parseControllerOrigin(value.controllerUrl);
  const trust = parseControllerTlsTrust(value.trust);
  return response && controllerUrl && trust ? { ...response, controllerUrl, trust } : null;
}

export function parsePairingSecret(value: unknown, kind: 'enroll' | 'node'): { readonly id: string } | null {
  if (typeof value !== 'string' || value.length > 180) return null;
  const parts = value.split('.');
  if (parts.length !== 3 || parts[0] !== kind || !isExecutionIdentity(parts[1])
    || !/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(parts[2]!)) return null;
  return { id: parts[1] };
}

export function isPairingTimestamp(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function keys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Reflect.ownKeys(value).length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}
