import {
  NODE_WIRE_VERSION, parseProducerStreamIdentity, snapshotEstablishedSession, isNormalizedJsonObject,
  type ProducerStreamIdentity,
} from '@garcon/server-agent-interface';
import { isExecutionIdentity, parseExecutionLocation, type ExecutionLocation } from '../../../common/execution-location.js';
import { parseChatId } from '../../../common/chat-id.js';
import { parseNodeOperationIdentity, parseNodeSessionIdentity, sameNodeSession, type NodeOperationIdentity, type NodeSessionIdentity } from '../../../common/node-operation.js';
import type { NodeExecutionRequest } from '../../execution-node/operation-table.js';
import type { ProviderConfigurationRequest } from '../provider-configuration.js';
import { parseNodeProviderConfiguration } from './provider-configuration-wire.js';
import { parseNodeBulkIdentity, type NodeBulkIdentity } from './bulk-wire.js';
import { exactNodeFields, nodeString, parsePrivateNodeJson } from './private-json.js';
import { isNodeRequestTimeout } from '../deadline.js';

export const MAX_NODE_EXECUTION_FRAME_BYTES = 256 * 1024;

export type NodeExecutionCommand =
  | { readonly method: 'prepare'; readonly location: ExecutionLocation; readonly request: NodeExecutionRequest }
  | { readonly method: 'dispatch'; readonly identity: NodeOperationIdentity; readonly body: NodeBulkIdentity; readonly stream: ProducerStreamIdentity }
  | { readonly method: 'release' | 'abort' | 'status' | 'prepare-steer'; readonly identity: NodeOperationIdentity }
  | { readonly method: 'abort-run'; readonly identity: NodeOperationIdentity; readonly runId: string }
  | { readonly method: 'commit-steer'; readonly identity: NodeOperationIdentity; readonly controlId: string; readonly body: NodeBulkIdentity }
  | { readonly method: 'prepare-goal'; readonly identity: NodeOperationIdentity; readonly runId: string;
      readonly configuration: ProviderConfigurationRequest; readonly body: NodeBulkIdentity }
  | { readonly method: 'commit-goal' | 'cancel-control'; readonly identity: NodeOperationIdentity; readonly controlId: string };

export interface NodeExecutionCall {
  readonly type: 'node-execution-request';
  readonly version: typeof NODE_WIRE_VERSION;
  readonly session: NodeSessionIdentity;
  readonly requestId: number;
  readonly timeoutMs: number;
  readonly command: NodeExecutionCommand;
}

export interface NodeExecutionEnvelope extends Omit<NodeExecutionCall, 'command'> {
  readonly command: NodeExecutionCommand | null;
}

export interface NodeExecutionCancellation {
  readonly type: 'node-execution-cancel';
  readonly version: typeof NODE_WIRE_VERSION;
  readonly session: NodeSessionIdentity;
  readonly requestId: number;
}

export function isNodeExecutionReconciliation(command: NodeExecutionCommand): boolean {
  return command.method === 'abort' || command.method === 'abort-run' || command.method === 'status'
    || command.method === 'release' || command.method === 'cancel-control';
}

export function parseNodeExecutionCancellationText(text: string): NodeExecutionCancellation | null {
  const value = parsePrivateNodeJson(text, MAX_NODE_EXECUTION_FRAME_BYTES);
  if (!exactNodeFields(value, ['type', 'version', 'session', 'requestId'])
    || value.type !== 'node-execution-cancel' || value.version !== NODE_WIRE_VERSION
    || !Number.isSafeInteger(value.requestId) || (value.requestId as number) < 1) return null;
  const session = parseNodeSessionIdentity(value.session);
  return session ? { type: 'node-execution-cancel', version: NODE_WIRE_VERSION, session, requestId: value.requestId as number } : null;
}

export function serializeNodeExecutionCancellation(cancel: NodeExecutionCancellation): string {
  if (!isNormalizedJsonObject(cancel)) throw new TypeError('Invalid node execution cancellation');
  const text = JSON.stringify(cancel);
  if (!parseNodeExecutionCancellationText(text)) throw new TypeError('Invalid node execution cancellation');
  return text;
}

export function parseNodeExecutionCallText(text: string): NodeExecutionCall | null {
  const envelope = parseNodeExecutionEnvelopeText(text);
  return envelope?.command ? { ...envelope, command: envelope.command } : null;
}

