import { isRecord, stableJsonStringify, type JsonObject } from '@garcon/common/json';
import { isExecutionIdentity, MAX_EXECUTION_IDENTITY_LENGTH } from '@garcon/common/execution-location';
import { isPermissionOccurrenceId } from '@garcon/common/permission-occurrence';
import { parseNodeSessionIdentity } from '@garcon/common/node-operation';
import { isToolUseMessage, type ChatMessage } from '@garcon/common/chat-types';
import type {
  NodeOutputAck, NodeOutputFrame, NodePermissionHandleRegistrar, NodeReplayReply, ProducerStreamIdentity, WireProducerEvent,
} from './contracts/node-wire.js';
import type { AgentPermissionResponseCapability, AgentProducerEvent } from './contracts/producer.js';
import { parseOwnedNodeMessage } from './node-wire-message.js';
import { MAX_NODE_OUTPUT_BYTES, NodeWireSnapshot } from './node-wire-snapshot.js';
import { parseOwnedEstablishedSession } from './established-session.js';
import { isNormalizedJsonObject as jsonObject } from './normalized-json.js';

export const NODE_WIRE_VERSION = 1;
export { MAX_NODE_OUTPUT_BYTES } from './node-wire-snapshot.js';
export const MAX_NODE_OUTPUT_SEQUENCE = Number.MAX_SAFE_INTEGER - 1;
const MAXIMAL_IDENTITY = 'x'.repeat(MAX_EXECUTION_IDENTITY_LENGTH);
type WirePermissionRequest = Extract<WireProducerEvent, { decisionHandle: string }>;

export function parseNodeOutputText(text: string): NodeOutputFrame | null {
  if (Buffer.byteLength(text) > MAX_NODE_OUTPUT_BYTES) return null;
  try {
    return parseSnapshot(JSON.parse(text), parseOwnedNodeOutputFrame);
  } catch {
    return null;
  }
}

export function serializeNodeOutputFrame(frame: NodeOutputFrame): string {
  const parsed = parseOwnedNodeOutputFrame(new NodeWireSnapshot().value(frame));
  if (!parsed) throw new TypeError('Invalid normalized node output');
  const text = JSON.stringify(parsed);
  if (Buffer.byteLength(text) > MAX_NODE_OUTPUT_BYTES) throw new RangeError('Node output exceeds the frame limit');
  return text;
}

export function parseProducerStreamIdentity(value: unknown): ProducerStreamIdentity | null {
  return parseSnapshot(value, parseOwnedProducerStreamIdentity);
}

export function parseNodeOutputFrame(value: unknown): NodeOutputFrame | null {
  return parseSnapshot(value, (owned) => {
    const frame = parseOwnedNodeOutputFrame(owned);
    return frame && Buffer.byteLength(JSON.stringify(frame)) <= MAX_NODE_OUTPUT_BYTES ? frame : null;
  });
}

export function parseNodeOutputAck(value: unknown): NodeOutputAck | null {
  return parseSnapshot(value, parseOwnedNodeOutputAck);
}

export function parseNodeReplayReply(value: unknown): NodeReplayReply | null {
  return parseSnapshot(value, parseOwnedNodeReplayReply);
}

export function parseWireProducerEvent(value: unknown): WireProducerEvent | null {
  return parseSnapshot(value, parseOwnedWireProducerEvent);
}

function parseSnapshot<T>(value: unknown, parse: (owned: unknown) => T | null): T | null {
  try {
    return parse(new NodeWireSnapshot().value(value));
  } catch {
    return null;
  }
}

function parseOwnedProducerStreamIdentity(value: unknown): ProducerStreamIdentity | null {
  if (!isRecord(value) || !keys(value, ['controllerBootId', 'nodeBootId', 'logicalSessionId', 'streamId'])
    || !isExecutionIdentity(value.streamId)) return null;
  const session = parseNodeSessionIdentity({
    controllerBootId: value.controllerBootId, nodeBootId: value.nodeBootId, logicalSessionId: value.logicalSessionId,
  });
  return session ? { ...session, streamId: value.streamId } : null;
}

export function producerStreamKey(stream: ProducerStreamIdentity): string {
  return JSON.stringify([stream.controllerBootId, stream.nodeBootId, stream.logicalSessionId, stream.streamId]);
}

function parseOwnedNodeOutputFrame(value: unknown): NodeOutputFrame | null {
  if (!isRecord(value) || !keys(value, ['type', 'stream', 'sequence', 'event'])
    || value.type !== 'node-output' || !sequence(value.sequence, 1) || value.sequence > MAX_NODE_OUTPUT_SEQUENCE) return null;
  const stream = parseOwnedProducerStreamIdentity(value.stream);
  const event = parseOwnedWireProducerEvent(value.event);
  return stream && event ? { type: 'node-output', stream, sequence: value.sequence, event } : null;
}

