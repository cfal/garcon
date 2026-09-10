import type {
  AgentChatReference,
  AgentIntegration,
} from '@garcon/server-agent-interface';
import type { AgentChatEntry } from './session-types.js';
import type { ProviderNativeChatReference } from '../execution-nodes/provider-native-sessions.js';

export function toAgentChatReference(
  integration: AgentIntegration,
  chatId: string,
  entry: AgentChatEntry,
  carryOverRevision: string,
): AgentChatReference {
  const settings = integration.settings.parse(
    entry.agentSettingsById?.[integration.descriptor.id] ?? integration.settings.defaults(),
  );
  if (entry.nativeSession?.ownerId !== integration.descriptor.id && entry.nativeSession !== null && entry.nativeSession !== undefined) {
    throw new Error(`Native session owner mismatch for ${chatId}`);
  }
  return {
    ...toProviderNativeChatReference(chatId, entry, carryOverRevision),
    agentId: integration.descriptor.id,
    settings,
  };
}

export function toProviderNativeChatReference(
  chatId: string,
  entry: AgentChatEntry,
  carryOverRevision: string,
): ProviderNativeChatReference {
  return structuredClone({
    chatId,
    agentId: entry.agentId,
    agentSessionId: entry.agentSessionId ?? null,
    projectPath: entry.projectPath,
    model: entry.model ?? '',
    nativeSession: entry.nativeSession ?? null,
    carryOverRevision,
    nativeSeedReceipt: entry.nativeSeedReceipt ?? null,
    settings: entry.agentSettingsById?.[entry.agentId] ?? null,
  });
}
