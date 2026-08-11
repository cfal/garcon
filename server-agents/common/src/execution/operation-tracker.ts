import type {
  AgentGoalControlHandoff,
  AgentTurnOwnerOperationIdentityV4,
} from '@garcon/server-agent-interface';
import type { RuntimeEventMetadata } from '../shared/event-emitter-runtime.js';

export class AgentOperationTracker {
  readonly #operations = new Map<string, AgentTurnOwnerOperationIdentityV4>();

  register(chatId: string, operation: AgentTurnOwnerOperationIdentityV4): void {
    this.#operations.set(chatId, operation);
  }

  handoff(
    chatId: string,
    predecessor: AgentTurnOwnerOperationIdentityV4 | null,
    successor: AgentTurnOwnerOperationIdentityV4,
    downstream: AgentGoalControlHandoff,
  ): AgentGoalControlHandoff {
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
  ): AgentTurnOwnerOperationIdentityV4 | null {
    const operation = this.#operations.get(chatId);
    if (!operation) return null;
    if (metadata?.turnId && metadata.turnId !== operation.turnId) return null;
    if (
      metadata?.clientRequestId
      && metadata.clientRequestId !== operation.clientRequestId
    ) return null;
    return operation;
  }

  finish(chatId: string, operation: AgentTurnOwnerOperationIdentityV4): void {
    if (this.#operations.get(chatId) === operation) this.#operations.delete(chatId);
  }
}