function parseOwnedNodeOutputAck(value: unknown): NodeOutputAck | null {
  if (!isRecord(value) || !keys(value, ['type', 'stream', 'throughSequence'])
    || value.type !== 'node-output-ack' || !sequence(value.throughSequence) || value.throughSequence > MAX_NODE_OUTPUT_SEQUENCE) return null;
  const stream = parseOwnedProducerStreamIdentity(value.stream);
  return stream ? { type: 'node-output-ack', stream, throughSequence: value.throughSequence } : null;
}

function parseOwnedNodeReplayReply(value: unknown): NodeReplayReply | null {
  if (!isRecord(value)) return null;
  const stream = parseOwnedProducerStreamIdentity(value.stream);
  if (!stream) return null;
  if (value.type === 'node-replay-ready' && keys(value, ['type', 'stream', 'afterSequence', 'throughSequence'])
    && sequence(value.afterSequence) && sequence(value.throughSequence)
    && value.throughSequence >= value.afterSequence && value.throughSequence <= MAX_NODE_OUTPUT_SEQUENCE) {
    return { type: value.type, stream, afterSequence: value.afterSequence, throughSequence: value.throughSequence };
  }
  if (value.type === 'node-replay-gap'
    && keys(value, ['type', 'stream', 'requestedAfter', 'firstRetainedSequence', 'lastProducedSequence'])
    && sequence(value.requestedAfter) && sequence(value.firstRetainedSequence, 1)
    && sequence(value.lastProducedSequence, 1) && value.lastProducedSequence <= MAX_NODE_OUTPUT_SEQUENCE
    && value.requestedAfter < value.lastProducedSequence
    && value.firstRetainedSequence > value.requestedAfter + 1
    && value.firstRetainedSequence <= value.lastProducedSequence + 1) {
    return { type: value.type, stream, requestedAfter: value.requestedAfter,
      firstRetainedSequence: value.firstRetainedSequence, lastProducedSequence: value.lastProducedSequence };
  }
  return null;
}

function parseOwnedWireProducerEvent(value: unknown): WireProducerEvent | null {
  if (!isRecord(value)) return null;
  switch (value.type) {
    case 'rows': {
      if (!keys(value, ['type', 'rows']) || !Array.isArray(value.rows)) return null;
      const rows: Extract<WireProducerEvent, { type: 'rows' }>['rows'][number][] = [];
      for (const row of value.rows) {
        if (!isRecord(row) || !keys(row, ['message', 'providerMeta'])
          || (row.providerMeta !== null && !jsonObject(row.providerMeta))) return null;
        const message = wireMessage(row.message);
        if (!message) return null;
        rows.push({ message, providerMeta: row.providerMeta });
      }
      return { type: 'rows', rows };
    }
    case 'session': {
      if (!keys(value, ['type', 'session'])) return null;
      const session = parseOwnedEstablishedSession(value.session);
      return session ? { type: 'session', session } : null;
    }
    case 'notice': {
      if (!keys(value, ['type', 'runId', 'content'], ['title']) || !isExecutionIdentity(value.runId)
        || typeof value.content !== 'string' || (value.title !== undefined && typeof value.title !== 'string')) return null;
      return { type: 'notice', runId: value.runId, content: value.content,
        ...(value.title === undefined ? {} : { title: value.title }) };
    }
    case 'run-ended': {
      if (!isExecutionIdentity(value.runId)) return null;
      const base = { type: 'run-ended', runId: value.runId } as const;
      if (value.outcome === 'finished' && keys(value, ['type', 'runId', 'outcome'], ['finalResponse'])) {
        if (value.finalResponse === undefined) return { ...base, outcome: 'finished' };
        const response = value.finalResponse;
        if (!isRecord(response) || !keys(response, ['type', 'text']) || response.type !== 'text' || typeof response.text !== 'string') return null;
        return { ...base, outcome: 'finished', finalResponse: { type: 'text', text: response.text } };
      }
      if (value.outcome === 'failed' && keys(value, ['type', 'runId', 'outcome'], ['error'])) {
        if (value.error === undefined) return { ...base, outcome: 'failed' };
        const error = value.error;
        if (!isRecord(error) || !keys(error, ['code'], ['message']) || !nonEmpty(error.code)
          || (error.message !== undefined && typeof error.message !== 'string')) return null;
        return { ...base, outcome: 'failed', error: { code: error.code, ...(error.message === undefined ? {} : { message: error.message }) } };
      }
      return value.outcome === 'interrupted' && keys(value, ['type', 'runId', 'outcome'])
        ? { ...base, outcome: 'interrupted' } : null;
    }
    case 'permission': return permissionEvent(value);
    default: return null;
  }
}

