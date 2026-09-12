import { NODE_WIRE_VERSION } from '@garcon/server-agent-interface';
import { isExecutionIdentity } from '../../../common/execution-location.js';
import { parseNodeSessionIdentity, type NodeSessionIdentity } from '../../../common/node-operation.js';
import { exactNodeFields, parsePrivateNodeJson } from './private-json.js';

export const MAX_NODE_LEASE_FRAME_BYTES = 4096;

export interface NodeLeaseFrame {
  readonly type: 'node-lease-challenge' | 'node-lease-renewal';
  readonly version: typeof NODE_WIRE_VERSION;
  readonly session: NodeSessionIdentity;
  readonly challengeId: string;
}

export function parseNodeLeaseFrameText(text: string): NodeLeaseFrame | null {
  const value = parsePrivateNodeJson(text, MAX_NODE_LEASE_FRAME_BYTES);
  if (!exactNodeFields(value, ['type', 'version', 'session', 'challengeId'])
    || value.type !== 'node-lease-challenge' && value.type !== 'node-lease-renewal'
    || value.version !== NODE_WIRE_VERSION || !isExecutionIdentity(value.challengeId)) return null;
  const session = parseNodeSessionIdentity(value.session);
  return session ? { type: value.type, version: NODE_WIRE_VERSION, session, challengeId: value.challengeId } : null;
}

export function serializeNodeLeaseFrame(frame: NodeLeaseFrame): string {
  const text = JSON.stringify(frame);
  if (!parseNodeLeaseFrameText(text)) throw new TypeError('Invalid node lease frame');
  return text;
}
