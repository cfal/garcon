import { NODE_WIRE_VERSION } from '@garcon/server-agent-interface';
import { parseNodeSessionIdentity, type NodeSessionIdentity } from '../../../common/node-operation.js';
import { exactNodeFields, parsePrivateNodeJson } from './private-json.js';

export const MAX_NODE_BULK_SESSION_FRAME_BYTES = 4096;

export interface NodeBulkSessionFrame {
  readonly type: 'node-bulk-session-hello' | 'node-bulk-session-ready';
  readonly version: typeof NODE_WIRE_VERSION;
  readonly session: NodeSessionIdentity;
  readonly connectionId: number;
}

export function parseNodeBulkSessionFrameText(text: string): NodeBulkSessionFrame | null {
  const value = parsePrivateNodeJson(text, MAX_NODE_BULK_SESSION_FRAME_BYTES);
  if (!exactNodeFields(value, ['type', 'version', 'session', 'connectionId'])
    || value.type !== 'node-bulk-session-hello' && value.type !== 'node-bulk-session-ready'
    || value.version !== NODE_WIRE_VERSION || !Number.isSafeInteger(value.connectionId) || (value.connectionId as number) < 1) return null;
  const session = parseNodeSessionIdentity(value.session);
  return session ? { type: value.type, version: NODE_WIRE_VERSION, session, connectionId: value.connectionId as number } : null;
}

export function serializeNodeBulkSessionFrame(frame: NodeBulkSessionFrame): string {
  const text = JSON.stringify(frame);
  if (!parseNodeBulkSessionFrameText(text)) throw new TypeError('Invalid bulk session frame');
  return text;
}
