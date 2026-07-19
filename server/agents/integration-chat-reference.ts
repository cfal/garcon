import type {
  AgentChatReference,
  AgentIntegration,
} from '@garcon/server-agent-interface';
import type { AgentChatEntry } from './session-types.js';

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
    chatId,
    agentId: integration.descriptor.id,
    agentSessionId: entry.agentSessionId ?? null,
    projectPath: entry.projectPath,
    model: entry.model ?? '',
    nativeSession: entry.nativeSession ?? null,
    carryOverRevision,
    settings,
  };
}
