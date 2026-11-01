import { AgentCallError, type AgentExecutionHandle, type AgentIntegration } from '@garcon/server-agent-interface';
import { createLogger } from '../../common/log.js';
import type { AgentDirectory } from './directory.js';

const logger = createLogger('agents:execution-aborts');

export class DeferredExecutionAborts {
  readonly #directory: Pick<AgentDirectory, 'isReady' | 'get'>;
  readonly #pending = new Map<string, { readonly integration: AgentIntegration; readonly handle: AgentExecutionHandle }>();

  constructor(directory: Pick<AgentDirectory, 'isReady' | 'get'>) {
    this.#directory = directory;
  }

  request(chatId: string, integration: AgentIntegration, handle: AgentExecutionHandle, context: string): void {
    if (this.#abandonRetired(chatId, integration, context)) return;
    if (!this.#directory.isReady(handle.executorId)) {
      this.#pending.set(chatId, { integration, handle });
      return;
    }
    const failed = (error: unknown) => {
      if (this.#abandonRetired(chatId, integration, context)) return;
      if (error instanceof AgentCallError && error.code === 'STALE_RESOURCE') return;
      if (!this.#directory.isReady(handle.executorId)) {
        this.#pending.set(chatId, { integration, handle });
        return;
      }
      logger.warn(`Provider abort after ${context} failed`, {
        chatId,
        reason: error instanceof Error ? error.message : String(error),
      });
    };
    try {
      void integration.execution.abort(handle).catch(failed);
    } catch (error) {
      failed(error);
    }
  }

  resumed(executorId: string): void {
    for (const [chatId, deferred] of [...this.#pending]) {
      if (deferred.handle.executorId !== executorId) continue;
      this.#pending.delete(chatId);
      this.request(chatId, deferred.integration, deferred.handle, 'executor reconnect');
    }
  }

  lost(executorId: string): void {
    for (const [chatId, deferred] of this.#pending) {
      if (deferred.handle.executorId === executorId) this.#abandonRetired(chatId, deferred.integration, 'executor retirement');
    }
  }

  #abandonRetired(chatId: string, integration: AgentIntegration, context: string): boolean {
    const executorId = integration.producers.scope.executorId;
    if (this.#directory.get(integration.descriptor.id, executorId) === integration) return false;
    if (this.#pending.get(chatId)?.integration === integration) this.#pending.delete(chatId);
    logger.warn('Deferred Stop abandoned after executor retirement; native execution may still be running', { chatId, executorId, context });
    return true;
  }
}
