import { effectiveNodeId } from '../../common/execution-nodes.js';
import { GENERATION_UI_SETTING_KEYS } from '../../common/settings.js';
import type { PreambleService } from '../preambles/service.js';
import type { AgentOwnershipJournal } from '../chats/agent-ownership-journal.js';
import type { IChatRegistry } from '../chats/store.js';
import type { ChatExecutionCoordinator } from '../chat-execution/chat-execution-coordinator.js';
import type { ScheduledPromptScheduler } from '../scheduled-prompts/scheduler.js';
import type { SettingsStore } from '../settings/store.js';
import { DomainError } from '../lib/domain-error.js';

export function executionNodeConfigGuards(deps: {
  chats: Pick<IChatRegistry, 'listAllChats'>;
  execution: Pick<ChatExecutionCoordinator, 'ownsExecution'>;
  settings: Pick<SettingsStore, 'getUiSettings'>;
  schedules: Pick<ScheduledPromptScheduler, 'referencesNode'>;
  preambles: Pick<PreambleService, 'snapshot'>;
  ownership: Pick<AgentOwnershipJournal, 'referencesNode'>;
}) {
  return {
    assertIdle(nodeId: string): void {
      if (Object.entries(deps.chats.listAllChats()).some(([id, chat]) => effectiveNodeId(chat.nodeId) === nodeId && deps.execution.ownsExecution(id))) {
        throw new DomainError('EXECUTION_NODE_IN_USE', 'Stop or finish this node\'s active work before changing its connection.', 409);
      }
    },
    assertUnreferenced(nodeId: string): void {
      const ui = deps.settings.getUiSettings();
      const reason = Object.values(deps.chats.listAllChats()).some((chat) => effectiveNodeId(chat.nodeId) === nodeId) ? 'chats'
        : GENERATION_UI_SETTING_KEYS.some((key) => ui[key]?.nodeId === nodeId) ? 'generation settings'
        : deps.schedules.referencesNode(nodeId) ? 'scheduled prompts'
        : deps.preambles.snapshot().preambles.some((preamble) => preamble.scope.type === 'project-paths'
          && preamble.scope.rules.some((rule) => effectiveNodeId(rule.nodeId) === nodeId)) ? 'project preambles'
        : deps.ownership.referencesNode(nodeId) ? 'pending ownership or deletion work'
        : null;
      if (reason) throw new DomainError('EXECUTION_NODE_IN_USE', `This node is referenced by ${reason}. Remove those references before deleting it.`, 409);
    },
  };
}
