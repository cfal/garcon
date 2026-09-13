import { NODE_WIRE_VERSION } from '@garcon/server-agent-interface';
import { sameNodeSession } from '../../../common/node-operation.js';
import { parseNodeBulkFrameText } from './bulk-channel-wire.js';
import { MAX_NODE_BULK_FRAME_BYTES, parseNodeBulkIdentity, type NodeBulkIdentity } from './bulk-wire.js';
import { exactNodeFields, parsePrivateNodeJson } from './private-json.js';
import { parseNodeHistoryImportTarget, sameNodeHistoryImport, type NodeHistoryImportTarget } from './provider-history-wire.js';

export const MAX_NODE_HISTORY_BULK_FRAME_BYTES = MAX_NODE_BULK_FRAME_BYTES + 4096;

export interface NodeHistoryBulkTarget extends NodeHistoryImportTarget {
  readonly sequence: number;
  readonly grant: NodeBulkIdentity;
}

export interface NodeHistoryBulkFrame extends NodeHistoryBulkTarget {
  readonly type: 'node-history-bulk';
  readonly version: typeof NODE_WIRE_VERSION;
  readonly payload: string;
}

/** Binds every chunk and reply to one import row, receiving grant, and physical bulk attempt. */
export function parseNodeHistoryBulkText(text: string): NodeHistoryBulkFrame | null {
  const value = parsePrivateNodeJson(text, MAX_NODE_HISTORY_BULK_FRAME_BYTES);
  if (!exactNodeFields(value, ['type', 'version', 'identity', 'instanceId', 'connectionId', 'bulkAttemptId', 'sequence', 'grant', 'payload'])
    || value.type !== 'node-history-bulk' || value.version !== NODE_WIRE_VERSION
    || !Number.isSafeInteger(value.sequence) || Number(value.sequence) < 1
    || typeof value.payload !== 'string' || Buffer.byteLength(value.payload) > MAX_NODE_BULK_FRAME_BYTES) return null;
  const target = parseNodeHistoryImportTarget(value);
  const grant = parseNodeBulkIdentity(value.grant);
  const payload = parseNodeBulkFrameText(value.payload);
  if (!target || !grant || !payload || !sameNodeSession(target.identity, grant)) return null;
  if (payload.type === 'node-bulk-result') {
    if (!sameNodeSession(payload.session, grant)) return null;
  } else if (!sameNodeSession(payload.transfer, grant) || payload.transfer.transferId !== grant.transferId) return null;
  return { ...target, type: 'node-history-bulk', version: NODE_WIRE_VERSION, sequence: Number(value.sequence), grant, payload: value.payload };
}

export function sameNodeHistoryBulkTarget(a: NodeHistoryBulkTarget, b: NodeHistoryBulkTarget): boolean {
  return sameNodeHistoryImport(a, b) && a.sequence === b.sequence && sameNodeSession(a.grant, b.grant) && a.grant.transferId === b.grant.transferId;
}

export function serializeNodeHistoryBulk(frame: NodeHistoryBulkFrame): string {
  const text = JSON.stringify(frame);
  if (!parseNodeHistoryBulkText(text)) throw new TypeError('Invalid history bulk frame');
  return text;
}
