import {
  runtimeRows,
  type AgentRuntimeEvent,
} from '@garcon/server-agent-common/execution/runtime-events';
import type { AgentLogger } from '@garcon/server-agent-interface';
import { errorMessage } from '@garcon/server-agent-common/lib/errors';
import type { ClaudeActiveTurn } from './active-turn.js';
import type { ClaudeRunningSession } from './runtime-state.js';

export class ClaudeTurnPublisher {
  constructor(private readonly logger: AgentLogger) {}

  event(
    session: ClaudeRunningSession,
    turn: ClaudeActiveTurn,
    event: AgentRuntimeEvent,
  ): void {
    try {
      turn.operation.publish(event);
    } catch (error) {
      this.logger.warn('Claude publisher rejected an event', {
        sessionId: session.id.slice(0, 8),
        runId: turn.operation.runId,
        eventType: event.type,
        error: errorMessage(error),
      });
    }
  }

  messages(
    session: ClaudeRunningSession,
    turn: ClaudeActiveTurn,
    messages: Parameters<typeof runtimeRows>[0],
  ): void {
    if (messages.length === 0) return;
    this.event(session, turn, { type: 'rows', rows: runtimeRows(messages) });
  }

  finished(session: ClaudeRunningSession, turn: ClaudeActiveTurn): void {
    this.event(session, turn, {
      type: 'run-ended',
      runId: turn.operation.runId,
      outcome: 'finished',
    });
  }

  failed(session: ClaudeRunningSession, turn: ClaudeActiveTurn, message: string): void {
    this.event(session, turn, {
      type: 'run-ended',
      runId: turn.operation.runId,
      outcome: 'failed',
      error: { code: 'PROVIDER_FAILURE', message },
    });
  }
}
