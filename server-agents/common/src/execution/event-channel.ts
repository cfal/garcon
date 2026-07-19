import type {
  AgentExecution,
  AgentExecutionEvent,
} from '@garcon/server-agent-interface';

export class AgentExecutionEventChannel {
  readonly #listeners = new Set<Parameters<AgentExecution['subscribe']>[0]>();

  subscribe(listener: Parameters<AgentExecution['subscribe']>[0]): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  emit(event: AgentExecutionEvent): void {
    for (const listener of this.#listeners) listener(event);
  }
}
