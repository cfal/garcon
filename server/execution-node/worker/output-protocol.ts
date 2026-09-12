import { createHash, randomUUID } from 'node:crypto';
import {
  MAX_NODE_OUTPUT_BYTES, MAX_NODE_OUTPUT_SEQUENCE, NODE_WIRE_VERSION,
  parseNodeOutputText, parseProducerStreamIdentity, type ProducerStreamIdentity,
} from '@garcon/server-agent-interface';
import { isExecutionIdentity } from '../../../common/execution-location.js';
import { sameNodeSession } from '../../../common/node-operation.js';
import {
  MAX_NODE_BULK_CHUNK_BYTES, MAX_NODE_BULK_FRAME_BYTES, parseNodeBulkChunk, parseNodeBulkDescriptor,
  type NodeBulkChunk, type NodeBulkDescriptor,
} from '../../execution-nodes/transport/bulk-wire.js';
import { exactNodeFields, parsePrivateNodeJson } from '../../execution-nodes/transport/private-json.js';

export const MAX_NODE_WORKER_OUTPUT_CHUNK_BYTES = MAX_NODE_BULK_FRAME_BYTES + 4096;

/** Output belongs to the logical session and continues across physical controller reconnection. */
export interface NodeWorkerOutputChunk {
  readonly type: 'node-worker-output';
  readonly version: typeof NODE_WIRE_VERSION;
  readonly instanceId: string;
  readonly stream: ProducerStreamIdentity;
  readonly sequence: number;
  readonly descriptor: NodeBulkDescriptor;
  readonly chunk: NodeBulkChunk;
}

export function parseNodeWorkerOutputText(text: string): NodeWorkerOutputChunk | null {
  const value = parsePrivateNodeJson(text, MAX_NODE_WORKER_OUTPUT_CHUNK_BYTES);
  if (!exactNodeFields(value, ['type', 'version', 'instanceId', 'stream', 'sequence', 'descriptor', 'chunk'])
    || value.type !== 'node-worker-output' || value.version !== NODE_WIRE_VERSION || !isExecutionIdentity(value.instanceId)
    || !Number.isSafeInteger(value.sequence) || Number(value.sequence) < 1 || Number(value.sequence) > MAX_NODE_OUTPUT_SEQUENCE) return null;
  const stream = parseProducerStreamIdentity(value.stream);
  const descriptor = parseNodeBulkDescriptor(value.descriptor);
  const chunk = parseNodeBulkChunk(value.chunk);
  if (!stream || !descriptor || descriptor.byteLength < 1 || descriptor.byteLength > MAX_NODE_OUTPUT_BYTES || !chunk
    || !sameNodeSession(stream, chunk.transfer) || chunk.offset >= descriptor.byteLength
    || Buffer.from(chunk.data, 'base64').byteLength > descriptor.byteLength - chunk.offset) return null;
  return { type: value.type, version: NODE_WIRE_VERSION, instanceId: value.instanceId, stream,
    sequence: Number(value.sequence), descriptor, chunk };
}

export function serializeNodeWorkerOutput(chunk: NodeWorkerOutputChunk): string {
  const text = JSON.stringify(chunk);
  if (!parseNodeWorkerOutputText(text)) throw new TypeError('Invalid worker output chunk');
  return text;
}

/** Splits one immutable serialized output record without changing its bytes or transport sequence. */
export function chunkNodeWorkerOutput(instanceId: string, serialized: string): readonly string[] {
  if (!isExecutionIdentity(instanceId)) throw new TypeError('Invalid output instance');
  const frame = parseNodeOutputText(serialized);
  if (!frame) throw new TypeError('Invalid serialized node output');
  return Object.freeze([...iterateNodeWorkerOutput(instanceId, frame.stream, frame.sequence, Buffer.from(serialized))]);
}

/** Borrows one privately owned record; only the current chunk is encoded before native drain. */
export function* iterateNodeWorkerOutput(instanceId: string, stream: ProducerStreamIdentity, sequence: number, bytes: Buffer): Generator<string> {
  if (!isExecutionIdentity(instanceId) || !parseProducerStreamIdentity(stream) || !Number.isSafeInteger(sequence)
    || sequence < 1 || sequence > MAX_NODE_OUTPUT_SEQUENCE || !bytes.byteLength || bytes.byteLength > MAX_NODE_OUTPUT_BYTES) {
    throw new TypeError('Invalid worker output record');
  }
  const descriptor = { byteLength: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') };
  const transfer = { controllerBootId: stream.controllerBootId, nodeBootId: stream.nodeBootId,
    logicalSessionId: stream.logicalSessionId, transferId: randomUUID() };
  for (let offset = 0; offset < bytes.byteLength; offset += MAX_NODE_BULK_CHUNK_BYTES) yield serializeNodeWorkerOutput({
    type: 'node-worker-output', version: NODE_WIRE_VERSION, instanceId, stream, sequence, descriptor,
    chunk: { type: 'node-bulk-chunk', version: NODE_WIRE_VERSION, transfer, offset,
      data: bytes.subarray(offset, offset + MAX_NODE_BULK_CHUNK_BYTES).toString('base64') },
  });
}
