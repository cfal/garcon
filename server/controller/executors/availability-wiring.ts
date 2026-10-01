import { effectiveExecutorId } from '../../../common/executors.js';
import { createLogger } from '../../common/log.js';
import type { AgentRegistry } from '../agents/registry.js';
import type { ChatExecutionCoordinator } from '../chat-execution/chat-execution-coordinator.js';
import { hasPendingTurnInput } from '../chat-execution/control-state.js';
import type { AgentOwnershipJournal } from '../chats/agent-ownership-journal.js';
import type { ChatRegistry } from '../chats/store.js';
import type { ExecutorManager } from './manager.js';

const logger = createLogger('server-events');

export function wireExecutorAvailability({
  executors, agentRegistry, chatRegistry, ownershipJournal, queue, publishProcessing,
}: {
  executors: Pick<ExecutorManager, 'onAvailabilityChanged' | 'list'>;
  agentRegistry: Pick<AgentRegistry, 'executionSessionLost' | 'executionSessionResumed'>;
  chatRegistry: Pick<ChatRegistry, 'listChatIds' | 'getChat'>;
  ownershipJournal: Pick<AgentOwnershipJournal, 'retryProviderCleanup'>;
  queue: Pick<ChatExecutionCoordinator, 'readChatExecutionControl' | 'retryQueuedSteers' | 'triggerDrain'>;
  publishProcessing(executorId: string): void;
}): () => void {
  const retryProviderCleanup = (executorId: string) => {
    void ownershipJournal.retryProviderCleanup(executorId).catch((error) => {
      logger.warn('Executor native cleanup failed', { executorId, error });
    });
  };
  const executorReady = (executorId: string) => {
    retryProviderCleanup(executorId);
    for (const chatId of chatRegistry.listChatIds()) {
      if (effectiveExecutorId(chatRegistry.getChat(chatId)?.executorId) !== executorId) continue;
      void queue.readChatExecutionControl(chatId).then(async (control) => {
        const chat = chatRegistry.getChat(chatId);
        if (chat && effectiveExecutorId(chat.executorId) === executorId && hasPendingTurnInput(control)) {
          // A run's one steerable report may have arrived while its steer target was unreachable.
          queue.retryQueuedSteers(chatId);
          await queue.triggerDrain(chatId);
        }
      }).catch((error) => logger.warn('Executor queue drain failed', error));
    }
  };
  const unsubscribe = executors.onAvailabilityChanged((executorId, availability) => {
    if (availability === 'reconnecting' || availability === 'ready') publishProcessing(executorId);
    if (availability === 'offline') agentRegistry.executionSessionLost(executorId);
    if (availability === 'ready') {
      logger.info('Executor ready', { executorId });
      agentRegistry.executionSessionResumed(executorId);
      executorReady(executorId);
    }
  });
  for (const executor of executors.list()) {
    if (executor.availability === 'ready') retryProviderCleanup(executor.id);
  }
  return unsubscribe;
}
