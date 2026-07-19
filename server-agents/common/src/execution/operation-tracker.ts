import type { AgentOperationIdentity } from '@garcon/server-agent-interface';
import type { RuntimeEventMetadata } from '../shared/event-emitter-runtime.js';

export class AgentOperationTracker {
  readonly #operations = new Map<string, AgentOperationIdentity>();

  register(chatId: string, operation: AgentOperationIdentity): void {
    this.#operations.set(chatId, operation);
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
