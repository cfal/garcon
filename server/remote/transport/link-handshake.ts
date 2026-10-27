import { isSessionId, type RpcLane } from './rpc-lane.js';
import { isRecord } from '../../../common/json.js';
import { canonicalProfile, isProtocolDecision, isProtocolOffer, type ProtocolDecision, type ProtocolOffer } from './protocol-compatibility.js';

export type LinkRole = 'controller' | 'worker';

export interface LinkHello {
  readonly type: 'hello';
  readonly build: string;
  readonly protocol: ProtocolOffer | null;
  readonly role: LinkRole;
  readonly executorId: string | null;
  readonly runtimeId: string;
  readonly nonce: string;
  readonly lane: RpcLane;
  readonly sessionId: string | null;
  readonly primarySessionId: string | null;
  readonly primaryProfileId: string | null;
}

export interface LinkProof {
  readonly type: 'proof';
  readonly decision: ProtocolDecision;
  readonly signature: string;
}

export interface LinkDialTarget {
  readonly lane: RpcLane;
  readonly sessionId: string | null;
  readonly primarySessionId: string | null;
}

export function isLinkHello(frame: unknown): frame is LinkHello {
  if (!isRecord(frame)) return false;
  return Object.keys(frame).length === 11 && frame.type === 'hello'
    && (frame.role === 'controller' || frame.role === 'worker')
    && (frame.lane === 'primary' || frame.lane === 'bulk')
    && typeof frame.build === 'string' && /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/.test(frame.build)
    && typeof frame.runtimeId === 'string' && frame.runtimeId.length > 0 && frame.runtimeId.length <= 128
    && isLowerHex64(frame.nonce)
    && (typeof frame.executorId === 'string' && frame.executorId.length > 0 && frame.executorId.length <= 128
      || frame.role === 'worker' && frame.lane === 'primary' && frame.executorId === null)
    && (isSessionId(frame.sessionId) || frame.role === 'worker' && frame.lane === 'primary' && frame.sessionId === null)
    && (frame.lane === 'primary'
      ? frame.primarySessionId === null && frame.primaryProfileId === null && isProtocolOffer(frame.protocol)
      : isSessionId(frame.primarySessionId) && isLowerHex64(frame.primaryProfileId) && frame.protocol === null);
}

export function isLinkProof(value: unknown): value is LinkProof {
  return isRecord(value) && Object.keys(value).length === 3 && value.type === 'proof'
    && isProtocolDecision(value.decision) && isLowerHex64(value.signature);
}

function isLowerHex64(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

export function proofPayload(purpose: LinkRole, controllerHelloFrame: string, workerHelloFrame: string, decision: ProtocolDecision): string {
  return JSON.stringify([
    'garcon-executor-handshake-v1', purpose, controllerHelloFrame, workerHelloFrame,
    decision.ok ? ['accepted', canonicalProfile(decision.profile)] : ['rejected', decision.code],
  ]);
}
