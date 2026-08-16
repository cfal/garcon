import type { ChatMessage } from '@garcon/common/chat-types';
import type {
  AgentExecutionContextV5,
  AgentProducerEvent,
  AgentProducedRow,
  AgentResumeRequestV5,
  AgentRunningSession,
  AgentStartedSession,
  AgentStartRequestV5,
} from '@garcon/server-agent-interface';
import { providerMetadata } from '../native-session/provider-metadata.js';

export type AgentRuntimeExecutionContext = Omit<AgentExecutionContextV5, 'sink'>;
export type AgentRuntimeStartRequest = Omit<AgentStartRequestV5, 'sink'>;
export type AgentRuntimeResumeRequest = Omit<AgentResumeRequestV5, 'sink'>;

type ProviderRunEndedEvent = Omit<
  Extract<AgentProducerEvent, { readonly type: 'run-ended' }>,
  'outcome'
> & { readonly outcome: 'finished' | 'failed' };

// Runtime publication is the provider event contract itself. The publisher a runtime was handed
// is the route, so events carry no chat identity and require no adapter-specific dialect.
export type AgentRuntimeEvent =
  | Exclude<AgentProducerEvent, { readonly type: 'run-ended' }>
  | ProviderRunEndedEvent;

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
