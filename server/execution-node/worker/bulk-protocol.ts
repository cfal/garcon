import { NODE_WIRE_VERSION } from '@garcon/server-agent-interface';
import { isExecutionIdentity } from '../../../common/execution-location.js';
import { parseNodeSessionIdentity, sameNodeSession, type NodeSessionIdentity } from '../../../common/node-operation.js';
import { parseNodeBulkFrameText } from '../../execution-nodes/transport/bulk-channel-wire.js';
import { MAX_NODE_BULK_FRAME_BYTES } from '../../execution-nodes/transport/bulk-wire.js';
import { exactNodeFields, parsePrivateNodeJson } from '../../execution-nodes/transport/private-json.js';
import { MAX_NODE_WORKER_LIFECYCLE_BYTES } from './protocol.js';

export interface NodeWorkerBulkFrame {
  readonly type: 'node-worker-bulk';
  readonly version: typeof NODE_WIRE_VERSION;
  readonly session: NodeSessionIdentity;
  readonly connectionId: number;
  readonly instanceId: string;
  readonly payload: string;
}

/** Carries pre-reserved execution bodies to their instance and captured physical connection. */
export function parseNodeWorkerBulkText(text: string): NodeWorkerBulkFrame | null {
  const value = parsePrivateNodeJson(text, MAX_NODE_WORKER_LIFECYCLE_BYTES);
  if (!exactNodeFields(value, ['type', 'version', 'session', 'connectionId', 'instanceId', 'payload'])
    || value.type !== 'node-worker-bulk' || value.version !== NODE_WIRE_VERSION
    || !Number.isSafeInteger(value.connectionId) || Number(value.connectionId) < 1
    || !isExecutionIdentity(value.instanceId) || typeof value.payload !== 'string'
    || Buffer.byteLength(value.payload) > MAX_NODE_BULK_FRAME_BYTES) return null;
  const session = parseNodeSessionIdentity(value.session);
  const payload = parseNodeBulkFrameText(value.payload);
  if (!session || !payload || !sameNodeSession(session, payload.type === 'node-bulk-result' ? payload.session : payload.transfer)) return null;
  return { type: value.type, version: NODE_WIRE_VERSION, session, connectionId: Number(value.connectionId),
    instanceId: value.instanceId, payload: value.payload };
}

export function serializeNodeWorkerBulk(frame: NodeWorkerBulkFrame): string {
  const text = JSON.stringify(frame);
  if (!parseNodeWorkerBulkText(text)) throw new TypeError('Invalid worker bulk frame');
  return text;
}
