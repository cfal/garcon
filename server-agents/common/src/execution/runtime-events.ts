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

export type AgentRuntimeEvent =
  | {
      readonly type: 'messages';
      readonly chatId: string;
      readonly rows: readonly AgentProducedRow[];
      readonly runId: string | null;
    }
  | {
      readonly type: 'session';
      readonly chatId: string;
      readonly session: AgentEstablishedSession;
    }
  | {
      readonly type: 'run-ended';
      readonly chatId: string;
      readonly runId: string;
      readonly outcome: 'finished' | 'failed';
      readonly exitCode?: number;
      readonly error?: AgentRunFailureDetail;
    };

export interface AgentRuntimeExecution {
  start(request: AgentRuntimeStartRequest): Promise<AgentStartedSession>;
  resume(request: AgentRuntimeResumeRequest): Promise<void>;
  abort(agentSessionId: string): Promise<boolean>;
  runningSessions(): readonly AgentRunningSession[];
  subscribeRuntimeEvents(listener: (event: AgentRuntimeEvent) => void): () => void;
}

export class AgentRuntimeEventChannel {
  readonly #listeners = new Set<(event: AgentRuntimeEvent) => void>();

  subscribe(listener: (event: AgentRuntimeEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  emit(event: AgentRuntimeEvent): void {
    for (const listener of this.#listeners) listener(event);
  }
}

export function runtimeRows(messages: readonly ChatMessage[]): readonly AgentProducedRow[] {
  return messages.map((message) => {
    const providerMeta = providerMetadata(message);
    return { message, ...(providerMeta ? { providerMeta } : {}) };
  });
}
