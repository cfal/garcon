import type { AgentChatReference, AgentIntegration } from '@garcon/server-agent-interface';
import type { ProviderNativeChatReference } from '../execution-nodes/provider-native-sessions.js';

export function assertNativeChatOwner(
  integration: Pick<AgentIntegration, 'descriptor'>,
  chat: Pick<ProviderNativeChatReference, 'agentId' | 'nativeSession'>,
): void {
  const agentId = integration.descriptor.id;
  if (chat.agentId !== agentId || (chat.nativeSession !== null && chat.nativeSession.ownerId !== agentId)) {
    throw new Error('Native session owner mismatch');
  }
}

export function parseNativeChatReference(
  integration: Pick<AgentIntegration, 'settings'>,
  input: ProviderNativeChatReference,
): AgentChatReference {
  const chat = structuredClone(input);
  const settings = integration.settings.parse(structuredClone(chat.settings ?? integration.settings.defaults()));
  return { ...chat, settings: structuredClone(settings) };
}
