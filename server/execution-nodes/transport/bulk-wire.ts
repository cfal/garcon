import { isRecord } from '../../../common/json.js';
import { isExecutionIdentity } from '../../../common/execution-location.js';
import { parseNodeSessionIdentity, type NodeSessionIdentity } from '../../../common/node-operation.js';
import { NODE_WIRE_VERSION } from '@garcon/server-agent-interface';

export const MAX_NODE_BULK_CHUNK_BYTES = 64 * 1024;
export const MAX_NODE_BULK_FRAME_BYTES = 96 * 1024;

export interface NodeBulkIdentity extends NodeSessionIdentity {
  readonly transferId: string;
}

export interface NodeBulkDescriptor {
  readonly byteLength: number;
  readonly sha256: string;
}

export interface NodeBulkChunk {
  readonly type: 'node-bulk-chunk';
  readonly version: typeof NODE_WIRE_VERSION;
  readonly transfer: NodeBulkIdentity;
  readonly offset: number;
  readonly data: string;
}

export function parseNodeBulkIdentity(value: unknown): NodeBulkIdentity | null {
  if (!isRecord(value) || Object.keys(value).length !== 4
    || !['controllerBootId', 'nodeBootId', 'logicalSessionId', 'transferId'].every((key) => Object.hasOwn(value, key))
    || !isExecutionIdentity(value.transferId)) return null;
  const session = parseNodeSessionIdentity({
    controllerBootId: value.controllerBootId, nodeBootId: value.nodeBootId, logicalSessionId: value.logicalSessionId,
  });
  return session ? { ...session, transferId: value.transferId } : null;
}

export function parseNodeBulkDescriptor(value: unknown): NodeBulkDescriptor | null {
  if (!isRecord(value) || Object.keys(value).length !== 2 || !Object.hasOwn(value, 'byteLength') || !Object.hasOwn(value, 'sha256')
    || !Number.isSafeInteger(value.byteLength)
    || (value.byteLength as number) < 0 || typeof value.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(value.sha256)) return null;
  return { byteLength: value.byteLength as number, sha256: value.sha256 };
}

export function parseNodeBulkChunkText(text: string): NodeBulkChunk | null {
  if (typeof text !== 'string' || text.length > MAX_NODE_BULK_FRAME_BYTES || Buffer.byteLength(text) > MAX_NODE_BULK_FRAME_BYTES) return null;
  let value: unknown;
  try { value = JSON.parse(text); } catch { return null; }
  return parseNodeBulkChunk(value);
}

export function parseNodeBulkChunk(value: unknown): NodeBulkChunk | null {
  if (!isRecord(value) || Object.keys(value).length !== 5 || value.type !== 'node-bulk-chunk' || value.version !== NODE_WIRE_VERSION
    || !Number.isSafeInteger(value.offset) || (value.offset as number) < 0 || !validChunkData(value.data)) return null;
  const transfer = parseNodeBulkIdentity(value.transfer);
  return transfer ? { type: 'node-bulk-chunk', version: NODE_WIRE_VERSION, transfer, offset: value.offset as number, data: value.data } : null;
}

export function serializeNodeBulkChunk(transfer: NodeBulkIdentity, offset: number, chunk: Uint8Array): string {
  const identity = parseNodeBulkIdentity(transfer);
  if (!identity || !Number.isSafeInteger(offset) || offset < 0 || !chunk.byteLength || chunk.byteLength > MAX_NODE_BULK_CHUNK_BYTES) {
    throw new TypeError('Invalid node bulk chunk');
  }
  const serialized = JSON.stringify({ type: 'node-bulk-chunk', version: NODE_WIRE_VERSION, transfer: identity, offset, data: Buffer.from(chunk).toString('base64') });
  if (Buffer.byteLength(serialized) > MAX_NODE_BULK_FRAME_BYTES) throw new TypeError('Node bulk frame exceeds its limit');
  return serialized;
}

function validChunkData(value: unknown): value is string {
  if (typeof value !== 'string' || !value.length || value.length > Math.ceil(MAX_NODE_BULK_CHUNK_BYTES / 3) * 4 || value.length % 4) return false;
  // Restricts padding bits to their canonical zero values without decoding the body twice.
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/][AQgw]==|[A-Za-z0-9+/]{2}[AEIMQUYcgkosw048]=)?$/.test(value)) return false;
  return value.length / 4 * 3 - (value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0) <= MAX_NODE_BULK_CHUNK_BYTES;
}
