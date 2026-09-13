import { NODE_WIRE_VERSION, isNormalizedJsonObject } from '@garcon/server-agent-interface';
import { isExecutionIdentity } from '../../../common/execution-location.js';
import { parseNodeSessionIdentity, type NodeSessionIdentity } from '../../../common/node-operation.js';
import { parseNodeProviderManifest, type NodeProviderManifest } from '../../execution-nodes/provider-manifest.js';
import { exactNodeFields, parsePrivateNodeJson } from '../../execution-nodes/transport/private-json.js';
import { parseNodeWorkerConfiguration, MAX_NODE_WORKER_INSTANCES, type NodeWorkerConfiguration } from './configuration.js';
import type { NodeWorkerRole } from './roles.js';
import { MAX_NODE_READINESS_TIMEOUT_MS } from '../../execution-nodes/transport/session-wire.js';

export const MAX_NODE_WORKER_LIFECYCLE_BYTES = 2 * 1024 * 1024;

export interface NodeWorkerConfigurationMessage {
  readonly type: 'node-worker-configure';
  readonly version: typeof NODE_WIRE_VERSION;
  readonly session: NodeSessionIdentity;
  readonly connectionId: number;
  readonly startupTimeoutMs: number;
  readonly configuration: NodeWorkerConfiguration;
}

export interface NodeWorkerGateMessage {
  readonly type: 'node-worker-attach' | 'node-worker-admit' | 'node-worker-disconnect';
  readonly version: typeof NODE_WIRE_VERSION;
  readonly session: NodeSessionIdentity;
  readonly connectionId: number;
}

export type NodeWorkerParentMessage = NodeWorkerConfigurationMessage | NodeWorkerGateMessage | {
  readonly type: 'node-worker-pulse';
  readonly version: typeof NODE_WIRE_VERSION;
  readonly session: NodeSessionIdentity;
  readonly connectionId: number;
};

export interface NodeWorkerContainmentRequest {
  readonly type: 'node-worker-containment-request';
  readonly version: typeof NODE_WIRE_VERSION;
  readonly session: NodeSessionIdentity;
  readonly instanceId: string;
  readonly operationId: string;
  readonly reason: 'native-settlement-unconfirmed';
}

export type NodeWorkerChildMessage = NodeWorkerContainmentRequest | {
  readonly type: 'node-worker-hello';
  readonly version: typeof NODE_WIRE_VERSION;
  readonly role: NodeWorkerRole;
  readonly pid: number;
} | {
  readonly type: 'node-worker-ready';
  readonly version: typeof NODE_WIRE_VERSION;
  readonly session: NodeSessionIdentity;
  readonly manifests: readonly NodeProviderManifest[];
};

export function parseNodeWorkerParentText(text: string): NodeWorkerParentMessage | null {
  const value = parsePrivateNodeJson(text, MAX_NODE_WORKER_LIFECYCLE_BYTES);
  if (!exactNodeFields(value, ['type', 'version', 'session', 'connectionId'], ['configuration', 'startupTimeoutMs'])
    || value.version !== NODE_WIRE_VERSION || !connectionId(value.connectionId)) return null;
  const session = parseNodeSessionIdentity(value.session);
  if (!session) return null;
  const base = { version: NODE_WIRE_VERSION, session, connectionId: value.connectionId } as const;
  if (value.type === 'node-worker-configure') {
    if (!exactNodeFields(value, ['type', 'version', 'session', 'connectionId', 'configuration', 'startupTimeoutMs'])
      || !Number.isSafeInteger(value.startupTimeoutMs) || Number(value.startupTimeoutMs) < 1
      || Number(value.startupTimeoutMs) > MAX_NODE_READINESS_TIMEOUT_MS) return null;
    const configuration = parseNodeWorkerConfiguration(value.configuration);
    return configuration ? { type: value.type, ...base, startupTimeoutMs: Number(value.startupTimeoutMs), configuration } : null;
  }
  if (!exactNodeFields(value, ['type', 'version', 'session', 'connectionId'])) return null;
  return value.type === 'node-worker-pulse' || value.type === 'node-worker-attach'
    || value.type === 'node-worker-admit' || value.type === 'node-worker-disconnect'
    ? { type: value.type, ...base } : null;
}

export function parseNodeWorkerChildText(text: string): NodeWorkerChildMessage | null {
  const value = parsePrivateNodeJson(text, MAX_NODE_WORKER_LIFECYCLE_BYTES);
  if (!value || value.version !== NODE_WIRE_VERSION) return null;
  if (value.type === 'node-worker-hello') {
    return exactNodeFields(value, ['type', 'version', 'role', 'pid']) && (value.role === 'session' || value.role === 'instance')
      && Number.isSafeInteger(value.pid) && Number(value.pid) > 0
      ? { type: value.type, version: NODE_WIRE_VERSION, role: value.role, pid: Number(value.pid) } : null;
  }
  if (value.type === 'node-worker-containment-request') {
    const session = parseNodeSessionIdentity(value.session);
    if (!exactNodeFields(value, ['type', 'version', 'session', 'instanceId', 'operationId', 'reason'])
      || !session || !isExecutionIdentity(value.instanceId) || !isExecutionIdentity(value.operationId)
      || value.reason !== 'native-settlement-unconfirmed') return null;
    return { type: value.type, version: NODE_WIRE_VERSION, session, instanceId: value.instanceId, operationId: value.operationId, reason: value.reason };
  }
  if (value.type !== 'node-worker-ready' || !exactNodeFields(value, ['type', 'version', 'session', 'manifests'])
    || !Array.isArray(value.manifests) || value.manifests.length > MAX_NODE_WORKER_INSTANCES) return null;
  const session = parseNodeSessionIdentity(value.session);
  if (!session) return null;
  const manifests: NodeProviderManifest[] = [];
  for (const entry of value.manifests) {
    const manifest = parseNodeProviderManifest(entry);
    if (!manifest || manifests.some((prior) => prior.instanceId === manifest.instanceId || prior.nodeId !== manifest.nodeId)) return null;
    manifests.push(manifest);
  }
  return { type: value.type, version: NODE_WIRE_VERSION, session, manifests: Object.freeze(manifests) };
}

export function serializeNodeWorkerParent(message: NodeWorkerParentMessage): string {
  if (!isNormalizedJsonObject(message)) throw new TypeError('Invalid worker control');
  const text = JSON.stringify(message);
  if (!parseNodeWorkerParentText(text)) throw new TypeError('Invalid worker control');
  return text;
}

export function serializeNodeWorkerChild(message: NodeWorkerChildMessage): string {
  if (!isNormalizedJsonObject(message)) throw new TypeError('Invalid worker reply');
  const text = JSON.stringify(message);
  if (!parseNodeWorkerChildText(text)) throw new TypeError('Invalid worker reply');
  return text;
}

function connectionId(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0; }
