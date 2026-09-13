import { parseNodeProviderNativeCommand, parseNodeProviderNativeReply, type NodeProviderNativeCommand, type NodeProviderNativeReply } from '../../execution-nodes/transport/provider-native-wire.js';
import { parseNodeProviderHistoryCommand, parseNodeProviderHistoryReply, type NodeProviderHistoryCommand, type NodeProviderHistoryReply } from '../../execution-nodes/transport/provider-history-wire.js';
import { parseNodeProviderAuxiliaryCommand, parseNodeProviderAuxiliaryReply, type NodeProviderAuxiliaryCommand, type NodeProviderAuxiliaryReply } from '../../execution-nodes/transport/provider-auxiliary-wire.js';
import {
  MAX_NODE_OUTPUT_SEQUENCE, NODE_WIRE_VERSION, parseNodeOutputAck, parseNodeReplayReply, parseProducerStreamIdentity,
  producerStreamKey, type NodeOutputAck, type NodeReplayReply, type ProducerStreamIdentity,
} from '@garcon/server-agent-interface';
import { isExecutionIdentity } from '../../../common/execution-location.js';
import { parseNodeOperationIdentity, parseNodeSessionIdentity, sameNodeSession, type NodeOperationIdentity, type NodeSessionIdentity } from '../../../common/node-operation.js';
import { parseNodeBulkDescriptor, parseNodeBulkIdentity, type NodeBulkDescriptor, type NodeBulkIdentity } from '../../execution-nodes/transport/bulk-wire.js';
import { MAX_NODE_EXECUTION_BODY_BYTES, type NodeExecutionBody } from '../../execution-nodes/transport/execution-body-wire.js';
import { parseNodePermissionCommandText, parseNodePermissionResultText, type NodePermissionCommand, type NodePermissionResult } from '../../execution-nodes/transport/permission-wire.js';
import { exactNodeFields, parsePrivateNodeJson } from '../../execution-nodes/transport/private-json.js';
import { parseNodeProviderCatalogReply, type NodeProviderCatalogReply } from '../../execution-nodes/transport/provider-catalog-wire.js';
import { parseNodeProviderAuthCommand, parseNodeProviderAuthReply, type NodeProviderAuthCommand, type NodeProviderAuthReply } from '../../execution-nodes/transport/provider-auth-wire.js';
import { parseNodeProviderCommandsCommand, parseNodeProviderCommandsReply, type NodeProviderCommandsCommand, type NodeProviderCommandsReply } from '../../execution-nodes/transport/provider-commands-wire.js';
import { parseNodeProviderConfigurationCommand, parseNodeProviderConfigurationReply, type NodeProviderConfigurationCommand, type NodeProviderConfigurationReply } from '../../execution-nodes/transport/provider-configuration-update-wire.js';
import { parseNodeSessionConfigurationCommand, parseNodeSessionConfigurationReply, type NodeSessionConfigurationCommand, type NodeSessionConfigurationReply } from '../../execution-nodes/transport/provider-session-configuration-wire.js';
import type { NodeOutputReplayCursor } from './output-delivery.js';
import { isNodeRequestTimeout } from '../../execution-nodes/deadline.js';

export const MAX_NODE_WORKER_SERVICE_BYTES = 256 * 1024;
export const MAX_NODE_WORKER_REPLAY_CURSORS = 256;

export type NodeWorkerServiceCommand =
  | NodeProviderHistoryCommand
  | NodeProviderNativeCommand
  | NodeProviderAuxiliaryCommand
  | NodeProviderAuthCommand
  | NodeProviderCommandsCommand
  | NodeProviderConfigurationCommand
  | NodeSessionConfigurationCommand
  // An installation consumes its stream identity once the session receives it, including rollback.
  | { readonly method: 'install-output'; readonly instanceId: string; readonly stream: ProducerStreamIdentity }
  | { readonly method: 'retire-output'; readonly instanceId: string; readonly stream: ProducerStreamIdentity }
  | { readonly method: 'reserve-body'; readonly instanceId: string; readonly identity: NodeOperationIdentity;
      readonly kind: NodeExecutionBody['kind']; readonly controlId: string | null; readonly descriptor: NodeBulkDescriptor }
  | { readonly method: 'permission'; readonly command: NodePermissionCommand }
  | { readonly method: 'provider-catalog'; readonly instanceId: string; readonly strict: boolean }
  | { readonly method: 'begin-output-recovery' }
  | { readonly method: 'replay-output'; readonly generation: number; readonly cursors: readonly NodeOutputReplayCursor[] }
  | { readonly method: 'resume-output'; readonly generation: number };

