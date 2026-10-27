import { parseChatMessage, isToolUseMessage, type ChatMessage } from '@garcon/common/chat-types';
import { parseCommandWorkingDirectory } from '@garcon/common/command-output';
import { isRecord, type JsonObject } from '@garcon/common/json';
import { parseNativeSeedReceipt } from '@garcon/common/transcript-seed';
import {
  isAgentResourceRef,
  type AgentProducerNotification,
  type AgentResourceScope,
  type AgentRunFailureDetail,
} from '@garcon/server-agent-interface';
import { CORE_REQUIREMENT, supportsRequirement, type ProtocolProfile, type ProtocolRequirement } from './protocol-compatibility.js';

type ProducerEvent = AgentProducerNotification['event'];

export const PRODUCER_REQUIREMENTS: Readonly<Record<ProducerEvent['type'], ProtocolRequirement>> = Object.freeze({
  rows: CORE_REQUIREMENT,
  session: CORE_REQUIREMENT,
  permission: CORE_REQUIREMENT,
  notice: CORE_REQUIREMENT,
  'run-ended': CORE_REQUIREMENT,
  started: CORE_REQUIREMENT,
  steerable: CORE_REQUIREMENT,
  'publication-failed': CORE_REQUIREMENT,
  'publication-gap': CORE_REQUIREMENT,
  'launch-settled': CORE_REQUIREMENT,
});

export const MESSAGE_REQUIREMENTS: Readonly<Record<ChatMessage['type'], ProtocolRequirement>> = Object.freeze({
  'user-message': CORE_REQUIREMENT,
  'assistant-message': CORE_REQUIREMENT,
  'command-output': CORE_REQUIREMENT,
  'command-result': CORE_REQUIREMENT,
  thinking: CORE_REQUIREMENT,
  'bash-tool-use': CORE_REQUIREMENT,
  'exec-tool-use': CORE_REQUIREMENT,
  'wait-tool-use': CORE_REQUIREMENT,
  'read-tool-use': CORE_REQUIREMENT,
  'list-tool-use': CORE_REQUIREMENT,
  'edit-tool-use': CORE_REQUIREMENT,
  'write-tool-use': CORE_REQUIREMENT,
  'apply-patch-tool-use': CORE_REQUIREMENT,
  'grep-tool-use': CORE_REQUIREMENT,
  'glob-tool-use': CORE_REQUIREMENT,
  'web-search-tool-use': CORE_REQUIREMENT,
  'web-fetch-tool-use': CORE_REQUIREMENT,
  'todo-write-tool-use': CORE_REQUIREMENT,
  'todo-read-tool-use': CORE_REQUIREMENT,
  'task-tool-use': CORE_REQUIREMENT,
  'codex-subagent-tool-use': CORE_REQUIREMENT,
  'update-plan-tool-use': CORE_REQUIREMENT,
  'write-stdin-tool-use': CORE_REQUIREMENT,
  'enter-plan-mode-tool-use': CORE_REQUIREMENT,
  'exit-plan-mode-tool-use': CORE_REQUIREMENT,
  'ask-user-question-tool-use': CORE_REQUIREMENT,
  'cursor-ask-question-tool-use': CORE_REQUIREMENT,
  'cursor-create-plan-tool-use': CORE_REQUIREMENT,
  'amp-finder-tool-use': CORE_REQUIREMENT,
  'amp-oracle-tool-use': CORE_REQUIREMENT,
  'amp-librarian-tool-use': CORE_REQUIREMENT,
  'amp-skill-tool-use': CORE_REQUIREMENT,
  'amp-mermaid-tool-use': CORE_REQUIREMENT,
  'amp-handoff-tool-use': CORE_REQUIREMENT,
  'amp-look-at-tool-use': CORE_REQUIREMENT,
  'amp-find-thread-tool-use': CORE_REQUIREMENT,
  'amp-read-thread-tool-use': CORE_REQUIREMENT,
  'amp-task-list-tool-use': CORE_REQUIREMENT,
  'claude-tool-search-tool-use': CORE_REQUIREMENT,
  'claude-monitor-tool-use': CORE_REQUIREMENT,
  'pi-tool-search-tool-use': CORE_REQUIREMENT,
  'external-tool-use': CORE_REQUIREMENT,
  'mcp-tool-use': CORE_REQUIREMENT,
  'request-permissions-tool-use': CORE_REQUIREMENT,
  'unknown-tool-use': CORE_REQUIREMENT,
  'tool-result': CORE_REQUIREMENT,
  error: CORE_REQUIREMENT,
  'transcript-notice': CORE_REQUIREMENT,
  'cli-row': CORE_REQUIREMENT,
  'permission-request': CORE_REQUIREMENT,
  'permission-resolved': CORE_REQUIREMENT,
  'permission-cancelled': CORE_REQUIREMENT,
  'permission-expired': CORE_REQUIREMENT,
  compaction: CORE_REQUIREMENT,
  'agent-switch': CORE_REQUIREMENT,
});

