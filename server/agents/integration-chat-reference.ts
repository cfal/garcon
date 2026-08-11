import type {
  AgentChatReferenceV4,
  AgentIntegrationV4,
} from '@garcon/server-agent-interface';
import { agentOwnershipEpoch } from '@garcon/server-agent-interface';
import type { AgentChatEntry } from './session-types.js';

export function toAgentChatReference(
  integration: AgentIntegrationV4,
  chatId: string,
  entry: AgentChatEntry,
  carryOverRevision: string,
): AgentChatReferenceV4 {
  const settings = integration.settings.parse(
    entry.agentSettingsById?.[integration.descriptor.id] ?? integration.settings.defaults(),
  );
  if (entry.nativeSession?.ownerId !== integration.descriptor.id && entry.nativeSession !== null && entry.nativeSession !== undefined) {
    throw new Error(`Native session owner mismatch for ${chatId}`);
  }
  if (!entry.agentOwnershipEpoch) {
    throw new Error(`Agent ownership epoch is missing for ${chatId}`);
  }
  return {
    chatId,
    agentId: integration.descriptor.id,
    agentSessionId: entry.agentSessionId ?? null,
    projectPath: entry.projectPath,
    model: entry.model ?? '',
    nativeSession: entry.nativeSession ?? null,
    carryOverRevision,
    nativeSeedReceipt: entry.nativeSeedReceipt ?? null,
    settings,
    agentOwnershipEpoch: agentOwnershipEpoch(entry.agentOwnershipEpoch),
  };
}