function permissionEvent(value: Record<string, unknown>): Extract<WireProducerEvent, { type: 'permission' }> | null {
  if (!isExecutionIdentity(value.runId) || !isRecord(value.lifecycle)) return null;
  const lifecycle = value.lifecycle;
  if (!isPermissionOccurrenceId(lifecycle.permissionOccurrenceId)) return null;
  const base = { type: 'permission', runId: value.runId } as const;
  const permissionOccurrenceId = lifecycle.permissionOccurrenceId;
  if (lifecycle.kind === 'requested') {
    const { decisionHandle, ...request } = value;
    if (!isExecutionIdentity(decisionHandle)) return null;
    const parsed = permissionRequest(request);
    return parsed ? { ...parsed, decisionHandle } : null;
  }
  if (!keys(value, ['type', 'runId', 'lifecycle'])) return null;
  if (lifecycle.kind === 'expired' && keys(lifecycle, ['kind', 'permissionOccurrenceId'])) {
    return { ...base, lifecycle: { kind: 'expired', permissionOccurrenceId } };
  }
  if (lifecycle.kind === 'cancelled' && keys(lifecycle, ['kind', 'permissionOccurrenceId', 'reason'])
    && (lifecycle.reason === null || typeof lifecycle.reason === 'string')) {
    return { ...base, lifecycle: { kind: 'cancelled', permissionOccurrenceId, reason: lifecycle.reason } };
  }
  return null;
}

function permissionRequest(value: unknown): Omit<WirePermissionRequest, 'decisionHandle'> | null {
  if (!isRecord(value) || !keys(value, ['type', 'runId', 'lifecycle'])
    || value.type !== 'permission' || !isExecutionIdentity(value.runId) || !isRecord(value.lifecycle)) return null;
  const lifecycle = value.lifecycle;
  if (!keys(lifecycle, ['kind', 'permissionOccurrenceId', 'requestedTool', 'options'])
    || lifecycle.kind !== 'requested' || !isPermissionOccurrenceId(lifecycle.permissionOccurrenceId)
    || !Array.isArray(lifecycle.options)) return null;
  const requestedTool = wireMessage(lifecycle.requestedTool);
  if (!requestedTool) return null;
  const tool = parseOwnedNodeMessage(requestedTool);
  if (!tool || !isToolUseMessage(tool)) return null;
  const options = [];
  for (const option of lifecycle.options) {
    if (!jsonObject(option) || !nonEmpty(option.id) || !nonEmpty(option.label)) return null;
    options.push({ ...option, id: option.id, label: option.label });
  }
  return { type: 'permission', runId: value.runId,
    lifecycle: { kind: 'requested', permissionOccurrenceId: lifecycle.permissionOccurrenceId, requestedTool, options } };
}

export function encodeWireProducerEvent(
  event: AgentProducerEvent,
  permissions: NodePermissionHandleRegistrar,
): WireProducerEvent {
  const snapshot = new NodeWireSnapshot();
  const captured = snapshot.captureEnvelope(event, ['type', 'rows', 'session', 'runId', 'content', 'title', 'outcome', 'error', 'finalResponse', 'lifecycle', 'decision']);
  let wire: unknown;
  if (captured.type === 'rows') {
    if (!keys(captured, ['type', 'rows'])) throw new TypeError('Invalid normalized provider output');
    const rows = snapshot.array(captured.rows, (value) => {
      const row = snapshot.captureEnvelope(value, ['message', 'providerMeta']);
      return { message: snapshot.message(row.message), providerMeta: snapshot.value(row.providerMeta ?? null) };
    });
    wire = { type: 'rows', rows: rows.map((row) => ({ ...row, message: normalizedMessage(row.message) })) };
  } else if (captured.type === 'permission') {
    if (!keys(captured, ['type', 'runId', 'lifecycle'], ['decision'])) throw new TypeError('Invalid normalized provider output');
    const lifecycle = snapshot.captureEnvelope(captured.lifecycle, ['kind', 'permissionOccurrenceId', 'requestedTool', 'options', 'reason']);
    if (lifecycle.kind === 'requested') {
      if (!keys(lifecycle, ['kind', 'permissionOccurrenceId', 'requestedTool', 'options'])) throw new TypeError('Invalid normalized provider output');
      const request = permissionRequest({ type: 'permission', runId: snapshot.value(captured.runId), lifecycle: {
        kind: 'requested', permissionOccurrenceId: snapshot.value(lifecycle.permissionOccurrenceId),
        requestedTool: normalizedMessage(snapshot.message(lifecycle.requestedTool)), options: snapshot.value(lifecycle.options),
      } });
      if (!request) throw new TypeError('Invalid normalized provider output');
      const capability = capturePermissionCapability(captured.decision, request.lifecycle.permissionOccurrenceId,
        'Permission output requires its exact response capability');
      preflightPermissionFrame(request);
      const handle = permissions.createHandle();
      if (!isExecutionIdentity(handle)) throw new TypeError('Invalid permission decision handle');
      const permissionOutput = { ...request, decisionHandle: handle };
      permissions.register(handle, capability, request.runId);
      return permissionOutput;
    }
    if (captured.decision !== undefined) throw new TypeError('Invalid normalized provider output');
    wire = { type: 'permission', runId: snapshot.value(captured.runId), lifecycle: snapshot.value(lifecycle) };
  } else {
    wire = snapshot.value(captured);
  }
  const parsed = parseOwnedWireProducerEvent(wire);
  if (!parsed) throw new TypeError('Invalid normalized provider output');
  return parsed;
}