export const UNREADABLE_EVENT_FAILURE = Object.freeze({
  code: 'OUTCOME_UNKNOWN',
  message: 'An event from the executor could not be read, so this turn\'s outcome is unknown. Native history may contain additional output.',
});

export function decodeProducerMessage(value: unknown, profile: ProtocolProfile): ChatMessage {
  const message = parseChatMessage(value);
  if (!message || !supportsRequirement(profile, MESSAGE_REQUIREMENTS[message.type])) {
    throw new Error('Unknown or unselected normalized message');
  }
  return message;
}

export function decodeProducerEvent(value: unknown, scope: AgentResourceScope, profile: ProtocolProfile): ProducerEvent {
  if (!isRecord(value) || typeof value.type !== 'string' || !Object.hasOwn(PRODUCER_REQUIREMENTS, value.type)
    || !supportsRequirement(profile, PRODUCER_REQUIREMENTS[value.type as ProducerEvent['type']])) {
    throw new Error('Unknown or unselected producer event');
  }
  switch (value.type) {
    case 'rows':
      if (!Array.isArray(value.rows)) break;
      return { type: 'rows', rows: value.rows.map((row) => {
        if (!isRecord(row) || (row.providerMeta !== undefined && !isJsonObject(row.providerMeta))) {
          throw new Error('Invalid producer row');
        }
        return { message: decodeProducerMessage(row.message, profile), ...(row.providerMeta === undefined ? {} : { providerMeta: row.providerMeta }) };
      }) };
    case 'session': {
      const session = value.session;
      if (!isRecord(session) || !nonempty(session.agentSessionId)) break;
      const native = session.nativeSession;
      if (native !== null && (!isRecord(native) || native.ownerId !== scope.integrationId
        || !Number.isSafeInteger(native.schemaVersion) || Number(native.schemaVersion) < 1 || !isJsonObject(native.value))) break;
      const receipt = session.nativeSeedReceipt === null ? null : parseNativeSeedReceipt(session.nativeSeedReceipt);
      if (session.nativeSeedReceipt !== null && (!receipt || receipt.agentSessionId !== session.agentSessionId)) break;
      return { type: 'session', session: {
        agentSessionId: session.agentSessionId,
        nativeSession: native === null ? null : { ownerId: scope.integrationId, schemaVersion: Number(native.schemaVersion), value: native.value as JsonObject },
        nativeSeedReceipt: receipt,
      } };
    }
    case 'permission':
      return decodePermission(value, scope, profile);
    case 'notice':
      if (!nonempty(value.runId) || typeof value.content !== 'string' || (value.title !== undefined && typeof value.title !== 'string')) break;
      return { type: 'notice', runId: value.runId, content: value.content, ...(value.title === undefined ? {} : { title: value.title }) };
    case 'run-ended': {
      if (!nonempty(value.runId)) break;
      const workingDirectory = value.workingDirectory === undefined ? undefined : parseCommandWorkingDirectory(value.workingDirectory);
      if (workingDirectory === null) break;
      const base = { type: 'run-ended', runId: value.runId, ...(workingDirectory ? { workingDirectory } : {}) } as const;
      if (value.outcome === 'finished' && value.error === undefined) {
        if (value.finalResponse === undefined) return { ...base, outcome: 'finished' };
        const response = value.finalResponse;
        if (isRecord(response) && (response.type === 'text' || response.type === 'literal-text') && typeof response.text === 'string') {
          return { ...base, outcome: 'finished', finalResponse: { type: response.type, text: response.text } };
        }
      }
      if (value.outcome === 'failed' && value.finalResponse === undefined) {
        return { ...base, outcome: 'failed', ...(value.error === undefined ? {} : { error: decodeFailure(value.error) }) };
      }
      if (value.outcome === 'interrupted' && value.error === undefined && value.finalResponse === undefined) return { ...base, outcome: 'interrupted' };
      break;
    }
    case 'started':
    case 'steerable':
      if (nonempty(value.runId)) return { type: value.type, runId: value.runId };
      break;
    case 'publication-failed':
      return { type: 'publication-failed', error: decodeFailure(value.error) };
    case 'publication-gap':
      return { type: 'publication-gap' };
    case 'launch-settled':
      if (!nonempty(value.runId)) break;
      if (value.handle === undefined) return { type: 'launch-settled', runId: value.runId, error: decodeFailure(value.error) };
      if (value.error === undefined && isAgentResourceRef(value.handle, 'execution', scope)) {
        return { type: 'launch-settled', runId: value.runId, handle: value.handle };
      }
      break;
  }
  throw new Error('Invalid producer event');
}

