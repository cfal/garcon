import type {
  AgentHandoffRequest,
  AgentTurnCommandResponse,
} from '../../../common/chat-command-contracts.js';
import type { ChatListEntry } from '../../../common/chat-list.js';
import type { ChatExecutionCommands } from '../chat-execution/chat-execution-coordinator.js';
import { hasPendingTurnInput } from '../chat-execution/control-state.js';
import type { StoredChatExecutionControlState } from '../chat-execution/control-state.js';
import type { ChatRegistryEntry } from '../chats/registry-contracts.js';
import { CommandExecutionControlError } from '../lib/command-execution-control-error.js';
import type { ResolvedAgentHandoffTarget } from './agent-handoff-types.js';
import {
  type AgentHandoffPreparation,
  type AgentHandoffService,
  resolvedRunOptions,
} from './agent-handoff-service.js';
import type { RunAgentTurnOptions } from './session-types.js';

export type AgentHandoffReplayDisposition =
  | 'continue'
  | 'retry'
  | 'return-duplicate';

export function agentHandoffReplayDisposition(input: {
  readonly handoff?: AgentHandoffRequest;
  readonly currentAgentId?: string;
  readonly currentOwnershipEpoch?: string;
  readonly recordStatus: string;
  readonly isUnpublishedPreScheduleFailure: boolean;
}): AgentHandoffReplayDisposition {
  if (input.isUnpublishedPreScheduleFailure) {
    if (
      input.handoff
      && input.currentAgentId === input.handoff.target.agentId
      && input.currentOwnershipEpoch !== undefined
      && input.currentOwnershipEpoch !== input.handoff.expectedAgentOwnershipEpoch
    ) {
      return 'continue';
    }
    return 'retry';
  }
  if (!input.handoff || input.recordStatus !== 'accepted') return 'continue';
  return input.currentOwnershipEpoch === input.handoff.expectedAgentOwnershipEpoch
    ? 'retry'
    : 'return-duplicate';
}

export async function prepareAgentHandoffCommand(input: {
  readonly chatId: string;
  readonly clientRequestId: string;
  readonly handoff: AgentHandoffRequest;
  readonly command: string | null;
  readonly source: ChatRegistryEntry;
  readonly permissionFallbackPolicy?: 'require-explicit-bypass';
  readonly service: Pick<AgentHandoffService, 'resolveTarget' | 'createPreparation'>;
  readonly execution: Pick<
    ChatExecutionCommands,
    'ownsExecution' | 'readChatExecutionControl'
  >;
  // The interactive deadline of the run holding the chat's lock.
  readonly deadline: number;
}): Promise<{
  readonly target: ResolvedAgentHandoffTarget;
  readonly options: RunAgentTurnOptions;
  readonly preparation: AgentHandoffPreparation;
}> {
  const target = await input.service.resolveTarget({
    chat: input.source,
    handoff: input.handoff,
    permissionFallbackPolicy: input.permissionFallbackPolicy,
    deadline: input.deadline,
  });
  const control = await input.execution.readChatExecutionControl(input.chatId);
  assertAgentHandoffIdle(control, input.execution.ownsExecution(input.chatId));
  return {
    target,
    options: resolvedRunOptions(target),
    preparation: input.service.createPreparation({
      chatId: input.chatId,
      clientRequestId: input.clientRequestId,
      handoff: input.handoff,
      source: input.source,
      target,
      command: input.command,
    }),
  };
}

export function assertAgentHandoffIdle(control: StoredChatExecutionControlState, ownsExecution: boolean): void {
  if (!ownsExecution && !hasPendingTurnInput(control) && control.pause === null) return;
  throw new CommandExecutionControlError(
    'AGENT_HANDOFF_REQUIRES_IDLE',
    'Agent handoff requires an idle chat with an empty, unpaused queue.',
    409,
    true,
    control,
  );
}

export async function withHandoffChatProjection(
  result: AgentTurnCommandResponse,
  includeChat: boolean,
  projectChat: (chatId: string) => Promise<ChatListEntry>,
): Promise<AgentTurnCommandResponse> {
  return includeChat
    ? { ...result, chat: await projectChat(result.chatId) }
    : result;
}
