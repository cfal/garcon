import { NODE_WIRE_VERSION } from '@garcon/server-agent-interface';
import { parseNodeSessionIdentity, sameNodeSession, type NodeSessionIdentity } from '../../../common/node-operation.js';
import { exactNodeFields, parsePrivateNodeJson } from '../../execution-nodes/transport/private-json.js';
import { MAX_NODE_WORKER_OUTPUT_CHUNK_BYTES, parseNodeWorkerOutputText } from './output-protocol.js';

export const MAX_NODE_WORKER_DELIVERY_CHUNK_BYTES = MAX_NODE_WORKER_OUTPUT_CHUNK_BYTES + 8192;

/** Fences session-to-coordinator staging independently of the logical producer stream. */
export interface NodeWorkerOutputDeliveryChunk {
  readonly type: 'node-worker-output-delivery';
  readonly version: typeof NODE_WIRE_VERSION;
  readonly session: NodeSessionIdentity;
  readonly connectionId: number;
  readonly generation: number;
  readonly payload: string;
}

export function parseNodeWorkerOutputDeliveryText(text: string): NodeWorkerOutputDeliveryChunk | null {
  const value = parsePrivateNodeJson(text, MAX_NODE_WORKER_DELIVERY_CHUNK_BYTES);
  if (!exactNodeFields(value, ['type', 'version', 'session', 'connectionId', 'generation', 'payload'])
    || value.type !== 'node-worker-output-delivery' || value.version !== NODE_WIRE_VERSION
    || !Number.isSafeInteger(value.connectionId) || Number(value.connectionId) < 1
    || !Number.isSafeInteger(value.generation) || Number(value.generation) < 1 || typeof value.payload !== 'string') return null;
  const session = parseNodeSessionIdentity(value.session);
  const frame = parseNodeWorkerOutputText(value.payload);
  if (!session || !frame || !sameNodeSession(session, frame.stream)) return null;
  return { type: value.type, version: NODE_WIRE_VERSION, session, connectionId: Number(value.connectionId),
    generation: Number(value.generation), payload: value.payload };
}

export function serializeNodeWorkerOutputDelivery(frame: NodeWorkerOutputDeliveryChunk): string {
  const text = JSON.stringify(frame);
  if (!parseNodeWorkerOutputDeliveryText(text)) throw new TypeError('Invalid worker output delivery');
  return text;
}
