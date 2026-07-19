import type {
  AgentChatReference,
  AgentIntegration,
  AgentNativeSessionRef,
} from '@garcon/server-agent-interface';
import type { AgentChatEntry } from './session-types.js';

export function toAgentChatReference(
  integration: AgentIntegration,
  chatId: string,
  entry: AgentChatEntry,
  carryOverRevision: string,
): AgentChatReference {
  const settings = integration.settings.applyPatch(integration.settings.defaults(), {
    ...(entry.claudeThinkingMode ? { claudeThinkingMode: entry.claudeThinkingMode } : {}),
    ...(entry.ampAgentMode ? { ampAgentMode: entry.ampAgentMode } : {}),
  });
  return {
    chatId,
    agentId: integration.descriptor.id,
    agentSessionId: entry.agentSessionId ?? null,
    projectPath: entry.projectPath,
    model: entry.model ?? '',
    nativeSession: legacyNativeSession(
      integration.descriptor.id,
      entry.nativePath,
      entry.agentSessionId,
    ),
    carryOverRevision,
    settings,
  };
}

export function legacyNativeSession(
  agentId: string,
  nativePath: string | null | undefined,
  agentSessionId: string | null | undefined,
): AgentNativeSessionRef | null {
  if (!nativePath && !agentSessionId) return null;
  return {
    ownerId: agentId,
    schemaVersion: 1,
    value: {
      ...(nativePath ? { path: nativePath } : {}),
      ...(agentSessionId ? { agentSessionId } : {}),
    },
  };
}
