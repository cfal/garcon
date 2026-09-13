import { NODE_WIRE_VERSION } from '@garcon/server-agent-interface';
import { isRecord } from '../../../common/json.js';
import { parseNodeSessionIdentity, type NodeSessionIdentity } from '../../../common/node-operation.js';
import { MAX_NODE_BULK_FRAME_BYTES, parseNodeBulkChunk, parseNodeBulkIdentity, type NodeBulkChunk, type NodeBulkIdentity } from './bulk-wire.js';

export type NodeBulkCommand = {
  readonly type: 'node-bulk-complete' | 'node-bulk-cancel';
  readonly version: typeof NODE_WIRE_VERSION;
  /** Increases within this command's ordered lane on one physical channel. */
  readonly requestId: number;
  readonly transfer: NodeBulkIdentity;
};

export type NodeBulkReply = {
  readonly type: 'node-bulk-result';
  readonly version: typeof NODE_WIRE_VERSION;
  readonly session: NodeSessionIdentity;
  readonly command: NodeBulkCommand['type'];
  readonly requestId: number;
  readonly result: 'completed' | 'cancelled' | 'NODE_BULK_INVALID' | 'NODE_BULK_UNAVAILABLE';
};

export interface NodeBulkFailure {
  readonly type: 'node-bulk-failed';
  readonly version: typeof NODE_WIRE_VERSION;
  readonly transfer: NodeBulkIdentity;
  readonly code: 'NODE_BULK_INVALID' | 'NODE_BULK_UNAVAILABLE';
}

export interface NodeBulkChunkAck {
  readonly type: 'node-bulk-chunk-ack';
  readonly version: typeof NODE_WIRE_VERSION;
  readonly transfer: NodeBulkIdentity;
  readonly nextOffset: number;
}

export type NodeBulkFrame = NodeBulkChunk | NodeBulkCommand | NodeBulkReply | NodeBulkFailure | NodeBulkChunkAck;

export function isNodeBulkReply(frame: NodeBulkFrame): frame is NodeBulkReply | NodeBulkFailure | NodeBulkChunkAck {
  return frame.type === 'node-bulk-result' || frame.type === 'node-bulk-failed' || frame.type === 'node-bulk-chunk-ack';
}

export function isNodeBulkData(frame: NodeBulkFrame): boolean {
  return frame.type === 'node-bulk-chunk' || frame.type === 'node-bulk-credit-chunk' || frame.type === 'node-bulk-complete';
}

export function parseNodeBulkFrameText(text: string): NodeBulkFrame | null {
  if (typeof text !== 'string' || text.length > MAX_NODE_BULK_FRAME_BYTES || Buffer.byteLength(text) > MAX_NODE_BULK_FRAME_BYTES) return null;
  let value: unknown;
  try { value = JSON.parse(text); } catch { return null; }
  if (!isRecord(value) || value.version !== NODE_WIRE_VERSION) return null;
  if (value.type === 'node-bulk-chunk' || value.type === 'node-bulk-credit-chunk') return parseNodeBulkChunk(value);
  if (value.type === 'node-bulk-chunk-ack') {
    const transfer = parseNodeBulkIdentity(value.transfer);
    return Object.keys(value).length === 4 && transfer && Number.isSafeInteger(value.nextOffset) && Number(value.nextOffset) > 0
      ? { type: value.type, version: NODE_WIRE_VERSION, transfer, nextOffset: Number(value.nextOffset) } : null;
  }
  if (value.type === 'node-bulk-failed') {
    const transfer = parseNodeBulkIdentity(value.transfer);
    return Object.keys(value).length === 4 && transfer && (value.code === 'NODE_BULK_INVALID' || value.code === 'NODE_BULK_UNAVAILABLE')
      ? { type: 'node-bulk-failed', version: NODE_WIRE_VERSION, transfer, code: value.code } : null;
  }
  if (!Number.isSafeInteger(value.requestId) || (value.requestId as number) < 1) return null;
  if ((value.type === 'node-bulk-complete' || value.type === 'node-bulk-cancel') && Object.keys(value).length === 4) {
    const transfer = parseNodeBulkIdentity(value.transfer);
    return transfer ? { type: value.type, version: NODE_WIRE_VERSION, requestId: value.requestId as number, transfer } : null;
  }
  if (value.type !== 'node-bulk-result' || Object.keys(value).length !== 6
    || value.command !== 'node-bulk-complete' && value.command !== 'node-bulk-cancel'
    || !['completed', 'cancelled', 'NODE_BULK_INVALID', 'NODE_BULK_UNAVAILABLE'].includes(value.result as string)) return null;
  const session = parseNodeSessionIdentity(value.session);
  return session ? { type: 'node-bulk-result', version: NODE_WIRE_VERSION, session, command: value.command,
    requestId: value.requestId as number, result: value.result as NodeBulkReply['result'] } : null;
}

export function serializeNodeBulkFrame(frame: NodeBulkFrame): string {
  const text = JSON.stringify(frame);
  if (!parseNodeBulkFrameText(text)) throw new TypeError('Invalid node bulk frame');
  return text;
}
