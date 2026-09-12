import { NODE_WIRE_VERSION, isNormalizedJsonObject } from '@garcon/server-agent-interface';
import { isExecutionIdentity, parseExecutionLocation } from '../../../common/execution-location.js';
import { NODE_ERROR_CODES, parseNodeOperationIdentity, parseNodeSessionIdentity, sameNodeSession, type NodeSessionIdentity } from '../../../common/node-operation.js';
import type {
  NodeControlOutcome, NodeControlPreparation, NodeControlReceipt, NodeControlTicket, NodeExecutionReceipt, NodeExecutionTicket,
} from '../../execution-node/operation-table.js';
import { exactNodeFields, nodeString, parsePrivateNodeJson } from './private-json.js';
import { MAX_NODE_EXECUTION_FRAME_BYTES } from './execution-wire.js';

export const NODE_EXECUTION_ERROR_CODES = [...NODE_ERROR_CODES, 'VALIDATION_FAILED', 'NODE_EXECUTION_FAILED'] as const;
export type NodeExecutionErrorCode = typeof NODE_EXECUTION_ERROR_CODES[number];

export type NodeExecutionResult =
  | { readonly kind: 'prepared'; readonly ticket: NodeExecutionTicket }
  | { readonly kind: 'dispatched' | 'released' | 'unknown' }
  | { readonly kind: 'abort-result'; readonly requested: boolean }
  | { readonly kind: 'status'; readonly receipt: NodeExecutionReceipt | null }
  | { readonly kind: 'control-prepared'; readonly preparation: NodeControlPreparation }
  | { readonly kind: 'steer-result'; readonly outcome: NodeControlOutcome; readonly deliveryPrepared: boolean }
  | { readonly kind: 'goal-result'; readonly outcome: NodeControlOutcome }
  | { readonly kind: 'control-cancelled'; readonly cancelled: boolean }
  | { readonly kind: 'rejected'; readonly code: NodeExecutionErrorCode };

export interface NodeExecutionReply {
  readonly type: 'node-execution-result';
  readonly version: typeof NODE_WIRE_VERSION;
  readonly session: NodeSessionIdentity;
  readonly requestId: number;
  readonly result: NodeExecutionResult;
}

export function parseNodeExecutionReplyText(text: string): NodeExecutionReply | null {
  const value = parsePrivateNodeJson(text, MAX_NODE_EXECUTION_FRAME_BYTES);
  if (!exactNodeFields(value, ['type', 'version', 'session', 'requestId', 'result']) || value.type !== 'node-execution-result'
    || value.version !== NODE_WIRE_VERSION || !Number.isSafeInteger(value.requestId) || (value.requestId as number) < 1) return null;
  const session = parseNodeSessionIdentity(value.session);
  const result = parseResult(value.result);
  if (!session || !result) return null;
  const identity = result.kind === 'prepared' ? result.ticket.identity
    : result.kind === 'status' ? result.receipt?.identity
      : result.kind === 'control-prepared' && result.preparation.kind === 'ready' ? result.preparation.ticket.identity : null;
  if (identity && !sameNodeSession(identity, session)) return null;
  return { type: 'node-execution-result', version: NODE_WIRE_VERSION, session, requestId: value.requestId as number, result };
}

export function serializeNodeExecutionReply(reply: NodeExecutionReply): string {
  if (!isNormalizedJsonObject(reply)) throw new TypeError('Invalid node execution reply');
  const text = JSON.stringify(reply);
  if (!parseNodeExecutionReplyText(text)) throw new TypeError('Invalid node execution reply');
  return text;
}

function parseResult(value: unknown): NodeExecutionResult | null {
  if (!exactNodeFields(value, ['kind'], ['ticket', 'requested', 'receipt', 'preparation', 'outcome', 'deliveryPrepared', 'cancelled', 'code'])) return null;
  if (value.kind === 'dispatched' || value.kind === 'released' || value.kind === 'unknown') {
    return exactNodeFields(value, ['kind']) ? { kind: value.kind } : null;
  }
  if (value.kind === 'prepared') {
    const ticket = parseExecutionTicket(value.ticket);
    return exactNodeFields(value, ['kind', 'ticket']) && ticket ? { kind: 'prepared', ticket } : null;
  }
  if (value.kind === 'abort-result') return exactNodeFields(value, ['kind', 'requested']) && typeof value.requested === 'boolean'
    ? { kind: 'abort-result', requested: value.requested } : null;
  if (value.kind === 'control-cancelled') return exactNodeFields(value, ['kind', 'cancelled']) && typeof value.cancelled === 'boolean'
    ? { kind: 'control-cancelled', cancelled: value.cancelled } : null;
  if (value.kind === 'status') {
    const receipt = value.receipt === null ? null : parseExecutionReceipt(value.receipt);
    return exactNodeFields(value, ['kind', 'receipt']) && (value.receipt === null || receipt) ? { kind: 'status', receipt } : null;
  }
  if (value.kind === 'control-prepared') {
    const preparation = parseControlPreparation(value.preparation);
    return exactNodeFields(value, ['kind', 'preparation']) && preparation ? { kind: 'control-prepared', preparation } : null;
  }
  if (value.kind === 'goal-result' || value.kind === 'steer-result') {
    const outcome = parseControlOutcome(value.outcome);
    if (!outcome) return null;
    if (value.kind === 'goal-result') return exactNodeFields(value, ['kind', 'outcome']) ? { kind: 'goal-result', outcome } : null;
    return exactNodeFields(value, ['kind', 'outcome', 'deliveryPrepared']) && typeof value.deliveryPrepared === 'boolean'
      ? { kind: 'steer-result', outcome, deliveryPrepared: value.deliveryPrepared } : null;
  }
  return value.kind === 'rejected' && exactNodeFields(value, ['kind', 'code']) && NODE_EXECUTION_ERROR_CODES.some((code) => code === value.code)
    ? { kind: 'rejected', code: value.code as NodeExecutionErrorCode } : null;
}

