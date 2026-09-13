import { NODE_WIRE_VERSION } from '@garcon/server-agent-interface';
import { parseNodeSessionIdentity, type NodeSessionIdentity } from '../../../common/node-operation.js';
import { exactNodeFields, parsePrivateNodeJson } from './private-json.js';

export const MAX_NODE_BULK_SESSION_FRAME_BYTES = 4096;

export function nodeBulkAttemptOrdinal(value: unknown): number | null {
  return typeof value === 'string' && /^[1-9][0-9]{0,15}$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
}

export interface NodeBulkSessionFrame {
  readonly type: 'node-bulk-session-hello' | 'node-bulk-session-ready' | 'node-bulk-session-installed';
  readonly version: typeof NODE_WIRE_VERSION;
  readonly session: NodeSessionIdentity;
  readonly connectionId: number;
  readonly bulkAttemptId: string;
}

export function parseNodeBulkSessionFrameText(text: string): NodeBulkSessionFrame | null {
  const value = parsePrivateNodeJson(text, MAX_NODE_BULK_SESSION_FRAME_BYTES);
  if (!exactNodeFields(value, ['type', 'version', 'session', 'connectionId', 'bulkAttemptId'])
    || value.type !== 'node-bulk-session-hello' && value.type !== 'node-bulk-session-ready' && value.type !== 'node-bulk-session-installed'
    || value.version !== NODE_WIRE_VERSION || nodeBulkAttemptOrdinal(value.bulkAttemptId) === null
    || !Number.isSafeInteger(value.connectionId) || (value.connectionId as number) < 1) return null;
  const session = parseNodeSessionIdentity(value.session);
  return session ? { type: value.type, version: NODE_WIRE_VERSION, session,
    connectionId: value.connectionId as number, bulkAttemptId: value.bulkAttemptId as string } : null;
}

export function serializeNodeBulkSessionFrame(frame: NodeBulkSessionFrame): string {
  const text = JSON.stringify(frame);
  if (!parseNodeBulkSessionFrameText(text)) throw new TypeError('Invalid bulk session frame');
  return text;
}