export function parseNodeExecutionEnvelopeText(text: string): NodeExecutionEnvelope | null {
  const value = parsePrivateNodeJson(text, MAX_NODE_EXECUTION_FRAME_BYTES);
  if (!exactNodeFields(value, ['type', 'version', 'session', 'requestId', 'timeoutMs', 'command'])
    || value.type !== 'node-execution-request' || value.version !== NODE_WIRE_VERSION
    || !isNodeRequestTimeout(value.timeoutMs)
    || !Number.isSafeInteger(value.requestId) || (value.requestId as number) < 1) return null;
  const session = parseNodeSessionIdentity(value.session);
  const command = parseCommand(value.command);
  if (!session || command && (('identity' in command && !sameNodeSession(command.identity, session))
    || ('body' in command && !sameNodeSession(command.body, session))
    || ('stream' in command && !sameNodeSession(command.stream, session)))) return null;
  return { type: 'node-execution-request', version: NODE_WIRE_VERSION, session, requestId: value.requestId as number, timeoutMs: value.timeoutMs, command };
}

export function serializeNodeExecutionCall(call: NodeExecutionCall): string {
  if (!isNormalizedJsonObject(call)) throw new TypeError('Invalid node execution request');
  const text = JSON.stringify(call);
  if (!parseNodeExecutionCallText(text)) throw new TypeError('Invalid node execution request');
  return text;
}

function parseCommand(value: unknown): NodeExecutionCommand | null {
  if (!exactNodeFields(value, ['method'], ['location', 'request', 'identity', 'body', 'stream', 'controlId', 'runId', 'configuration'])) return null;
  if (value.method === 'prepare') {
    if (!exactNodeFields(value, ['method', 'location', 'request'])) return null;
    const location = parseExecutionLocation(value.location);
    const request = parsePreparation(value.request);
    return location && request ? { method: 'prepare', location, request } : null;
  }
  const identity = parseNodeOperationIdentity(value.identity);
  if (!identity) return null;
  if (value.method === 'abort-run') {
    return exactNodeFields(value, ['method', 'identity', 'runId']) && isExecutionIdentity(value.runId)
      ? { method: value.method, identity, runId: value.runId } : null;
  }
  if (value.method === 'release' || value.method === 'abort' || value.method === 'status' || value.method === 'prepare-steer') {
    return exactNodeFields(value, ['method', 'identity']) ? { method: value.method, identity } : null;
  }
  if (value.method === 'commit-goal' || value.method === 'cancel-control') {
    return exactNodeFields(value, ['method', 'identity', 'controlId']) && isExecutionIdentity(value.controlId)
      ? { method: value.method, identity, controlId: value.controlId } : null;
  }
  const body = parseNodeBulkIdentity(value.body);
  if (!body) return null;
  if (value.method === 'dispatch') {
    if (!exactNodeFields(value, ['method', 'identity', 'body', 'stream'])) return null;
    const stream = parseProducerStreamIdentity(value.stream);
    return stream ? { method: 'dispatch', identity, body, stream } : null;
  }
  if (value.method === 'commit-steer') {
    return exactNodeFields(value, ['method', 'identity', 'body', 'controlId']) && isExecutionIdentity(value.controlId)
      ? { method: 'commit-steer', identity, body, controlId: value.controlId } : null;
  }
  if (value.method !== 'prepare-goal' || !exactNodeFields(value, ['method', 'identity', 'body', 'runId', 'configuration'])
    || !isExecutionIdentity(value.runId)) return null;
  const configuration = parseNodeProviderConfiguration(value.configuration);
  return configuration ? { method: 'prepare-goal', identity, body, runId: value.runId, configuration } : null;
}

function parsePreparation(value: unknown): NodeExecutionRequest | null {
  if (!exactNodeFields(value, ['kind', 'chatId', 'runId', 'configuration'], ['agentSessionId', 'nativeSession'])
    || !isExecutionIdentity(value.runId) || typeof value.chatId !== 'string') return null;
  try { if (parseChatId(value.chatId) !== value.chatId) return null; } catch { return null; }
  const configuration = parseNodeProviderConfiguration(value.configuration);
  if (!configuration) return null;
  const base = { chatId: value.chatId, runId: value.runId, configuration };
  if (value.kind === 'start') return exactNodeFields(value, ['kind', 'chatId', 'runId', 'configuration']) ? { kind: 'start', ...base } : null;
  if ((value.kind !== 'resume' && value.kind !== 'compact')
    || !exactNodeFields(value, ['kind', 'chatId', 'runId', 'configuration', 'agentSessionId', 'nativeSession'])
    || !nodeString(value.agentSessionId, 32_768)) return null;
  try {
    const { nativeSession } = snapshotEstablishedSession({ agentSessionId: value.agentSessionId,
      nativeSession: value.nativeSession, nativeSeedReceipt: null });
    return { kind: value.kind, ...base, agentSessionId: value.agentSessionId, nativeSession };
  } catch { return null; }
}
