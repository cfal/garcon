import { effectiveExecutorId } from '../../../common/executors.js';
import type { AgentOwnershipJournal } from '../chats/agent-ownership-journal.js';
import type { IChatRegistry } from '../chats/store.js';
import type { ChatExecutionCoordinator } from '../chat-execution/chat-execution-coordinator.js';
import { DomainError } from '../../common/domain-error.js';

export function executorConfigGuards(deps: {
  chats: Pick<IChatRegistry, 'listAllChats'>;
  execution: Pick<ChatExecutionCoordinator, 'ownsExecution'>;
  ownership: Pick<AgentOwnershipJournal, 'blocksExecutorRemoval'>;
}) {
  return {
    assertIdle(executorId: string): void {
      if (Object.entries(deps.chats.listAllChats()).some(([id, chat]) => effectiveExecutorId(chat.executorId) === executorId && deps.execution.ownsExecution(id))) {
        throw new DomainError('EXECUTOR_IN_USE', 'Stop or finish this executor\'s active work before changing its connection.', 409);
      }
    },
    assertRemovable(executorId: string): void {
      if (deps.ownership.blocksExecutorRemoval(executorId)) {
        throw new DomainError('EXECUTOR_IN_USE', 'An ownership change or chat deletion is pending on this executor. Try deleting it after that operation finishes.', 409, true);
      }
    },
  };
}
