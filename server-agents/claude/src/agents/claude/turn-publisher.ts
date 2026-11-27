import {
  runtimeFailure,
  runtimeRows,
  type AgentRuntimeEvent,
  type AgentRuntimeOperation,
} from '@garcon/server-agent-common/execution/runtime-events';
import type { AgentLogger, AgentRunFailureCertainty } from '@garcon/server-agent-interface';
import { errorMessage } from '@garcon/server-agent-common/lib/errors';
import type { ClaudeActiveTurn } from './active-turn.js';
import type { ClaudeRunningSession } from './runtime-state.js';

type SessionRoute = Pick<ClaudeRunningSession, 'id' | 'chatId'>;

export class ClaudeTurnPublisher {
  constructor(private readonly logger: AgentLogger) {}

  event(
    session: ClaudeRunningSession,
    turn: ClaudeActiveTurn,
    event: AgentRuntimeEvent,
  ): void {
    this.#publish(session, turn.operation, event);
  }

  #publish(session: SessionRoute, operation: AgentRuntimeOperation, event: AgentRuntimeEvent): void {
    try {
      operation.publish(event);
    } catch (error) {
      this.logger.warn('Claude publisher rejected an event', {
        chatId: session.chatId,
        sessionId: session.id.slice(0, 8),
        runId: operation.runId,
        eventType: event.type,
        error: errorMessage(error),
      });
    }
  }

  messages(
    session: ClaudeRunningSession,
    turn: ClaudeActiveTurn,
    messages: Parameters<typeof runtimeRows>[0],
    exactOrigin = false,
  ): void {
    if (messages.length === 0) return;
    this.event(session, turn, {
      type: 'rows', rows: runtimeRows(messages), ...(exactOrigin ? { originRunId: turn.operation.runId } : {}),
    });
  }

  finished(session: ClaudeRunningSession, turn: ClaudeActiveTurn): void {
    this.event(session, turn, {
      type: 'run-ended',
      runId: turn.operation.runId,
      outcome: 'finished',
      ...(!turn.protocol.abortRequested && !turn.protocol.cleanAbortResultSeen && turn.protocol.finalResponse
        ? { finalResponse: turn.protocol.finalResponse } : {}),
    });
  }

  failed(session: SessionRoute, operation: AgentRuntimeOperation, message: string, certainty?: AgentRunFailureCertainty): void {
    this.#publish(session, operation, runtimeFailure(operation.runId, message, certainty));
  }
}
