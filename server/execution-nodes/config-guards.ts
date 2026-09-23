import { effectiveNodeId } from '../../common/execution-nodes.js';
import type { AgentOwnershipJournal } from '../chats/agent-ownership-journal.js';
import type { IChatRegistry } from '../chats/store.js';
import type { ChatExecutionCoordinator } from '../chat-execution/chat-execution-coordinator.js';
import { DomainError } from '../lib/domain-error.js';

export function executionNodeConfigGuards(deps: {
  chats: Pick<IChatRegistry, 'listAllChats'>;
  execution: Pick<ChatExecutionCoordinator, 'ownsExecution'>;
  ownership: Pick<AgentOwnershipJournal, 'blocksNodeRemoval'>;
}) {
  return {
    assertIdle(nodeId: string): void {
      if (Object.entries(deps.chats.listAllChats()).some(([id, chat]) => effectiveNodeId(chat.nodeId) === nodeId && deps.execution.ownsExecution(id))) {
        throw new DomainError('EXECUTION_NODE_IN_USE', 'Stop or finish this node\'s active work before changing its connection.', 409);
      }
    },
    assertRemovable(nodeId: string): void {
      if (deps.ownership.blocksNodeRemoval(nodeId)) {
        throw new DomainError('EXECUTION_NODE_IN_USE', 'An ownership change or chat deletion is pending on this node. Try deleting it after that operation finishes.', 409, true);
      }
    },
  };
}
