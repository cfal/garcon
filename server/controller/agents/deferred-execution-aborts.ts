import { AgentCallError, type AgentExecutionHandle, type AgentIntegration } from '@garcon/server-agent-interface';
import { createLogger } from '../../common/log.js';
import type { AgentDirectory } from './directory.js';

const logger = createLogger('agents:execution-aborts');

export class DeferredExecutionAborts {
  readonly #directory: Pick<AgentDirectory, 'isReady'>;
  readonly #pending = new Map<string, { readonly integration: AgentIntegration; readonly handle: AgentExecutionHandle }>();

  constructor(directory: Pick<AgentDirectory, 'isReady'>) {
    this.#directory = directory;
  }

  request(chatId: string, integration: AgentIntegration, handle: AgentExecutionHandle, context: string): void {
    if (!this.#directory.isReady(handle.executorId)) {
      this.#pending.set(chatId, { integration, handle });
      return;
    }
    const failed = (error: unknown) => {
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
      // The originating facade either reaches the same worker or rejects its stale handle.
      this.request(chatId, deferred.integration, deferred.handle, 'executor reconnect');
    }
  }
}
