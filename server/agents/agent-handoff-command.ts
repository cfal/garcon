import type {
  AgentHandoffRequest,
  AgentTurnCommandResponse,
} from '../../common/chat-command-contracts.js';
import type { ChatListEntry } from '../../common/chat-list.js';
import type { ChatExecutionCommands } from '../chat-execution/chat-execution-coordinator.js';
import type { ChatRegistryEntry } from '../chats/store.js';
import { CommandExecutionControlError } from '../lib/command-execution-control-error.js';
import {
  type AgentHandoffPreparation,
  type AgentHandoffService,
  resolvedRunOptions,
} from './agent-handoff-service.js';
import type { RunAgentTurnOptions } from './session-types.js';

export type AgentHandoffReplayDisposition =
  | 'continue'
  | 'retry'
  | 'rethrow-failure'
  | 'return-duplicate';

export function agentHandoffReplayDisposition(input: {
  readonly handoff?: AgentHandoffRequest;
  readonly currentOwnershipEpoch?: string;
  readonly recordStatus: string;
  readonly isUnpublishedPreScheduleFailure: boolean;
}): AgentHandoffReplayDisposition {
  if (input.isUnpublishedPreScheduleFailure) {
    return input.handoff
      && input.currentOwnershipEpoch !== input.handoff.expectedAgentOwnershipEpoch
      ? 'rethrow-failure'
      : 'retry';
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
  readonly source: ChatRegistryEntry;
  readonly permissionFallbackPolicy?: 'require-explicit-bypass';
  readonly service: Pick<AgentHandoffService, 'resolveTarget' | 'createPreparation'>;
  readonly execution: Pick<
    ChatExecutionCommands,
    'ownsExecution' | 'readChatExecutionControl'
  >;
}): Promise<{
  readonly options: RunAgentTurnOptions;
  readonly preparation: AgentHandoffPreparation;
}> {
  const target = await input.service.resolveTarget({
    chat: input.source,
    handoff: input.handoff,
    permissionFallbackPolicy: input.permissionFallbackPolicy,
  });
  const control = await input.execution.readChatExecutionControl(input.chatId);
  if (
    input.execution.ownsExecution(input.chatId)
    || control.entries.length > 0
    || control.pause !== null
  ) {
    throw new CommandExecutionControlError(
      'AGENT_HANDOFF_REQUIRES_IDLE',
      'Agent handoff requires an idle chat with an empty, unpaused queue.',
      409,
      true,
      control,
    );
  }
  return {
    options: resolvedRunOptions(target),
    preparation: input.service.createPreparation({
      chatId: input.chatId,
      clientRequestId: input.clientRequestId,
      handoff: input.handoff,
      source: input.source,
      target,
    }),
  };
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