function preflightPermissionFrame(request: Omit<WirePermissionRequest, 'decisionHandle'>): void {
  // Reserves the largest legal envelope before the allocator can register a live capability.
  serializeNodeOutputFrame({
    type: 'node-output',
    stream: {
      controllerBootId: MAXIMAL_IDENTITY, nodeBootId: MAXIMAL_IDENTITY,
      logicalSessionId: MAXIMAL_IDENTITY, streamId: MAXIMAL_IDENTITY,
    },
    sequence: MAX_NODE_OUTPUT_SEQUENCE,
    event: { ...request, decisionHandle: MAXIMAL_IDENTITY },
  });
}

export function decodeWireProducerEvent(
  value: WireProducerEvent,
  decision: (handle: string, runId: string, permissionOccurrenceId: string) => AgentPermissionResponseCapability,
): AgentProducerEvent {
  const event = parseWireProducerEvent(value);
  if (!event) throw new TypeError('Invalid normalized provider output');
  if (event.type === 'rows') {
    return { type: 'rows', rows: event.rows.map((row) => ({
      message: requiredMessage(row.message), ...(row.providerMeta === null ? {} : { providerMeta: row.providerMeta }),
    })) };
  }
  if (event.type === 'permission') {
    if (event.lifecycle.kind !== 'requested') return { type: 'permission', runId: event.runId, lifecycle: event.lifecycle };
    const tool = requiredMessage(event.lifecycle.requestedTool);
    if (!isToolUseMessage(tool) || event.decisionHandle === undefined) throw new TypeError('Invalid permission output');
    const capability = capturePermissionCapability(
      decision(event.decisionHandle, event.runId, event.lifecycle.permissionOccurrenceId),
      event.lifecycle.permissionOccurrenceId, 'Mismatched permission capability',
    );
    return { type: 'permission', runId: event.runId,
      lifecycle: { ...event.lifecycle, requestedTool: tool }, decision: capability };
  }
  return event;
}

function requiredMessage(value: JsonObject): ChatMessage {
  const message = parseOwnedNodeMessage(value);
  if (!message) throw new TypeError('Invalid normalized provider message');
  return message;
}

function normalizedMessage(value: JsonObject): JsonObject {
  const message = parseOwnedNodeMessage(value);
  if (!message) throw new TypeError('Invalid normalized provider output');
  return new NodeWireSnapshot().message(message);
}

function capturePermissionCapability(value: unknown, occurrence: string, error: string): AgentPermissionResponseCapability {
  if (!isRecord(value)) throw new TypeError(error);
  const permissionOccurrenceId = value.permissionOccurrenceId;
  const respond = value.respond;
  if (permissionOccurrenceId !== occurrence || typeof respond !== 'function') throw new TypeError(error);
  return Object.freeze({ permissionOccurrenceId,
    respond: (payload: Parameters<AgentPermissionResponseCapability['respond']>[0]) => Reflect.apply(respond, value, [payload]),
  });
}

function wireMessage(value: unknown): JsonObject | null {
  if (!jsonObject(value) || typeof value.type !== 'string' || typeof value.timestamp !== 'string') return null;
  try {
    const message = parseOwnedNodeMessage(value);
    if (!message) return null;
    const canonical = new NodeWireSnapshot().message(message);
    return stableJsonStringify(value) === stableJsonStringify(canonical) ? canonical : null;
  } catch {
    return null;
  }
}

function keys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  return required.every((key) => Object.hasOwn(value, key) && value[key] !== undefined)
    && Object.keys(value).every((key) => value[key] === undefined || required.includes(key) || optional.includes(key));
}

function sequence(value: unknown, minimum = 0): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && !value.includes('\0');
}
