import type { AgentGoalControlHandoff } from '@garcon/server-agent-interface';
import type { RuntimeEventMetadata } from '../shared/event-emitter-runtime.js';

export class AgentRunTracker {
  readonly #runs = new Map<string, string>();

  register(chatId: string, runId: string): void {
    this.#runs.set(chatId, runId);
  }

  handoff(
    chatId: string,
    predecessor: string | null,
    successor: string,
    downstream: AgentGoalControlHandoff,
  ): AgentGoalControlHandoff {
    const validate = () => {
      if ((this.#runs.get(chatId) ?? null) !== predecessor) {
        throw new Error(`Cannot hand off run for chat ${chatId} after its active run changed`);
      }
    };
    validate();
    return {
      validate: () => {
        validate();
        downstream.validate();
      },
      commit: () => {
        this.#runs.set(chatId, successor);
        downstream.commit();
      },
    };
  }

  current(chatId: string): string | null {
    return this.#runs.get(chatId) ?? null;
  }

  correlate(chatId: string, metadata?: RuntimeEventMetadata): string | null {
    return metadata?.turnId ?? metadata?.clientRequestId ?? this.current(chatId);
  }

  finish(chatId: string, runId: string): void {
    if (this.#runs.get(chatId) === runId) this.#runs.delete(chatId);
  }
}
