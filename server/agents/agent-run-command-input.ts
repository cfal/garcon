import type {
  AgentHandoffRequest,
  AgentRunCommandRequest,
  ForkRunCommandRequest,
} from '../../common/chat-command-contracts.js';
import type { RunAgentTurnOptions } from './session-types.js';

export interface NormalizedAgentRunCommandInput {
  readonly chatId: string;
  readonly command: string;
  readonly images?: RunAgentTurnOptions['images'];
  readonly options: RunAgentTurnOptions;
  readonly expectedAgentId?: string;
  readonly tagsToAdd?: string[];
  readonly permissionFallbackPolicy?: 'require-explicit-bypass';
  readonly handoff?: AgentHandoffRequest;
}

export function runOptionsForCommand(
  input: AgentRunCommandRequest | ForkRunCommandRequest,
): RunAgentTurnOptions {
  return {
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.permissionMode === undefined ? {} : { permissionMode: input.permissionMode }),
    ...(input.thinkingMode === undefined ? {} : { thinkingMode: input.thinkingMode }),
    ...(input.agentSettings === undefined ? {} : { agentSettings: input.agentSettings }),
    ...(input.apiProviderId === undefined ? {} : { apiProviderId: input.apiProviderId }),
    ...(input.modelEndpointId === undefined ? {} : { modelEndpointId: input.modelEndpointId }),
    ...(input.modelProtocol === undefined ? {} : { modelProtocol: input.modelProtocol }),
  };
}

export function agentRunCommandPayload(
  input: NormalizedAgentRunCommandInput,
  clientMessageId: string,
): Record<string, unknown> {
  const options = input.handoff ? undefined : input.options;
  return {
    chatId: input.chatId,
    clientMessageId,
    command: input.command,
    images: input.images,
    permissionMode: options?.permissionMode,
    thinkingMode: options?.thinkingMode,
    agentSettings: options?.agentSettings,
    model: options?.model,
    apiProviderId: options?.apiProviderId,
    modelEndpointId: options?.modelEndpointId,
    modelProtocol: options?.modelProtocol,
    expectedAgentId: input.expectedAgentId,
    tagsToAdd: input.tagsToAdd,
    permissionFallbackPolicy: input.permissionFallbackPolicy,
    handoff: input.handoff,
  };
}