function parseExecutionTicket(value: unknown): NodeExecutionTicket | null {
  if (!exactNodeFields(value, ['identity', 'location', 'projectPath', 'runId']) || !isExecutionIdentity(value.runId)
    || !nodeString(value.projectPath, 32_768)) return null;
  const identity = parseNodeOperationIdentity(value.identity);
  const location = parseExecutionLocation(value.location);
  return identity && location ? { identity, location, projectPath: value.projectPath, runId: value.runId } : null;
}

function parseExecutionReceipt(value: unknown): NodeExecutionReceipt | null {
  if (!exactNodeFields(value, ['identity', 'runId', 'phase', 'dispatch', 'abort', 'control']) || !isExecutionIdentity(value.runId)
    || !['preparing', 'prepared', 'dispatched', 'ended', 'failed', 'released', 'expired'].includes(value.phase as string)
    || ![null, 'pending', 'completed', 'failed'].includes(value.dispatch as string | null)
    || ![null, 'pending', 'requested', 'unconfirmed'].includes(value.abort as string | null)) return null;
  const identity = parseNodeOperationIdentity(value.identity);
  const control = value.control === null ? null : parseControlReceipt(value.control);
  if (!identity || (value.control !== null && !control)) return null;
  return { identity, runId: value.runId, phase: value.phase as NodeExecutionReceipt['phase'],
    dispatch: value.dispatch as NodeExecutionReceipt['dispatch'], abort: value.abort as NodeExecutionReceipt['abort'], control };
}

function parseControlPreparation(value: unknown): NodeControlPreparation | null {
  if (!exactNodeFields(value, ['kind'], ['ticket'])) return null;
  if (value.kind === 'unavailable' || value.kind === 'unsupported') return exactNodeFields(value, ['kind']) ? { kind: value.kind } : null;
  if (value.kind !== 'ready' || !exactNodeFields(value, ['kind', 'ticket'])) return null;
  const ticket = parseControlTicket(value.ticket);
  return ticket ? { kind: 'ready', ticket } : null;
}

function parseControlTicket(value: unknown): NodeControlTicket | null {
  if (!exactNodeFields(value, ['identity', 'controlId', 'kind', 'runId']) || !isExecutionIdentity(value.controlId)
    || !isExecutionIdentity(value.runId) || (value.kind !== 'steer' && value.kind !== 'goal')) return null;
  const identity = parseNodeOperationIdentity(value.identity);
  return identity ? { identity, controlId: value.controlId, kind: value.kind, runId: value.runId } : null;
}

function parseControlReceipt(value: unknown): NodeControlReceipt | null {
  if (!exactNodeFields(value, ['controlId', 'kind', 'runId', 'phase', 'deliveryPrepared', 'outcome'])
    || !isExecutionIdentity(value.controlId) || !isExecutionIdentity(value.runId) || (value.kind !== 'steer' && value.kind !== 'goal')
    || !['preparing', 'prepared', 'committing', 'settled'].includes(value.phase as string) || typeof value.deliveryPrepared !== 'boolean') return null;
  const outcome = value.outcome === null ? null : parseControlOutcome(value.outcome);
  if ((value.outcome !== null && !outcome) || (value.phase === 'settled') !== (outcome !== null)) return null;
  return { controlId: value.controlId, kind: value.kind, runId: value.runId, phase: value.phase as NodeControlReceipt['phase'],
    deliveryPrepared: value.deliveryPrepared, outcome };
}

function parseControlOutcome(value: unknown): NodeControlOutcome | null {
  if (!exactNodeFields(value, ['kind'], ['reason', 'outcome'])) return null;
  if (value.kind === 'accepted') return exactNodeFields(value, ['kind']) ? { kind: 'accepted' } : null;
  if (value.kind === 'failed') return exactNodeFields(value, ['kind', 'outcome']) && (value.outcome === 'not-sent' || value.outcome === 'unknown')
    ? { kind: 'failed', outcome: value.outcome } : null;
  return value.kind === 'rejected' && exactNodeFields(value, ['kind', 'reason'])
    && ['no-active-turn', 'turn-changed', 'turn-not-steerable', 'invalid-input', 'provider-rejected', 'unavailable', 'unsupported'].includes(value.reason as string)
    ? { kind: 'rejected', reason: value.reason as Extract<NodeControlOutcome, { kind: 'rejected' }>['reason'] } : null;
}
