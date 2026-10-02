import { isSessionId, type RpcLane } from './rpc-lane.js';

export type LinkRole = 'controller' | 'worker';

export interface LinkHello {
  readonly type: 'hello';
  readonly version: string;
  readonly role: LinkRole;
  readonly executorId: string | null;
  readonly runtimeId: string;
  readonly nonce: string;
  readonly lane: RpcLane;
  readonly sessionId: string | null;
  readonly primarySessionId: string | null;
}

export interface LinkDialTarget {
  readonly lane: RpcLane;
  readonly sessionId: string | null;
  readonly primarySessionId: string | null;
}

export function isLinkHello(value: unknown): value is LinkHello {
  if (!value || typeof value !== 'object') return false;
  const frame = value as Record<string, unknown>;
  return Object.keys(frame).length === 9 && frame.type === 'hello'
    && (frame.role === 'controller' || frame.role === 'worker')
    && (frame.lane === 'primary' || frame.lane === 'bulk')
    && ['version', 'runtimeId'].every(key => typeof frame[key] === 'string' && frame[key].length > 0 && frame[key].length <= 128)
    && typeof frame.nonce === 'string' && /^[a-f0-9]{64}$/.test(frame.nonce)
    && (typeof frame.executorId === 'string' && frame.executorId.length > 0 && frame.executorId.length <= 128
      || frame.role === 'worker' && frame.lane === 'primary' && frame.executorId === null)
    && (isSessionId(frame.sessionId) || frame.role === 'worker' && frame.lane === 'primary' && frame.sessionId === null)
    && (frame.lane === 'primary' ? frame.primarySessionId === null : isSessionId(frame.primarySessionId));
}