export type NodeWorkerServiceResult =
  | NodeProviderHistoryReply
  | NodeProviderNativeReply
  | NodeProviderAuxiliaryReply
  | NodeProviderCatalogReply
  | NodeProviderAuthReply
  | NodeProviderCommandsReply
  | NodeProviderConfigurationReply
  | NodeSessionConfigurationReply
  | { readonly kind: 'output-installed'; readonly instanceId: string; readonly stream: ProducerStreamIdentity }
  // Confirms output fencing only; native work may still occupy its execution capacity.
  | { readonly kind: 'output-fenced'; readonly instanceId: string; readonly stream: ProducerStreamIdentity }
  | { readonly kind: 'body-reserved'; readonly transfer: NodeBulkIdentity }
  | { readonly kind: 'permission-result'; readonly result: NodePermissionResult }
  | { readonly kind: 'output-recovery'; readonly generation: number }
  | { readonly kind: 'output-replayed'; readonly ranges: readonly NodeReplayReply[] }
  | { readonly kind: 'output-live'; readonly live: boolean }
  | { readonly kind: 'rejected'; readonly code: 'VALIDATION_FAILED' | 'NODE_UNAVAILABLE' | 'NODE_CAPACITY' | 'NODE_OUTPUT_RETIRED' | 'NODE_STREAM_IDENTITIES_EXHAUSTED' }
  | { readonly kind: 'unknown' };

interface NodeWorkerServiceEnvelope {
  readonly version: typeof NODE_WIRE_VERSION;
  readonly session: NodeSessionIdentity;
  readonly connectionId: number;
  readonly requestId: number;
}

export type NodeWorkerServiceFrame =
  | NodeWorkerServiceEnvelope & { readonly type: 'node-worker-service-request'; readonly timeoutMs: number; readonly command: NodeWorkerServiceCommand }
  | NodeWorkerServiceEnvelope & { readonly type: 'node-worker-service-result'; readonly result: NodeWorkerServiceResult }
  | NodeWorkerServiceEnvelope & { readonly type: 'node-worker-service-cancel' };

export interface NodeWorkerOutputAcknowledgement {
  readonly type: 'node-worker-output-ack';
  readonly version: typeof NODE_WIRE_VERSION;
  readonly connectionId: number;
  readonly generation: number;
  readonly ack: NodeOutputAck;
}

export interface NodeWorkerOutputSuspension {
  readonly type: 'node-worker-output-suspended';
  readonly version: typeof NODE_WIRE_VERSION;
  readonly session: NodeSessionIdentity;
  readonly connectionId: number;
  readonly generation: number;
}

export function parseNodeWorkerOutputSuspensionText(text: string): NodeWorkerOutputSuspension | null {
  const value = parsePrivateNodeJson(text, 4096);
  if (!exactNodeFields(value, ['type', 'version', 'session', 'connectionId', 'generation']) || value.type !== 'node-worker-output-suspended'
    || value.version !== NODE_WIRE_VERSION || !positiveInteger(value.connectionId) || !positiveInteger(value.generation)) return null;
  const session = parseNodeSessionIdentity(value.session);
  return session ? { type: value.type, version: NODE_WIRE_VERSION, session, connectionId: value.connectionId, generation: value.generation } : null;
}

export function serializeNodeWorkerOutputSuspension(frame: NodeWorkerOutputSuspension): string {
  const text = JSON.stringify(frame);
  if (!parseNodeWorkerOutputSuspensionText(text)) throw new TypeError('Invalid worker output suspension');
  return text;
}

