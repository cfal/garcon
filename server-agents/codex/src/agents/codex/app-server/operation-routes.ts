import type { ChatMessage } from '@garcon/common/chat-types';
import {
  runtimeRows,
  type AgentRuntimeEvent,
  type AgentRuntimePublisher,
} from '@garcon/server-agent-common/execution/runtime-events';
import type { AgentLogger } from '@garcon/server-agent-interface';

// A Codex call together with the capability core handed it. The app-server multiplexes every chat
// over one process-wide stream, so the operation carries the route and the event carries none.
export interface CodexOperation {
  readonly chatId: string;
  readonly runId: string;
  readonly publish: AgentRuntimePublisher;
}

export function codexOperation(
  request: { chatId: string; clientRequestId?: string; turnId?: string },
  publish: AgentRuntimePublisher,
): CodexOperation {
  return Object.freeze({
    chatId: request.chatId,
    runId: request.turnId ?? request.clientRequestId ?? '',
    publish,
  });
}

export function publishRows(
  logger: AgentLogger,
  chatId: string,
  messages: ChatMessage[],
  operation: CodexOperation | undefined,
): void {
  if (!messages.length) return;
  publish(logger, chatId, operation, (runId) => ({ type: 'messages', rows: runtimeRows(messages), runId }));
}

export function publishFinished(
  logger: AgentLogger,
  chatId: string,
  exitCode: number,
  operation: CodexOperation | undefined,
): void {
  publish(logger, chatId, operation, (runId) => ({ type: 'run-ended', runId, outcome: 'finished', exitCode }));
}

export function publishFailed(
  logger: AgentLogger,
  chatId: string,
  message: string,
  operation: CodexOperation | undefined,
): void {
  publish(logger, chatId, operation, (runId) => ({
    type: 'run-ended',
    runId,
    outcome: 'failed',
    error: { code: 'PROVIDER_FAILURE', message },
  }));
}

// The operation holds the only route it has to a transcript, so an event Codex did not name has
// nowhere to go and is dropped rather than attributed to whatever is current. The chat is
// validated rather than used to route: a Codex name means something only inside the chat that
// issued it. A superseded operation still holds its own closed sink, which refuses the publish
// here instead of failing the process-wide stream every chat shares.
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
