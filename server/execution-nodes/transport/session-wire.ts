import { NODE_WIRE_VERSION } from '@garcon/server-agent-interface';
import { isExecutionIdentity } from '../../../common/execution-location.js';
import { parseNodeSessionIdentity, type NodeSessionIdentity } from '../../../common/node-operation.js';
import { parseNodeProviderManifest, type NodeProviderManifest } from '../provider-manifest.js';
import { exactNodeFields, parsePrivateNodeJson } from './private-json.js';

export const MAX_NODE_SESSION_CONTROL_BYTES = 4096;
export const MAX_NODE_SESSION_READY_BYTES = 2 * 1024 * 1024;
export const MAX_NODE_SESSION_MANIFESTS = 64;
export const NODE_HANDSHAKE_TIMEOUT_MS = 10_000;
export const MAX_NODE_READINESS_TIMEOUT_MS = 60_000;
export const NODE_SESSION_REJECTION_CODES = ['NODE_INCOMPATIBLE', 'NODE_UNAVAILABLE', 'NODE_SESSION_EXPIRED', 'NODE_READINESS_TIMEOUT'] as const;
export type NodeSessionRejectionCode = typeof NODE_SESSION_REJECTION_CODES[number];

export class NodeSessionHandshakeError extends Error {
  constructor(readonly code: NodeSessionRejectionCode | 'NODE_PROTOCOL' | 'NODE_HANDSHAKE_TIMEOUT' | 'NODE_READINESS_TIMEOUT' | 'NODE_UNAUTHORIZED' | 'NODE_REMOVED') {
    super('Execution node connection could not be established');
    this.name = 'NodeSessionHandshakeError';
  }
}

export interface NodeControllerHello {
  readonly type: 'node-controller-hello';
  /** Retains an unsupported version so authentication can report explicit incompatibility before opening authority. */
  readonly version: number;
  readonly controllerId: string;
  readonly controllerBootId: string;
  readonly nodeId: string;
}

export interface NodeSessionAccepted {
  readonly type: 'node-session-accepted';
  readonly version: typeof NODE_WIRE_VERSION;
  readonly controllerId: string;
  readonly nodeId: string;
  readonly session: NodeSessionIdentity;
  readonly connectionId: number;
  readonly readinessTimeoutMs: number;
}

export interface NodeSessionReady {
  readonly type: 'node-session-ready';
  readonly version: typeof NODE_WIRE_VERSION;
  readonly session: NodeSessionIdentity;
  readonly connectionId: number;
  readonly manifests: readonly NodeProviderManifest[];
}

export interface NodeSessionRejected {
  readonly type: 'node-session-rejected';
  readonly version: typeof NODE_WIRE_VERSION;
  readonly code: NodeSessionRejectionCode;
}

export type NodeSessionFrame = NodeControllerHello | NodeSessionAccepted | NodeSessionReady | NodeSessionRejected;

export function parseNodeSessionFrameText(text: string): NodeSessionFrame | null {
  const value = parsePrivateNodeJson(text, MAX_NODE_SESSION_READY_BYTES);
  if (!value) return null;
  if (value.type === 'node-session-ready') {
    if (value.version !== NODE_WIRE_VERSION || !exactNodeFields(value, ['type', 'version', 'session', 'connectionId', 'manifests'])
      || !connectionId(value.connectionId) || !Array.isArray(value.manifests) || value.manifests.length > MAX_NODE_SESSION_MANIFESTS) return null;
    const session = parseNodeSessionIdentity(value.session);
    if (!session) return null;
    const manifests: NodeProviderManifest[] = [];
    for (const entry of value.manifests) {
      const manifest = parseNodeProviderManifest(entry);
      if (!manifest || manifests.some((prior) => prior.instanceId === manifest.instanceId || prior.nodeId !== manifest.nodeId)) return null;
      manifests.push(manifest);
    }
    return { type: value.type, version: NODE_WIRE_VERSION, session, connectionId: value.connectionId, manifests };
  }
  if (Buffer.byteLength(text) > MAX_NODE_SESSION_CONTROL_BYTES) return null;
  if (value.type === 'node-controller-hello') {
    if (!exactNodeFields(value, ['type', 'version', 'controllerId', 'controllerBootId', 'nodeId'])
      || !Number.isSafeInteger(value.version) || Number(value.version) < 1
      || !isExecutionIdentity(value.controllerId) || !isExecutionIdentity(value.controllerBootId) || !isExecutionIdentity(value.nodeId)) return null;
    return { type: value.type, version: Number(value.version), controllerId: value.controllerId,
      controllerBootId: value.controllerBootId, nodeId: value.nodeId };
  }
  if (value.version !== NODE_WIRE_VERSION) return null;
  if (value.type === 'node-session-accepted') {
    if (!exactNodeFields(value, ['type', 'version', 'controllerId', 'nodeId', 'session', 'connectionId', 'readinessTimeoutMs'])
      || !isExecutionIdentity(value.controllerId) || !isExecutionIdentity(value.nodeId) || !connectionId(value.connectionId)
      || !Number.isSafeInteger(value.readinessTimeoutMs) || Number(value.readinessTimeoutMs) < 1
      || Number(value.readinessTimeoutMs) > MAX_NODE_READINESS_TIMEOUT_MS) return null;
    const session = parseNodeSessionIdentity(value.session);
    return session ? { type: value.type, version: NODE_WIRE_VERSION, controllerId: value.controllerId,
      nodeId: value.nodeId, session, connectionId: value.connectionId, readinessTimeoutMs: Number(value.readinessTimeoutMs) } : null;
  }
  if (value.type === 'node-session-rejected' && exactNodeFields(value, ['type', 'version', 'code'])) {
    const code = NODE_SESSION_REJECTION_CODES.find((code) => code === value.code);
    return code ? { type: value.type, version: NODE_WIRE_VERSION, code } : null;
  }
  return null;
}

export function serializeNodeSessionFrame(frame: NodeSessionFrame): string {
  const text = JSON.stringify(frame);
  if (!parseNodeSessionFrameText(text)) throw new TypeError('Invalid node session frame');
  return text;
}

function connectionId(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0; }
