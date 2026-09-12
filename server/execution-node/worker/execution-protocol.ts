import { NODE_WIRE_VERSION } from '@garcon/server-agent-interface';
import { isExecutionIdentity } from '../../../common/execution-location.js';
import { parseNodeSessionIdentity, type NodeSessionIdentity } from '../../../common/node-operation.js';
import { MAX_NODE_EXECUTION_FRAME_BYTES } from '../../execution-nodes/transport/execution-wire.js';
import { exactNodeFields, parsePrivateNodeJson } from '../../execution-nodes/transport/private-json.js';
import { MAX_NODE_WORKER_LIFECYCLE_BYTES } from './protocol.js';

export interface NodeWorkerExecutionFrame {
  readonly type: 'node-worker-execution';
  readonly version: typeof NODE_WIRE_VERSION;
  readonly session: NodeSessionIdentity;
  readonly connectionId: number;
  readonly instanceId: string;
  readonly payload: string;
}

/** Carries the execution codec to one configured instance on a captured physical connection. */
export function parseNodeWorkerExecutionText(text: string): NodeWorkerExecutionFrame | null {
  const value = parsePrivateNodeJson(text, MAX_NODE_WORKER_LIFECYCLE_BYTES);
  if (!exactNodeFields(value, ['type', 'version', 'session', 'connectionId', 'instanceId', 'payload'])
    || value.type !== 'node-worker-execution' || value.version !== NODE_WIRE_VERSION
    || !Number.isSafeInteger(value.connectionId) || Number(value.connectionId) < 1
    || !isExecutionIdentity(value.instanceId)
    || typeof value.payload !== 'string' || !value.payload.length || Buffer.byteLength(value.payload) > MAX_NODE_EXECUTION_FRAME_BYTES) return null;
  const session = parseNodeSessionIdentity(value.session);
  return session ? { type: value.type, version: NODE_WIRE_VERSION, session, connectionId: Number(value.connectionId),
    instanceId: value.instanceId, payload: value.payload } : null;
}

export function serializeNodeWorkerExecution(frame: NodeWorkerExecutionFrame): string {
  const text = JSON.stringify(frame);
  if (!parseNodeWorkerExecutionText(text)) throw new TypeError('Invalid worker execution frame');
  return text;
}
