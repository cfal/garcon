import {
  PermissionCancelledMessage,
  PermissionExpiredMessage,
  PermissionRequestMessage,
  type ChatMessage,
} from '@garcon/common/chat-types';
import {
  runtimeFailure,
  runtimeRows,
  type AgentRuntimeEvent,
  type AgentRuntimePublisher,
} from '@garcon/server-agent-common/execution/runtime-events';
import type {
  AgentFinalResponse,
  AgentLogger,
  AgentRunFailureCertainty,
} from '@garcon/server-agent-interface';
import type { RuntimePermissionResponse as AgentPermissionResponseCapability } from '@garcon/server-agent-common/execution/runtime-events';
import type { CodexRuntimeOperation } from '../runtime-types.js';

// A Codex call together with the capability core handed it. Each operation captures its own
// publisher so later events cannot resolve through mutable session or chat state.
export type CodexOperation = CodexRuntimeOperation;

export interface CodexTurnFailure {
  readonly message: string;
  readonly certainty?: AgentRunFailureCertainty;
}

export function codexOperation(
  request: { readonly chatId: string; readonly runId: string },
  publish: AgentRuntimePublisher,
): CodexOperation {
  return Object.freeze({
    chatId: request.chatId,
    runId: request.runId,
    publish,
  });
}

export function publishRows(
  logger: AgentLogger,
  chatId: string,
  messages: ChatMessage[],
  operation: CodexOperation | undefined,
  exactOrigin = false,
): void {
  if (!messages.length) return;
  publish(logger, chatId, operation, (runId) => ({
    type: 'rows', rows: runtimeRows(messages), ...(exactOrigin ? { originRunId: runId } : {}),
  }));
}

export function publishPermissionRequested(
  logger: AgentLogger,
  chatId: string,
  message: PermissionRequestMessage,
  decision: AgentPermissionResponseCapability,
  operation: CodexOperation | undefined,
): void {
  if (decision.permissionOccurrenceId !== message.permissionOccurrenceId) {
    throw new TypeError('Permission response capability does not match its request occurrence');
  }
  publish(logger, chatId, operation, (runId) => ({
    type: 'permission',
    runId,
    lifecycle: {
      kind: 'requested',
      permissionOccurrenceId: message.permissionOccurrenceId,
      requestedTool: message.requestedTool,
      options: [],
    },
    decision,
  }));
}

export function publishPermissionCancelled(
  logger: AgentLogger,
  chatId: string,
  message: PermissionCancelledMessage,
  operation: CodexOperation | undefined,
): void {
  publish(logger, chatId, operation, (runId) => ({
    type: 'permission',
    runId,
    lifecycle: {
      kind: 'cancelled',
      permissionOccurrenceId: message.permissionOccurrenceId,
      reason: message.reason ?? null,
    },
  }));
}

export function publishPermissionExpired(
  logger: AgentLogger,
  chatId: string,
  message: PermissionExpiredMessage,
  operation: CodexOperation | undefined,
): void {
  publish(logger, chatId, operation, (runId) => ({
    type: 'permission',
    runId,
    lifecycle: {
      kind: 'expired',
      permissionOccurrenceId: message.permissionOccurrenceId,
    },
  }));
}

export function publishFinished(
  logger: AgentLogger,
  chatId: string,
  operation: CodexOperation | undefined,
  finalResponse?: AgentFinalResponse,
): void {
  publish(logger, chatId, operation, (runId) => ({ type: 'run-ended', runId, outcome: 'finished',
    ...(finalResponse ? { finalResponse } : {}) }));
}

export function publishFailed(
  logger: AgentLogger,
  chatId: string,
  failure: CodexTurnFailure,
  operation: CodexOperation | undefined,
): void {
  publish(logger, chatId, operation, (runId) => runtimeFailure(runId, failure.message, failure.certainty));
}

// The operation holds the only route it has to a transcript, so an event Codex did not name has
// nowhere to go and is dropped rather than attributed to mutable current state. The chat is
// validated rather than used to route: an operation name is meaningful only inside the chat that
// issued it. A superseded operation still reaches its own closed sink, and this boundary absorbs
// that rejection without disrupting another session in the runtime.
function publish(
  logger: AgentLogger,
  chatId: string,
  operation: CodexOperation | undefined,
  build: (runId: string) => AgentRuntimeEvent,
): void {
  if (!operation || operation.chatId !== chatId) {
    logger.warn('Dropped a Codex provider event with no owning operation', {
      chatId,
      runId: operation?.runId ?? null,
      eventType: build('').type,
    });
    return;
  }
  const event = build(operation.runId);
  try {
    operation.publish(event);
  } catch (error) {
    logger.warn('Dropped a Codex provider event at an unavailable sink', {
      chatId,
      runId: operation.runId,
      eventType: event.type,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}