export function parseNodeWorkerServiceText(text: string): NodeWorkerServiceFrame | null {
  const value = parsePrivateNodeJson(text, MAX_NODE_WORKER_SERVICE_BYTES);
  if (!exactNodeFields(value, ['type', 'version', 'session', 'connectionId', 'requestId'], ['command', 'result', 'timeoutMs'])
    || value.version !== NODE_WIRE_VERSION || !positiveInteger(value.connectionId) || !positiveInteger(value.requestId)) return null;
  const session = parseNodeSessionIdentity(value.session);
  if (!session) return null;
  const envelope = { version: NODE_WIRE_VERSION, session, connectionId: value.connectionId, requestId: value.requestId } as const;
  if (value.type === 'node-worker-service-cancel' && exactNodeFields(value, ['type', 'version', 'session', 'connectionId', 'requestId'])) {
    return { ...envelope, type: value.type };
  }
  if (value.type === 'node-worker-service-request' && exactNodeFields(value, ['type', 'version', 'session', 'connectionId', 'requestId', 'timeoutMs', 'command'])
    && isNodeRequestTimeout(value.timeoutMs)) {
    const command = parseCommand(value.command, session, envelope.connectionId);
    return command ? { ...envelope, type: value.type, timeoutMs: value.timeoutMs, command } : null;
  }
  if (value.type === 'node-worker-service-result' && exactNodeFields(value, ['type', 'version', 'session', 'connectionId', 'requestId', 'result'])) {
    const result = parseResult(value.result, session, envelope.connectionId);
    return result ? { ...envelope, type: value.type, result } : null;
  }
  return null;
}

export function serializeNodeWorkerService(frame: NodeWorkerServiceFrame): string {
  const text = JSON.stringify(frame);
  if (!parseNodeWorkerServiceText(text)) throw new TypeError('Invalid worker service frame');
  return text;
}

export function parseNodeWorkerOutputAcknowledgementText(text: string): NodeWorkerOutputAcknowledgement | null {
  const value = parsePrivateNodeJson(text, 4096);
  if (!exactNodeFields(value, ['type', 'version', 'connectionId', 'generation', 'ack']) || value.type !== 'node-worker-output-ack'
    || value.version !== NODE_WIRE_VERSION || !positiveInteger(value.connectionId) || !positiveInteger(value.generation)) return null;
  const ack = parseNodeOutputAck(value.ack);
  return ack ? { type: value.type, version: NODE_WIRE_VERSION, connectionId: value.connectionId, generation: value.generation, ack } : null;
}

export function serializeNodeWorkerOutputAcknowledgement(frame: NodeWorkerOutputAcknowledgement): string {
  const text = JSON.stringify(frame);
  if (!parseNodeWorkerOutputAcknowledgementText(text)) throw new TypeError('Invalid worker output acknowledgement');
  return text;
}

