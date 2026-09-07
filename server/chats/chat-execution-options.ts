import {
  requireChatExecutionConfig,
  type RunAgentTurnOptions,
} from '../agents/session-types.js';
import type { IChatRegistry } from './store.js';

export function queueDrainOptions(
  chatId: string,
  registry: IChatRegistry,
): RunAgentTurnOptions {
  const chat = registry.getChat(chatId);
  const entry = requireChatExecutionConfig(chatId, chat);
  return {
    permissionMode: entry.permissionMode,
    thinkingMode: entry.thinkingMode,
    agentSettings: chat ? entry.agentSettingsById[chat.agentId] : undefined,
    model: entry.model,
    apiProviderId: chat?.apiProviderId,
    modelEndpointId: chat?.modelEndpointId,
    modelProtocol: chat?.modelProtocol,
  };
}
