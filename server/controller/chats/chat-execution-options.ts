import {
  requireChatExecutionConfig,
  type RunAgentTurnOptions,
} from '../agents/session-types.js';
import {
  assertAttachmentsSupported,
  type AttachmentAgentCapabilities,
} from '../attachments/support.js';
import type { QueuedAttachmentAdmissionPort } from '../chat-execution/types.js';
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

// Reads the same chat selection queueDrainOptions dispatches with.
export function queuedAttachmentAdmission(
  registry: IChatRegistry,
  agents: AttachmentAgentCapabilities,
): QueuedAttachmentAdmissionPort {
  return {
    assertSupported(chatId, attachments) {
      const chat = registry.getChat(chatId);
      if (!chat) throw new Error(`Session not initialized: ${chatId}`);
      assertAttachmentsSupported(agents, { ...chat, attachments });
    },
  };
}
