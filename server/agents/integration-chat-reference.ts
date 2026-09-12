import type { AgentChatEntry } from './session-types.js';
import type { ProviderNativeChatReference } from '../execution-nodes/provider-native-sessions.js';

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
