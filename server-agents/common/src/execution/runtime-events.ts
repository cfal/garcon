import type { ChatMessage } from '@garcon/common/chat-types';
import type {
  AgentExecutionContextV5,
  AgentEstablishedSession,
  AgentProducedRow,
  AgentResumeRequestV5,
  AgentRunFailureDetail,
  AgentRunningSession,
  AgentStartedSession,
  AgentStartRequestV5,
} from '@garcon/server-agent-interface';
import { providerMetadata } from '../native-session/provider-metadata.js';

export type AgentRuntimeExecutionContext = Omit<AgentExecutionContextV5, 'sink'>;
export type AgentRuntimeStartRequest = Omit<AgentStartRequestV5, 'sink'>;
export type AgentRuntimeResumeRequest = Omit<AgentResumeRequestV5, 'sink'>;

// Events carry no routing. The publisher a runtime was handed is the route, so an event can
// only reach the transcript its originating operation was given access to.
export type AgentRuntimeEvent =
  | {
      readonly type: 'messages';
      readonly rows: readonly AgentProducedRow[];
      readonly runId: string | null;
    }
  | {
      readonly type: 'session';
      readonly session: AgentEstablishedSession;
    }
  | {
      readonly type: 'run-ended';
      readonly runId: string;
      readonly outcome: 'finished' | 'failed';
      readonly exitCode?: number;
      readonly error?: AgentRunFailureDetail;
    };

// Captured on the concrete turn, request, or callback object that produces events, never looked
// up per event. A runtime that demultiplexes a process-wide stream keys publishers by the
// provider's own immutable operation identity - a Codex turn id, not a session id, and never
// Garcon's current run - and drops what it cannot correlate rather than guessing.
export type AgentRuntimePublisher = (event: AgentRuntimeEvent) => void;

export interface AgentRuntimeOperation {
  readonly runId: string;
  readonly publish: AgentRuntimePublisher;
}

export function runtimeOperation(
  runId: string,
  publish: AgentRuntimePublisher,
): AgentRuntimeOperation {
  return Object.freeze({ runId, publish });
}

export interface AgentRuntimeExecution {
  start(
    request: AgentRuntimeStartRequest,
    publish: AgentRuntimePublisher,
  ): Promise<AgentStartedSession>;
  resume(request: AgentRuntimeResumeRequest, publish: AgentRuntimePublisher): Promise<void>;
  abort(agentSessionId: string): Promise<boolean>;
  runningSessions(): readonly AgentRunningSession[];
}

export function runtimeRows(messages: readonly ChatMessage[]): readonly AgentProducedRow[] {
  return messages.map((message) => {
    const providerMeta = providerMetadata(message);
    return { message, ...(providerMeta ? { providerMeta } : {}) };
  });
}
