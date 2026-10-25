import type { AgentExecutionHandle } from '@garcon/server-agent-interface';
import { createLogger } from '../../common/log.js';
import type { AgentDirectory } from './directory.js';

const logger = createLogger('agents:execution-aborts');

export class ExecutionAborts {
  // A disconnected worker may still run the turn; only its executor can abort it.
  readonly #deferred = new Map<string, { readonly agentId: string; readonly handle: AgentExecutionHandle }>();

  constructor(private readonly directory: AgentDirectory) {}

  sessionResumed(executorId: string): void {
    for (const [chatId, deferred] of this.#deferred) {
      if (deferred.handle.executorId !== executorId) continue;
      this.#deferred.delete(chatId);
      this.request(chatId, deferred.agentId, deferred.handle, 'executor reconnect');
    }
  }

  request(chatId: string, agentId: string, handle: AgentExecutionHandle, context: string): void {
    const failed = (error: unknown) => {
      if (!this.directory.isReady(handle.executorId)) {
        this.#deferred.set(chatId, { agentId, handle });
        return;
      }
      logger.warn(`Provider abort after ${context} failed`, {
        chatId,
        reason: error instanceof Error ? error.message : String(error),
      });
    };
    try {
      void this.directory.require(agentId, handle.executorId).execution.abort(handle).catch(failed);
    } catch (error) {
      failed(error);
    }
  }
}