function parseCommand(value: unknown, session: NodeSessionIdentity, connectionId: number): NodeWorkerServiceCommand | null {
  if (!exactNodeFields(value, ['method'], ['instanceId', 'stream', 'identity', 'kind', 'controlId', 'descriptor', 'command', 'generation', 'cursors', 'strict', 'operation', 'sessionId', 'code', 'workspaceId', 'request', 'chat', 'reason', 'connectionId', 'bulkAttemptId', 'facet', 'sequence', 'grant'])) return null;
  if (value.method === 'provider-history-import') {
    const command = parseNodeProviderHistoryCommand(value);
    return command && sameNodeSession(command.identity, session) && command.connectionId === connectionId ? command : null;
  }
  if (value.method === 'provider-single-query' || value.method === 'provider-text-generation') {
    const command = parseNodeProviderAuxiliaryCommand(value);
    return command && sameNodeSession(command.identity, session) ? command : null;
  }
  if (value.method === 'provider-configuration') return parseNodeProviderConfigurationCommand(value);
  if (value.method === 'provider-session-configuration') {
    const command = parseNodeSessionConfigurationCommand(value);
    const identity = command?.operation === 'prepare' ? command.stream : command?.identity;
    return command && (!identity || sameNodeSession(identity, session)) ? command : null;
  }
  if (value.method === 'provider-native-sessions') return parseNodeProviderNativeCommand(value);
  if (value.method === 'provider-auth') return parseNodeProviderAuthCommand(value);
  if (value.method === 'provider-commands') return parseNodeProviderCommandsCommand(value);
  if (value.method === 'provider-catalog' && exactNodeFields(value, ['method', 'instanceId', 'strict'])
    && isExecutionIdentity(value.instanceId) && typeof value.strict === 'boolean') {
    return { method: value.method, instanceId: value.instanceId, strict: value.strict };
  }
  if ((value.method === 'install-output' || value.method === 'retire-output')
    && exactNodeFields(value, ['method', 'instanceId', 'stream']) && isExecutionIdentity(value.instanceId)) {
    const stream = parseProducerStreamIdentity(value.stream);
    return stream && sameNodeSession(stream, session) ? { method: value.method, instanceId: value.instanceId, stream } : null;
  }
  if (value.method === 'reserve-body' && exactNodeFields(value, ['method', 'instanceId', 'identity', 'kind', 'controlId', 'descriptor'])
    && isExecutionIdentity(value.instanceId) && (value.kind === 'execution' || value.kind === 'steer' || value.kind === 'goal')
    && (value.kind === 'steer' ? isExecutionIdentity(value.controlId) : value.controlId === null)) {
    const identity = parseNodeOperationIdentity(value.identity);
    const descriptor = parseNodeBulkDescriptor(value.descriptor);
    return identity && sameNodeSession(identity, session) && descriptor && descriptor.byteLength > 0 && descriptor.byteLength <= MAX_NODE_EXECUTION_BODY_BYTES
      ? { method: value.method, instanceId: value.instanceId, identity, kind: value.kind, controlId: value.controlId as string | null, descriptor } : null;
  }
  if (value.method === 'permission' && exactNodeFields(value, ['method', 'command'])
    && exactNodeFields(value.command, ['method', 'permission'], ['decision'])) {
    const command = parseNodePermissionCommandText(JSON.stringify({ version: NODE_WIRE_VERSION, ...value.command }));
    return command && sameNodeSession(command.permission.stream, session) ? { method: value.method, command } : null;
  }
  if (value.method === 'begin-output-recovery' && exactNodeFields(value, ['method'])) return { method: value.method };
  if (value.method === 'resume-output' && exactNodeFields(value, ['method', 'generation']) && positiveInteger(value.generation)) {
    return { method: value.method, generation: value.generation };
  }
  if (value.method === 'replay-output' && exactNodeFields(value, ['method', 'generation', 'cursors']) && positiveInteger(value.generation)
    && Array.isArray(value.cursors) && value.cursors.length <= MAX_NODE_WORKER_REPLAY_CURSORS) {
    const cursors: NodeOutputReplayCursor[] = [];
    const seen = new Set<string>();
    for (const cursor of value.cursors) {
      if (!exactNodeFields(cursor, ['stream', 'afterSequence']) || !Number.isSafeInteger(cursor.afterSequence)
        || Number(cursor.afterSequence) < 0 || Number(cursor.afterSequence) > MAX_NODE_OUTPUT_SEQUENCE) return null;
      const stream = parseProducerStreamIdentity(cursor.stream);
      if (!stream || !sameNodeSession(stream, session) || seen.has(producerStreamKey(stream))) return null;
      seen.add(producerStreamKey(stream)); cursors.push({ stream, afterSequence: Number(cursor.afterSequence) });
    }
    return { method: value.method, generation: value.generation, cursors };
  }
  return null;
}