function decodePermission(value: Record<string, unknown>, scope: AgentResourceScope, profile: ProtocolProfile): Extract<ProducerEvent, { type: 'permission' }> {
  const lifecycle = value.lifecycle;
  if (!nonempty(value.runId) || !isRecord(lifecycle) || !nonempty(lifecycle.permissionOccurrenceId)) throw new Error('Invalid producer permission');
  const base = { type: 'permission', runId: value.runId } as const;
  const permissionOccurrenceId = lifecycle.permissionOccurrenceId;
  switch (lifecycle.kind) {
    case 'requested': {
      const tool = decodeProducerMessage(lifecycle.requestedTool, profile);
      const decision = value.decision;
      if (!isToolUseMessage(tool) || !isRecord(decision) || decision.permissionOccurrenceId !== permissionOccurrenceId
        || !isAgentResourceRef(decision.response, 'permission-response', scope) || !Array.isArray(lifecycle.options)
        || (lifecycle.reason !== undefined && typeof lifecycle.reason !== 'string')) break;
      const options = lifecycle.options.map((option) => {
        if (!isJsonObject(option) || !nonempty(option.id) || typeof option.label !== 'string') throw new Error('Invalid permission option');
        return { ...option, id: option.id, label: option.label };
      });
      return { ...base, lifecycle: {
        kind: 'requested', permissionOccurrenceId, requestedTool: tool, options,
        ...(lifecycle.reason === undefined ? {} : { reason: lifecycle.reason }),
      }, decision: { permissionOccurrenceId, response: decision.response } };
    }
    case 'cancelled':
      if (value.decision === undefined && (lifecycle.reason === null || typeof lifecycle.reason === 'string')) {
        return { ...base, lifecycle: { kind: 'cancelled', permissionOccurrenceId, reason: lifecycle.reason } };
      }
      break;
    case 'expired':
      if (value.decision === undefined) return { ...base, lifecycle: { kind: 'expired', permissionOccurrenceId } };
      break;
  }
  throw new Error('Invalid producer permission');
}

function decodeFailure(value: unknown): AgentRunFailureDetail {
  if (!isRecord(value) || !nonempty(value.code) || (value.message !== undefined && typeof value.message !== 'string')) {
    throw new Error('Invalid producer failure');
  }
  return { code: value.code, ...(value.message === undefined ? {} : { message: value.message }) };
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isJsonObject(value: unknown): value is JsonObject {
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function isJsonValue(value: unknown): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  return Array.isArray(value) ? value.every(isJsonValue) : isJsonObject(value);
}
