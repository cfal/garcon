import type {
  AgentActiveInputHandoff,
  AgentOperationIdentity,
} from '@garcon/server-agent-interface';
import type { RuntimeEventMetadata } from '../shared/event-emitter-runtime.js';

export class AgentOperationTracker {
  readonly #operations = new Map<string, AgentOperationIdentity>();

  register(chatId: string, operation: AgentOperationIdentity): void {
    this.#operations.set(chatId, operation);
  }

  handoff(
    chatId: string,
    predecessor: AgentOperationIdentity | null,
    successor: AgentOperationIdentity,
    downstream: AgentActiveInputHandoff,
  ): AgentActiveInputHandoff {
    const validate = () => {
      if ((this.#operations.get(chatId) ?? null) !== predecessor) {
        throw new Error(`Cannot hand off operation for chat ${chatId} after its active operation changed`);
      }
    };
    validate();
    return {
      validate: () => {
        validate();
        downstream.validate();
      },
      commit: () => {
        this.#operations.set(chatId, successor);
        downstream.commit();
      },
    };
  }

  current(
    chatId: string,
    metadata?: RuntimeEventMetadata,
  ): AgentOperationIdentity | null {
    const operation = this.#operations.get(chatId);
    if (!operation) return null;
    if (metadata?.turnId && metadata.turnId !== operation.turnId) return null;
    if (
      metadata?.clientRequestId
      && metadata.clientRequestId !== operation.clientRequestId
    ) return null;
    return operation;
  }

  finish(chatId: string, operation: AgentOperationIdentity): void {
    if (this.#operations.get(chatId) === operation) this.#operations.delete(chatId);
  }
}