function parseResult(value: unknown, session: NodeSessionIdentity, connectionId: number): NodeWorkerServiceResult | null {
  if (!exactNodeFields(value, ['kind'], ['instanceId', 'stream', 'transfer', 'result', 'generation', 'ranges', 'live', 'code', 'snapshot', 'staleModels', 'status', 'workspaceId', 'commands', 'reason', 'configuration', 'identity', 'preparation', 'receipt', 'value', 'operation', 'reference', 'source', 'connectionId', 'bulkAttemptId', 'sequence', 'encoding', 'descriptor', 'settled'])) return null;
  if (value.kind === 'provider-history-result') {
    const result = parseNodeProviderHistoryReply(value);
    return result && sameNodeSession(result.identity, session) && result.connectionId === connectionId ? result : null;
  }
  if (value.kind === 'provider-auxiliary-result' || value.kind === 'provider-auxiliary-too-large') {
    const result = parseNodeProviderAuxiliaryReply(value);
    return result && sameNodeSession(result.identity, session) ? result : null;
  }
  if (value.kind === 'provider-session-configuration-prepared' || value.kind === 'provider-session-configuration-receipt') {
    const reply = parseNodeSessionConfigurationReply(value);
    const identity = reply?.kind === 'provider-session-configuration-receipt' ? reply.identity
      : reply?.preparation.kind === 'prepared' ? reply.preparation.identity : null;
    return reply && (!identity || sameNodeSession(identity, session)) ? reply : null;
  }
  if (value.kind === 'provider-configuration-prepared' || value.kind === 'provider-configuration-rejected'
    || value.kind === 'provider-configuration-too-large') return parseNodeProviderConfigurationReply(value);
  if (value.kind === 'provider-commands' || value.kind === 'provider-commands-unavailable') return parseNodeProviderCommandsReply(value);
  if (value.kind === 'provider-auth-status' || value.kind === 'provider-auth-rejected' || value.kind === 'provider-login-status'
    || value.kind === 'provider-login-launched' || value.kind === 'provider-login-completed') return parseNodeProviderAuthReply(value);
  if (value.kind === 'provider-native-result') return parseNodeProviderNativeReply(value);
  if (value.kind === 'provider-catalog' || value.kind === 'provider-catalog-unavailable') return parseNodeProviderCatalogReply(value);
  if (value.kind === 'unknown' && exactNodeFields(value, ['kind'])) return { kind: value.kind };
  if (value.kind === 'rejected' && exactNodeFields(value, ['kind', 'code'])
    && (value.code === 'VALIDATION_FAILED' || value.code === 'NODE_UNAVAILABLE' || value.code === 'NODE_CAPACITY'
      || value.code === 'NODE_OUTPUT_RETIRED' || value.code === 'NODE_STREAM_IDENTITIES_EXHAUSTED')) return { kind: value.kind, code: value.code };
  if ((value.kind === 'output-installed' || value.kind === 'output-fenced')
    && exactNodeFields(value, ['kind', 'instanceId', 'stream']) && isExecutionIdentity(value.instanceId)) {
    const stream = parseProducerStreamIdentity(value.stream);
    return stream && sameNodeSession(stream, session) ? { kind: value.kind, instanceId: value.instanceId, stream } : null;
  }
  if (value.kind === 'body-reserved' && exactNodeFields(value, ['kind', 'transfer'])) {
    const transfer = parseNodeBulkIdentity(value.transfer);
    return transfer && sameNodeSession(transfer, session) ? { kind: value.kind, transfer } : null;
  }
  if (value.kind === 'permission-result' && exactNodeFields(value, ['kind', 'result'])
    && exactNodeFields(value.result, ['kind'], ['receipt', 'code'])) {
    const result = parseNodePermissionResultText(JSON.stringify({ version: NODE_WIRE_VERSION, ...value.result }));
    return result && (result.kind !== 'permission' || !result.receipt || sameNodeSession(result.receipt.permission.stream, session))
      ? { kind: value.kind, result } : null;
  }
  if (value.kind === 'output-recovery' && exactNodeFields(value, ['kind', 'generation']) && positiveInteger(value.generation)) {
    return { kind: value.kind, generation: value.generation };
  }
  if (value.kind === 'output-live' && exactNodeFields(value, ['kind', 'live']) && typeof value.live === 'boolean') return { kind: value.kind, live: value.live };
  if (value.kind === 'output-replayed' && exactNodeFields(value, ['kind', 'ranges']) && Array.isArray(value.ranges)
    && value.ranges.length <= MAX_NODE_WORKER_REPLAY_CURSORS) {
    const ranges: NodeReplayReply[] = []; const seen = new Set<string>();
    for (const item of value.ranges) {
      const range = parseNodeReplayReply(item);
      if (!range || !sameNodeSession(range.stream, session) || seen.has(producerStreamKey(range.stream))) return null;
      seen.add(producerStreamKey(range.stream)); ranges.push(range);
    }
    return { kind: value.kind, ranges };
  }
  return null;
}

function positiveInteger(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0; }
