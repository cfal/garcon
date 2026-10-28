import { parseChatMessage, isToolUseMessage, type ChatMessage } from '@garcon/common/chat-types';
import { parseCommandWorkingDirectory } from '@garcon/common/command-output';
import { isRecord, type JsonObject } from '@garcon/common/json';
import { parseNativeSeedReceipt } from '@garcon/common/transcript-seed';
import {
  isAgentResourceRef,
  type AgentProducerNotification,
  type AgentEstablishedSession,
  type AgentNativeSessionRef,
  type AgentResourceScope,
  type AgentRunFailureDetail,
} from '@garcon/server-agent-interface';
import { PRODUCER_CREATOR_V1, type EventCreator } from '@garcon/common/executor-contracts';
import type { ContractDefinition } from '@garcon/common/protocol-contracts';

type ProducerEvent = AgentProducerNotification['event'];

export interface ProducerEventCodec extends ContractDefinition {
  decode(value: unknown, scope: AgentResourceScope): ProducerEvent;
}

export interface ProducerCreator extends EventCreator {
  readonly contract: import('./rpc-protocol.js').RpcContractRef<'producers.bind'>;
  readonly codecs: Readonly<Record<string, ProducerEventCodec>>;
}

export const PRODUCER_BINDING_CODEC_V1: ProducerCreator = Object.freeze({ ...PRODUCER_CREATOR_V1,
  codecs: Object.freeze(Object.fromEntries(Object.entries(PRODUCER_CREATOR_V1.codecs).map(([kind, definition]) => [kind,
    Object.freeze({ ...definition, decode: decodeProducerEventV1 }),
  ]))),
});

export const RENDERED_MESSAGES_V1: Readonly<Record<ChatMessage['type'], true>> = Object.freeze({
  'user-message': true,
  'assistant-message': true,
  'command-output': true,
  'command-result': true,
  thinking: true,
  'bash-tool-use': true,
  'exec-tool-use': true,
  'wait-tool-use': true,
  'read-tool-use': true,
  'list-tool-use': true,
  'edit-tool-use': true,
  'write-tool-use': true,
  'apply-patch-tool-use': true,
  'grep-tool-use': true,
  'glob-tool-use': true,
  'web-search-tool-use': true,
  'web-fetch-tool-use': true,
  'todo-write-tool-use': true,
  'todo-read-tool-use': true,
  'task-tool-use': true,
  'codex-subagent-tool-use': true,
  'update-plan-tool-use': true,
  'write-stdin-tool-use': true,
  'enter-plan-mode-tool-use': true,
  'exit-plan-mode-tool-use': true,
  'ask-user-question-tool-use': true,
  'cursor-ask-question-tool-use': true,
  'cursor-create-plan-tool-use': true,
  'amp-finder-tool-use': true,
  'amp-oracle-tool-use': true,
  'amp-librarian-tool-use': true,
  'amp-skill-tool-use': true,
  'amp-mermaid-tool-use': true,
  'amp-handoff-tool-use': true,
  'amp-look-at-tool-use': true,
  'amp-find-thread-tool-use': true,
  'amp-read-thread-tool-use': true,
  'amp-task-list-tool-use': true,
  'claude-tool-search-tool-use': true,
  'claude-monitor-tool-use': true,
  'pi-tool-search-tool-use': true,
  'external-tool-use': true,
  'mcp-tool-use': true,
  'request-permissions-tool-use': true,
  'unknown-tool-use': true,
  'tool-result': true,
  error: true,
  'transcript-notice': true,
  'cli-row': true,
  'permission-request': true,
  'permission-resolved': true,
  'permission-cancelled': true,
  'permission-expired': true,
  compaction: true,
  'agent-switch': true,
});

export const UNREADABLE_EVENT_FAILURE = Object.freeze({
  code: 'OUTCOME_UNKNOWN',
  message: 'An event from the executor could not be read, so this turn\'s outcome is unknown. Native history may contain additional output.',
});

export function decodeRenderedMessageV1(value: unknown): ChatMessage {
  const message = parseChatMessage(value);
  if (!message || !Object.hasOwn(RENDERED_MESSAGES_V1, message.type)) {
    throw new Error('Unknown v1 normalized message');
  }
  return message;
}

export function decodeProducerEvent(value: unknown, scope: AgentResourceScope, creator: ProducerCreator): ProducerEvent {
  if (!isRecord(value) || typeof value.type !== 'string' || !Object.hasOwn(creator.codecs, value.type)) {
    throw new Error('Producer event is absent from its creator contract');
  }
  return creator.codecs[value.type]!.decode(value, scope);
}

function decodeProducerEventV1(value: unknown, scope: AgentResourceScope): ProducerEvent {
  if (!isRecord(value)) throw new Error('Invalid producer event');
  switch (value.type) {
    case 'rows':
      if (!Array.isArray(value.rows)) break;
      return { type: 'rows', rows: value.rows.map((row) => {
        if (!isRecord(row) || (row.providerMeta !== undefined && !isJsonObject(row.providerMeta))) {
          throw new Error('Invalid producer row');
        }
        return { message: decodeRenderedMessageV1(row.message), ...(row.providerMeta === undefined ? {} : { providerMeta: row.providerMeta }) };
      }) };
    case 'session': return { type: 'session', session: decodeEstablishedSessionV1(value.session, scope) };
    case 'permission':
      return decodePermission(value, scope);
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

function decodePermission(value: Record<string, unknown>, scope: AgentResourceScope): Extract<ProducerEvent, { type: 'permission' }> {
  const lifecycle = value.lifecycle;
  if (!nonempty(value.runId) || !isRecord(lifecycle) || !nonempty(lifecycle.permissionOccurrenceId)) throw new Error('Invalid producer permission');
  const base = { type: 'permission', runId: value.runId } as const;
  const permissionOccurrenceId = lifecycle.permissionOccurrenceId;
  switch (lifecycle.kind) {
    case 'requested': {
      const tool = decodeRenderedMessageV1(lifecycle.requestedTool);
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

export function isJsonObject(value: unknown): value is JsonObject {
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

export function isNativeSessionV1(value: unknown): value is AgentNativeSessionRef {
  return isRecord(value) && nonempty(value.ownerId) && Number.isSafeInteger(value.schemaVersion)
    && Number(value.schemaVersion) > 0 && isJsonObject(value.value);
}

export function decodeEstablishedSessionV1(value: unknown, scope?: AgentResourceScope): AgentEstablishedSession {
  if (!isRecord(value) || !nonempty(value.agentSessionId)
    || !(value.nativeSession === null || isNativeSessionV1(value.nativeSession)
      && (!scope || value.nativeSession.ownerId === scope.integrationId))) throw new SyntaxError('Invalid established session');
  const receipt = value.nativeSeedReceipt === null ? null : parseNativeSeedReceipt(value.nativeSeedReceipt);
  if (value.nativeSeedReceipt !== null && (!receipt || receipt.agentSessionId !== value.agentSessionId)) throw new SyntaxError('Invalid native seed receipt');
  return { agentSessionId: value.agentSessionId, nativeSession: value.nativeSession, nativeSeedReceipt: receipt };
}

function isJsonValue(value: unknown): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  return Array.isArray(value) ? value.every(isJsonValue) : isJsonObject(value);
}
